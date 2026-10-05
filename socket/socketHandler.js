/**
 * socketHandler.js — Multi-tenant, role-based internal chat
 *
 * Roles & permissions:
 *  super_admin  → can chat with ALL admins in their company + ALL employees in their company
 *  admin        → can chat with their company's super_admin + only their own assigned employees
 *  employee     → can only chat with their assigned admin (the one who created them)
 *
 * Company isolation: every room, user list, and message is scoped by companyId.
 *
 * Socket identity map:
 *  onlineUsers[socketId] = {
 *    username,       // unique key used in Message.from / Message.to
 *    displayName,    // human-readable
 *    role,           // 'employee' | 'admin' | 'super_admin'
 *    company,        // ObjectId string
 *    adminId,        // for employees: their admin's _id string; for admins: their own _id
 *    userId,         // MongoDB _id of the Admin/User document
 *  }
 *
 * Username conventions:
 *  employee  → their User.name  (must be unique within a company – use _id if ambiguous)
 *  admin     → 'admin:<Admin._id>'
 *  superadmin→ 'superadmin:<Admin._id>'
 */

const mongoose = require('mongoose');
const Message  = require('../models/Message');
const ChatUser = require('../models/ChatUser');
const Admin    = require('../models/Admin');
const User     = require('../models/Users');
const Lead     = require('../models/Leads');
const { socketAuthMiddleware } = require('../utils/socketAuth');

// ── Push pending follow-up alerts to a freshly connected admin ───────────────
// Called on admin_join so the bell is pre-populated without waiting for the
// 9 AM cron tick.
//
// SCOPING: admin only receives alerts for leads where assignedAdmin === adminId.
// super_admin does NOT receive on-connect follow-up alerts — they are not the
// target audience for per-lead action reminders.
async function pushPendingFollowUps(socket, adminId, company, role) {
  // super_admin: no on-connect follow-up alerts — skip entirely
  if (role === 'super_admin') return;

  try {
    const now        = new Date();
    const todayEnd   = new Date(now); todayEnd.setHours(23, 59, 59, 999);
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);

    // Always scope to this admin's assigned leads only
    const query = {
      isClosed:      { $ne: true },
      status:        { $nin: require('../services/customizationService').statusKeysByCategory(require('../services/customizationService').peekCustomization(company), 'won') },
      company,
      assignedAdmin: adminId,
      scheduledCalls: { $elemMatch: { done: false, scheduledAt: { $lte: todayEnd } } },
    };

    const leads = await Lead.find(query)
      .select('_id name scheduledCalls')
      .lean();

    if (!leads.length) return;

    const overdueLeads  = [];
    const dueTodayLeads = [];

    for (const lead of leads) {
      const pending = lead.scheduledCalls
        .filter(sc => !sc.done)
        .map(sc => new Date(sc.scheduledAt))
        .sort((a, b) => a - b);
      if (!pending.length) continue;
      if (pending[0] < todayStart) overdueLeads.push({ leadId: String(lead._id), leadName: lead.name });
      else                          dueTodayLeads.push({ leadId: String(lead._id), leadName: lead.name });
    }

    const timestamp = now.toISOString();

    if (overdueLeads.length) {
      socket.emit('follow_up_alert', {
        type: 'overdue',
        count: overdueLeads.length,
        leads: overdueLeads,
        timestamp,
      });
    }
    if (dueTodayLeads.length) {
      socket.emit('follow_up_alert', {
        type: 'due',
        count: dueTodayLeads.length,
        leads: dueTodayLeads,
        timestamp,
      });
    }
  } catch (err) {
    console.error('[Socket] pushPendingFollowUps error:', err.message);
  }
}

// socketId → identity object
const onlineUsers = {};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Deterministic thread key so both sides of a convo get the same key */
function threadKey(companyId, a, b) {
  return `${companyId}:${[a, b].sort().join(':')}`;
}

/** Build the online-users map visible to a specific role/company */
function buildOnlineMap(companyId, viewerRole, viewerAdminId) {
  const map = {};
  for (const [sid, info] of Object.entries(onlineUsers)) {
    if (String(info.company) !== String(companyId)) continue;
    if (viewerRole === 'super_admin') {
      // super_admin sees everyone in their company
      map[sid] = info.username;
    } else if (viewerRole === 'admin') {
      // admin sees: the super_admin + their own employees
      if (info.role === 'super_admin') {
        map[sid] = info.username;
      } else if (info.role === 'employee' && String(info.adminId) === String(viewerAdminId)) {
        map[sid] = info.username;
      }
    }
    // employees don't get an online map
  }
  return map;
}

/** Emit a fresh online map to every admin/superadmin in a company */
function broadcastOnlineMap(io, companyId) {
  for (const [sid, info] of Object.entries(onlineUsers)) {
    if (String(info.company) !== String(companyId)) continue;
    if (info.role === 'employee') continue;
    const map = buildOnlineMap(companyId, info.role, info.adminId);
    io.to(sid).emit('users_list', map);
  }
}

/** Fetch message history for a thread and format for the client */
async function fetchHistory(companyId, usernameA, usernameB) {
  const key = threadKey(companyId, usernameA, usernameB);
  return Message.find({ company: companyId, threadKey: key })
    .sort({ timestamp: 1 })
    .lean();
}

// ── Main ─────────────────────────────────────────────────────────────────────

const initSocket = (io) => {
  // SECURITY: verify the JWT once per connection → socket.data.auth.
  // Every handler below uses that verified identity; ids in payloads are ignored.
  io.use(socketAuthMiddleware);

  io.on('connection', (socket) => {
    const me = () => socket.data && socket.data.auth;
    const isAdminKind = (a) => !!a && a.kind === 'admin' && !!a.company;

    // ── Attendance room ──────────────────────────────────────────────────────
    // Employees: their own room only. Admins: a user of their own company.
    socket.on('att_join', async (payload = {}) => {
      const a = me();
      if (!a) return;
      if (a.kind === 'employee') { socket.join(`att:${a.id}`); return; }
      const userId = payload && payload.userId;
      if (isAdminKind(a) && userId && mongoose.Types.ObjectId.isValid(String(userId))) {
        const ok = await User.exists({ _id: userId, company: a.company }).catch(() => null);
        if (ok) socket.join(`att:${userId}`);
      }
    });

    // ── WhatsApp rooms ───────────────────────────────────────────────────────
    // Admin firehose is now PER COMPANY (was one global room for all tenants).
    socket.on('wa_admin_join', () => {
      const a = me();
      if (isAdminKind(a)) socket.join(`wa_admin_${a.company}`);
    });
    socket.on('wa_agent_join', () => {
      const a = me();
      if (a && a.id) socket.join(`wa_agent_${a.id}`);
    });

    // ── Agent personal room — for new_lead_assigned push ─────────────────────
    socket.on('agent_join', () => {
      const a = me();
      if (a && a.id) socket.join(`agent:${a.id}`);
    });

    // Company-wide WhatsApp room — own company only.
    socket.on('wa_company_join', () => {
      const a = me();
      if (a && a.company) socket.join(`wa_company_${a.company}`);
    });

    // Company admin room (used by Campaigns page for new_website_lead).
    socket.on('company_admin_join', () => {
      const a = me();
      if (isAdminKind(a)) socket.join(`company_admin:${a.company}`);
    });

    // ════════════════════════════════════════════════════════════════════════
    // EMPLOYEE joins — identity comes from the token
    // ════════════════════════════════════════════════════════════════════════
    socket.on('user_join', async (payload) => {
      const a = me();
      if (!a || a.kind !== 'employee' || !a.company) return;
      if (typeof payload === 'string') payload = { username: payload };
      payload = payload || {};

      const username = a.name || payload.username;
      if (!username) return;
      const company = a.company;
      const adminId = a.adminId;

      const identity = {
        username,
        displayName: payload.displayName || username,
        role: 'employee',
        company,
        adminId: adminId || null,
        userId:  a.id,
      };
      onlineUsers[socket.id] = identity;

      try {
        await ChatUser.findOneAndUpdate(
          { username },
          { lastSeen: new Date(), company, role: 'employee', adminId, userId: a.id, displayName: identity.displayName },
          { upsert: true, new: true }
        );

        if (adminId) {
          const adminUsername = await resolveAdminUsername(adminId, company);
          if (adminUsername) {
            const history = await fetchHistory(company, username, adminUsername);
            socket.emit('chat_history', history);
          }
        }
      } catch (err) {
        console.error('[Socket] user_join error:', err.message);
      }

      broadcastOnlineMap(io, company);
    });

    // ════════════════════════════════════════════════════════════════════════
    // ADMIN joins — identity comes from the token
    // ════════════════════════════════════════════════════════════════════════
    socket.on('admin_join', async (payload = {}) => {
      const a = me();
      if (!isAdminKind(a)) return;
      const adminId = a.id;
      const company = a.company;

      const username = `admin:${adminId}`;
      const identity = {
        username,
        displayName: (payload && payload.displayName) || a.name || 'Admin',
        role: 'admin',
        company,
        adminId,
        userId: adminId,
      };
      onlineUsers[socket.id] = identity;

      socket.join(`admin_room:${adminId}`);
      socket.join(`admin:${adminId}`);
      socket.join(`company_admin:${company}`);

      try {
        await ChatUser.findOneAndUpdate(
          { username },
          { lastSeen: new Date(), company, role: 'admin', adminId, userId: adminId, displayName: identity.displayName },
          { upsert: true, new: true }
        );
        const contactList = await buildContactList('admin', adminId, company);
        socket.emit('all_users_db', contactList);
      } catch (err) {
        console.error('[Socket] admin_join error:', err.message);
      }

      broadcastOnlineMap(io, company);

      if (!socket._adminJoinHandled) {
        socket._adminJoinHandled = true;
        pushPendingFollowUps(socket, adminId, company, 'admin');
      }
    });

    // ════════════════════════════════════════════════════════════════════════
    // SUPER_ADMIN joins — only a real super_admin token is accepted
    // ════════════════════════════════════════════════════════════════════════
    socket.on('super_admin_join', async (payload = {}) => {
      const a = me();
      let adminId, company;
      if (a && a.kind === 'admin' && a.role === 'super_admin' && a.company) {
        adminId = a.id; company = a.company;
      } else if (a && a.kind === 'platform' && a.role === 'super_admin' && payload && payload.company) {
        // Legacy platform-level super admin (no company of its own).
        adminId = a.id; company = String(payload.company);
      } else {
        console.warn('[Socket] super_admin_join rejected — token is not a super_admin with a company.');
        return;
      }

      const username = `superadmin:${adminId}`;
      const identity = {
        username,
        displayName: (payload && payload.displayName) || a.name || 'Super Admin',
        role: 'super_admin',
        company,
        adminId,
        userId: adminId,
      };
      onlineUsers[socket.id] = identity;

      socket.join(`admin_room:${adminId}`);
      socket.join(`superadmin:${adminId}`);
      socket.join(`company_admin:${company}`);

      try {
        await ChatUser.findOneAndUpdate(
          { username },
          { lastSeen: new Date(), company, role: 'super_admin', adminId, userId: adminId, displayName: identity.displayName },
          { upsert: true, new: true }
        );
        const contactList = await buildContactList('super_admin', adminId, company);
        socket.emit('all_users_db', contactList);
      } catch (err) {
        console.error('[Socket] super_admin_join error:', err.message);
      }

      socket.emit('users_list', buildOnlineMap(company, 'super_admin', adminId));
      broadcastOnlineMap(io, company);
      socket._adminJoinHandled = true;
    });

    // ════════════════════════════════════════════════════════════════════════
    // EMPLOYEE → sends message to their admin
    // ════════════════════════════════════════════════════════════════════════
    socket.on('user_message', async (payload = {}) => {
      const identity = onlineUsers[socket.id];
      if (!identity || identity.role !== 'employee') return;
      const message = typeof payload.message === 'string' ? payload.message : '';
      if (!message.trim()) return;

      const { username, company, adminId } = identity;
      if (!company || !adminId) {
        socket.emit('chat_error', { message: 'No admin is assigned to you yet.' });
        return;
      }

      try {
        const adminUsername = await resolveAdminUsername(adminId, company);
        if (!adminUsername) return;

        const key  = threadKey(company, username, adminUsername);
        const saved = await Message.create({ from: username, to: adminUsername, message, company, adminId, threadKey: key });

        io.to(`admin_room:${adminId}`).emit('receive_user_message', {
          from: username,
          displayName: identity.displayName,
          socketId: socket.id,
          message,
          _id: saved._id,
        });
        notifySuperAdmin(io, company, 'receive_user_message', {
          from: username,
          displayName: identity.displayName,
          message,
          _id: saved._id,
        });
        socket.emit('message_saved', { _id: saved._id, message, from: username });
      } catch (err) {
        console.error('[Socket] user_message error:', err.message);
      }
    });

    // ════════════════════════════════════════════════════════════════════════
    // ADMIN / SUPER_ADMIN → sends message to a contact in THEIR company
    // ════════════════════════════════════════════════════════════════════════
    socket.on('admin_message', async (payload = {}) => {
      const sender = onlineUsers[socket.id];
      if (!sender || (sender.role !== 'admin' && sender.role !== 'super_admin')) return;
      const { toSocketId, toUsername } = payload;
      const message = typeof payload.message === 'string' ? payload.message : '';
      if (!toUsername || !message.trim()) return;

      const { username: fromUsername, company, adminId, role } = sender;

      try {
        const allowed = await canSendTo(role, adminId, company, String(toUsername));
        if (!allowed) {
          socket.emit('chat_error', { message: 'You are not allowed to message this contact.' });
          return;
        }

        const key   = threadKey(company, fromUsername, toUsername);
        const saved = await Message.create({
          from: fromUsername, to: toUsername, message,
          company, adminId: resolveAdminIdForThread(role, adminId, toUsername),
          threadKey: key,
        });

        socket.emit('admin_message_sent', { toUsername, message, _id: saved._id });

        // Deliver only to a socket that really is that user in THIS company.
        const target = toSocketId && onlineUsers[toSocketId];
        const targetSid = (target && target.username === toUsername && String(target.company) === String(company))
          ? toSocketId
          : findSocketId(toUsername, company);
        if (targetSid) {
          io.to(targetSid).emit('receive_admin_message', { message, _id: saved._id, from: fromUsername, displayName: sender.displayName });
        }
      } catch (err) {
        console.error('[Socket] admin_message error:', err.message);
      }
    });

    // ════════════════════════════════════════════════════════════════════════
    // Fetch history for a specific thread (admin/superadmin side)
    // ════════════════════════════════════════════════════════════════════════
    socket.on('admin_fetch_history', async (payload = {}) => {
      const viewer = onlineUsers[socket.id];
      const otherUsername = payload && payload.username;
      if (!viewer || !otherUsername) {
        socket.emit('admin_chat_history', { username: otherUsername, history: [] });
        return;
      }
      try {
        const history = await fetchHistory(viewer.company, viewer.username, String(otherUsername));
        socket.emit('admin_chat_history', { username: otherUsername, history });
      } catch (err) {
        console.error('[Socket] admin_fetch_history error:', err.message);
      }
    });

    // ════════════════════════════════════════════════════════════════════════
    // Edit / delete message — sender, or an admin of that thread, same company
    // ════════════════════════════════════════════════════════════════════════
    socket.on('edit_message', async (payload = {}) => {
      try {
        const { _id, newText } = payload;
        if (!_id || !mongoose.Types.ObjectId.isValid(String(_id))) return;
        if (typeof newText !== 'string' || !newText.trim()) return;
        const sender = onlineUsers[socket.id];
        const msg = await Message.findById(_id);
        if (!msg || msg.isDeleted || !canModifyMessage(sender, msg)) return;

        msg.message  = newText.trim();
        msg.editedAt = new Date();
        await msg.save();

        broadcastToThread(io, msg, { _id: msg._id.toString(), newText: msg.message, editedAt: msg.editedAt }, 'message_edited');
      } catch (err) {
        console.error('edit_message error', err);
      }
    });

    socket.on('delete_message', async (payload = {}) => {
      try {
        const { _id } = payload;
        if (!_id || !mongoose.Types.ObjectId.isValid(String(_id))) return;
        const sender = onlineUsers[socket.id];
        const msg = await Message.findById(_id);
        if (!msg || !canModifyMessage(sender, msg)) return;

        msg.isDeleted = true;
        msg.message   = 'This message was deleted';
        await msg.save();

        broadcastToThread(io, msg, { _id: msg._id.toString() }, 'message_deleted');
      } catch (err) {
        console.error('delete_message error', err);
      }
    });

    // ── Disconnect ───────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      const identity = onlineUsers[socket.id];
      delete onlineUsers[socket.id];
      if (identity?.company) broadcastOnlineMap(io, identity.company);
    });

  }); // end io.on connection
};

// ── Utility functions ─────────────────────────────────────────────────────────

/** Look up admin username string from their _id (must belong to `company` when given) */
async function resolveAdminUsername(adminId, company) {
  if (!adminId || !mongoose.Types.ObjectId.isValid(String(adminId))) return null;
  const admin = await Admin.findById(adminId).select('role company').lean();
  if (!admin) return null;
  if (company && String(admin.company) !== String(company)) return null;
  const prefix = admin.role === 'super_admin' ? 'superadmin' : 'admin';
  return `${prefix}:${adminId}`;
}

/** Find a socket id for a given username inside one company */
function findSocketId(username, company) {
  return Object.entries(onlineUsers).find(([, info]) =>
    info.username === username && (company == null || String(info.company) === String(company))
  )?.[0] ?? null;
}

/** Sender (or an admin of that thread) in the SAME company may edit/delete. */
function canModifyMessage(sender, msg) {
  if (!sender || !msg) return false;
  if (!msg.company || String(msg.company) !== String(sender.company)) return false;
  if (msg.from === sender.username) return true;
  if (sender.role === 'super_admin') return true;
  if (sender.role === 'admin') return String(msg.adminId || '') === String(sender.adminId) || msg.to === sender.username;
  return false;
}

/** Notify the super_admin socket of a company about an event */
function notifySuperAdmin(io, company, event, payload) {
  for (const [sid, info] of Object.entries(onlineUsers)) {
    if (String(info.company) === String(company) && info.role === 'super_admin') {
      io.to(sid).emit(event, payload);
    }
  }
}

/**
 * Broadcast an event to both sides of a message thread.
 * Works for both new (threadKey-based) and legacy messages.
 */
function broadcastToThread(io, msg, payload, event) {
  const participants = new Set([msg.from, msg.to]);
  for (const [sid, info] of Object.entries(onlineUsers)) {
    if (participants.has(info.username) && String(info.company) === String(msg.company)) {
      io.to(sid).emit(event, payload);
    }
  }
  if (msg.adminId) {
    io.to(`admin_room:${msg.adminId}`).emit(event, payload);
  }
}

/** Determine the adminId to store on a message in a thread */
function resolveAdminIdForThread(senderRole, senderAdminId, toUsername) {
  // If messaging an employee, the adminId is the sender's adminId
  if (senderRole === 'admin' || senderRole === 'super_admin') return senderAdminId;
  return null;
}

/**
 * ACL check: can this role/admin send to toUsername?
 *
 * super_admin → anyone in the same company
 * admin       → their own employees + the company's super_admins
 * employee    → not handled here (uses user_message)
 */
async function canSendTo(role, adminId, company, toUsername) {
  if (!company || !toUsername) return false;
  const m = /^(admin|superadmin):([a-f0-9]{24})$/i.exec(toUsername);

  if (role === 'super_admin') {
    // Anyone — but only inside the same company.
    if (m) return !!(await Admin.exists({ _id: m[2], company }));
    return !!(await User.exists({ name: toUsername, company }));
  }

  if (role === 'admin') {
    // Any of the company's super_admins …
    if (m) return m[1].toLowerCase() === 'superadmin' && !!(await Admin.exists({ _id: m[2], company, role: 'super_admin' }));
    // … or their own employees.
    const emp = await User.exists({ name: toUsername, company, createdBy: adminId });
    if (emp) return true;
    return !!(await ChatUser.exists({ username: toUsername, company, adminId }));
  }

  return false;
}

/**
 * Build the contact list visible to an admin or super_admin.
 *
 * super_admin  → all regular admins + all employees in the company
 * admin        → super_admin + their own employees
 *
 * Queries the real User/Admin collections so contacts appear even before
 * those users have connected via socket for the first time.
 * Upserts a ChatUser record for each so the rest of the system works.
 */
async function buildContactList(role, adminId, company) {
  const contacts = [];

  // Guard: without a company we cannot scope the query — bail with an empty
  // list rather than running an unscoped find that could match nothing (or
  // everything). A missing company here is the usual cause of "No contacts yet".
  if (!company) {
    console.warn('[buildContactList] called without company; returning empty list. role=', role, 'adminId=', adminId);
    return contacts;
  }

  // Normalize company to an ObjectId so string/ObjectId mismatches can't cause
  // an empty result. Fall back to the raw value if it isn't a valid id string.
  let companyMatch = company;
  try {
    if (typeof company === 'string' && mongoose.Types.ObjectId.isValid(company)) {
      companyMatch = new mongoose.Types.ObjectId(company);
    }
  } catch { /* keep raw value */ }

  if (role === 'super_admin') {
    // All regular admins in this company
    const admins = await Admin.find({ company: companyMatch, role: 'admin' }).lean();
    for (const a of admins) {
      const username = `admin:${a._id}`;
      const doc = await ChatUser.findOneAndUpdate(
        { username },
        { username, company, role: 'admin', adminId: a._id, userId: a._id, displayName: a.name, lastSeen: new Date() },
        { upsert: true, new: true }
      ).lean();
      contacts.push(doc);
    }

    // Fellow super admins (a company can have more than one)
    const otherSupers = await Admin.find({ company: companyMatch, role: 'super_admin', _id: { $ne: adminId } }).lean();
    for (const sa of otherSupers) {
      const username = `superadmin:${sa._id}`;
      const doc = await ChatUser.findOneAndUpdate(
        { username },
        { username, company, role: 'super_admin', adminId: sa._id, userId: sa._id, displayName: sa.name, lastSeen: new Date() },
        { upsert: true, new: true }
      ).lean();
      contacts.push(doc);
    }

    // All employees in this company
    const employees = await User.find({ company: companyMatch }).lean();
    for (const u of employees) {
      const username = u.name;
      const doc = await ChatUser.findOneAndUpdate(
        { username },
        { username, company, role: 'employee', adminId: u.createdBy || null, userId: u._id, displayName: u.name, lastSeen: new Date() },
        { upsert: true, new: true }
      ).lean();
      contacts.push(doc);
    }

  } else if (role === 'admin') {
    // Super admins of this company (there can be several)
    const superAdminDocs = await Admin.find({ company: companyMatch, role: 'super_admin' }).lean();
    for (const superAdminDoc of superAdminDocs) {
      const username = `superadmin:${superAdminDoc._id}`;
      const doc = await ChatUser.findOneAndUpdate(
        { username },
        { username, company, role: 'super_admin', adminId: superAdminDoc._id, userId: superAdminDoc._id, displayName: superAdminDoc.name, lastSeen: new Date() },
        { upsert: true, new: true }
      ).lean();
      contacts.push(doc);
    }

    // Employees created by this admin
    const employees = await User.find({ company: companyMatch, createdBy: adminId }).lean();
    for (const u of employees) {
      const username = u.name;
      const doc = await ChatUser.findOneAndUpdate(
        { username },
        { username, company, role: 'employee', adminId: u.createdBy || adminId, userId: u._id, displayName: u.name, lastSeen: new Date() },
        { upsert: true, new: true }
      ).lean();
      contacts.push(doc);
    }
  }

  return contacts;
}

module.exports = initSocket;
