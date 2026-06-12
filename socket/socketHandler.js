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

const Message  = require('../models/Message');
const ChatUser = require('../models/ChatUser');
const Admin    = require('../models/Admin');
const User     = require('../models/Users');
const Lead     = require('../models/Leads');

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
      status:        { $ne: 'Converted' },
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
  io.on('connection', (socket) => {

    // ── Attendance room (unchanged) ──────────────────────────────────────────
    socket.on('att_join', ({ userId }) => {
      if (userId) socket.join(`att:${userId}`);
    });

    // ── WhatsApp rooms (unchanged) ───────────────────────────────────────────
    socket.on('wa_admin_join',        ()           => socket.join('wa_admin'));
    socket.on('wa_agent_join',        ({ agentId }) => agentId && socket.join(`wa_agent_${agentId}`));

    // ── Agent personal room — for new_lead_assigned push ─────────────────────
    // Mobile app emits 'agent_join' with { userId } on connect/reconnect.
    // Backend uses this room in leadController to push new_lead_assigned events
    // directly to the right agent's socket without broadcasting to everyone.
    socket.on('agent_join', ({ userId }) => {
      if (userId) {
        socket.join(`agent:${userId}`);
        console.log(`[Socket] Agent ${userId} joined personal room agent:${userId}`);
      }
    });

    // Company-wide WhatsApp room — every employee joins their company's room
    // and receives every inbound/outbound for the company. The frontend filters
    // by which leads belong to the logged-in user. This mirrors the admin's
    // wa_admin firehose so employees don't depend on conversation.assignedAgent
    // being perfectly in sync with lead ownership.
    socket.on('wa_company_join',      ({ companyId }) => companyId && socket.join(`wa_company_${companyId}`));

    // ════════════════════════════════════════════════════════════════════════
    // EMPLOYEE joins
    // Payload: { username, userId, company, adminId }
    // ════════════════════════════════════════════════════════════════════════
    socket.on('user_join', async (payload) => {
      // Legacy: payload may be just a username string (old clients)
      if (typeof payload === 'string') {
        payload = { username: payload };
      }

      const { username, userId, company, displayName } = payload;
      let { adminId } = payload;
      if (!username) return;

      // If adminId is missing (old login response), look it up from the User record
      if (!adminId && userId) {
        const userDoc = await User.findById(userId).lean();
        if (userDoc?.createdBy) adminId = String(userDoc.createdBy);
      }

      const identity = {
        username,
        displayName: displayName || username,
        role: 'employee',
        company: company || null,
        adminId: adminId || null,
        userId:  userId  || null,
      };
      onlineUsers[socket.id] = identity;

      // Upsert ChatUser (always write adminId so it's correct going forward)
      await ChatUser.findOneAndUpdate(
        { username },
        { lastSeen: new Date(), company, role: 'employee', adminId, userId, displayName: identity.displayName },
        { upsert: true, new: true }
      );

      // Send chat history with their admin
      if (adminId && company) {
        const adminUsername = await resolveAdminUsername(adminId);
        if (adminUsername) {
          const history = await fetchHistory(company, username, adminUsername);
          socket.emit('chat_history', history);
        }
      }

      // Notify admins in same company about updated online status
      if (company) broadcastOnlineMap(io, company);
    });

    // ════════════════════════════════════════════════════════════════════════
    // ADMIN joins (role = 'admin')
    // Payload: { adminId, company, displayName }
    // ════════════════════════════════════════════════════════════════════════
    socket.on('admin_join', async (payload = {}) => {
      const { adminId, company, displayName } = payload;

      // Legacy clients send no payload — keep them working as before
      if (!adminId) {
        socket.join('admin');
        const allUsers = await ChatUser.find().sort({ lastSeen: -1 });
        socket.emit('all_users_db', allUsers);
        return;
      }

      const username = `admin:${adminId}`;
      const identity = {
        username,
        displayName: displayName || 'Admin',
        role: 'admin',
        company,
        adminId,
        userId: adminId,
      };
      onlineUsers[socket.id] = identity;

      // Legacy room kept for backward compat
      socket.join('admin');
      socket.join(`admin_room:${adminId}`);
      // Named room used by fcmService socket push (no_action_alert, follow_up_alert)
      socket.join(`admin:${adminId}`);
      // Company-wide admin room — fallback target for events that emit to
      // company_admin:${company} (e.g. lead_closed_by_user, meeting_permission_
      // requested). Without this join those company-wide fallbacks went nowhere.
      if (company) socket.join(`company_admin:${company}`);

      await ChatUser.findOneAndUpdate(
        { username },
        { lastSeen: new Date(), company, role: 'admin', adminId, userId: adminId, displayName: identity.displayName },
        { upsert: true, new: true }
      );

      // Send scoped user list (their employees + super_admin)
      const contactList = await buildContactList('admin', adminId, company);
      socket.emit('all_users_db', contactList);

      broadcastOnlineMap(io, company);

      // Push pending follow-up alerts ONLY on the first admin_join per socket connection.
      // If the client re-emits admin_join (e.g. due to React effect re-runs or component
      // remounts), we skip pushPendingFollowUps to prevent duplicate bell notifications.
      if (!socket._adminJoinHandled) {
        socket._adminJoinHandled = true;
        pushPendingFollowUps(socket, adminId, company, 'admin');
      }
    });

    // ════════════════════════════════════════════════════════════════════════
    // SUPER_ADMIN joins
    // Payload: { adminId, company, displayName }
    // ════════════════════════════════════════════════════════════════════════
    socket.on('super_admin_join', async (payload = {}) => {
      const { adminId, company, displayName } = payload;
      if (!adminId || !company) return;

      const username = `superadmin:${adminId}`;
      const identity = {
        username,
        displayName: displayName || 'Super Admin',
        role: 'super_admin',
        company,
        adminId,
        userId: adminId,
      };
      onlineUsers[socket.id] = identity;

      socket.join('admin');
      socket.join(`admin_room:${adminId}`);
      // Named room used by fcmService socket push (lead_reassigned_notify, no_action_alert, follow_up_alert)
      socket.join(`superadmin:${adminId}`);
      // Company-wide admin room — fallback for company_admin:${company} emits.
      if (company) socket.join(`company_admin:${company}`);

      await ChatUser.findOneAndUpdate(
        { username },
        { lastSeen: new Date(), company, role: 'super_admin', adminId, userId: adminId, displayName: identity.displayName },
        { upsert: true, new: true }
      );

      // Super admin sees all admins + all employees in their company
      const contactList = await buildContactList('super_admin', adminId, company);
      socket.emit('all_users_db', contactList);

      const onlineMap = buildOnlineMap(company, 'super_admin', adminId);
      socket.emit('users_list', onlineMap);

      broadcastOnlineMap(io, company);

      // super_admin does not receive on-connect follow-up alerts.
      // Their notifications come from lead_reassigned_notify only.
      // Guard flag prevents any future pushPendingFollowUps calls on re-emit.
      socket._adminJoinHandled = true;
    });

    // ════════════════════════════════════════════════════════════════════════
    // EMPLOYEE → sends message to their admin
    // Payload: { message, username }  (username optionally sent for safety)
    // ════════════════════════════════════════════════════════════════════════
    socket.on('user_message', async ({ message, username: _username }) => {
      const identity = onlineUsers[socket.id];
      if (!identity) return;

      const { username, company, adminId } = identity;
      if (!company || !adminId) {
        // Legacy fallback: broadcast to 'admin' room as before
        const saved = await Message.create({
          from: username, to: 'admin', message,
          company: '000000000000000000000000', // placeholder
          threadKey: `legacy:${username}`,
        }).catch(() => null);
        io.to('admin').emit('receive_user_message', { from: username, socketId: socket.id, message, _id: saved?._id });
        socket.emit('message_saved', { _id: saved?._id, message, from: username });
        return;
      }

      const adminUsername = await resolveAdminUsername(adminId);
      if (!adminUsername) return;

      const key  = threadKey(company, username, adminUsername);
      const saved = await Message.create({ from: username, to: adminUsername, message, company, adminId, threadKey: key });

      // Notify the assigned admin's room
      io.to(`admin_room:${adminId}`).emit('receive_user_message', {
        from: username,
        displayName: identity.displayName,
        socketId: socket.id,
        message,
        _id: saved._id,
      });

      // Also notify super_admin of the same company
      notifySuperAdmin(io, company, 'receive_user_message', {
        from: username,
        displayName: identity.displayName,
        message,
        _id: saved._id,
      });

      socket.emit('message_saved', { _id: saved._id, message, from: username });
    });

    // ════════════════════════════════════════════════════════════════════════
    // ADMIN / SUPER_ADMIN → sends message to a contact
    // Payload: { toSocketId, toUsername, message }
    //   toUsername: the target's username string (e.g. 'employee_name' or 'superadmin:<id>')
    // ════════════════════════════════════════════════════════════════════════
    socket.on('admin_message', async ({ toSocketId, toUsername, message }) => {
      const sender = onlineUsers[socket.id];
      if (!sender) return;

      const { username: fromUsername, company, adminId, role } = sender;

      // ── ACL check ──────────────────────────────────────────────────────────
      const allowed = await canSendTo(role, adminId, company, toUsername);
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

      // Deliver to target if online
      if (toSocketId) {
        io.to(toSocketId).emit('receive_admin_message', { message, _id: saved._id, from: fromUsername, displayName: sender.displayName });
      } else {
        // Try to find socket by username
        const targetSid = findSocketId(toUsername);
        if (targetSid) {
          io.to(targetSid).emit('receive_admin_message', { message, _id: saved._id, from: fromUsername, displayName: sender.displayName });
        }
      }
    });

    // ════════════════════════════════════════════════════════════════════════
    // Fetch history for a specific thread (admin/superadmin side)
    // Payload: { username }  — the other party's username
    // ════════════════════════════════════════════════════════════════════════
    socket.on('admin_fetch_history', async ({ username: otherUsername }) => {
      const viewer = onlineUsers[socket.id];

      // Legacy support
      if (!viewer) {
        const history = await Message.find({
          $or: [
            { from: otherUsername, to: 'admin' },
            { from: 'admin', to: otherUsername },
          ]
        }).sort({ timestamp: 1 }).lean();
        socket.emit('admin_chat_history', { username: otherUsername, history });
        return;
      }

      const { username: myUsername, company } = viewer;
      const history = await fetchHistory(company, myUsername, otherUsername);
      socket.emit('admin_chat_history', { username: otherUsername, history });
    });

    // ════════════════════════════════════════════════════════════════════════
    // Edit message
    // Payload: { _id, newText, requester }
    // ════════════════════════════════════════════════════════════════════════
    socket.on('edit_message', async ({ _id, newText, requester }) => {
      try {
        const msg = await Message.findById(_id);
        if (!msg || msg.isDeleted) return;

        const sender = onlineUsers[socket.id];
        const isAdmin = sender?.role === 'admin' || sender?.role === 'super_admin' || requester === 'admin';
        const isSender = msg.from === (sender?.username || requester);
        if (!isAdmin && !isSender) return;

        msg.message  = newText.trim();
        msg.editedAt = new Date();
        await msg.save();

        const payload = { _id: msg._id.toString(), newText: msg.message, editedAt: msg.editedAt };

        broadcastToThread(io, msg, payload, 'message_edited');
      } catch (err) {
        console.error('edit_message error', err);
      }
    });

    // ════════════════════════════════════════════════════════════════════════
    // Delete message
    // ════════════════════════════════════════════════════════════════════════
    socket.on('delete_message', async ({ _id, requester }) => {
      try {
        const msg = await Message.findById(_id);
        if (!msg) return;

        const sender = onlineUsers[socket.id];
        const isAdmin = sender?.role === 'admin' || sender?.role === 'super_admin' || requester === 'admin';
        const isSender = msg.from === (sender?.username || requester);
        if (!isAdmin && !isSender) return;

        msg.isDeleted = true;
        msg.message   = 'This message was deleted';
        await msg.save();

        const payload = { _id: msg._id.toString() };
        broadcastToThread(io, msg, payload, 'message_deleted');
      } catch (err) {
        console.error('delete_message error', err);
      }
    });

    // ── Disconnect ───────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      const identity = onlineUsers[socket.id];
      delete onlineUsers[socket.id];
      if (identity?.company) broadcastOnlineMap(io, identity.company);
      else io.emit('users_list', onlineUsers); // legacy fallback
    });

  }); // end io.on connection
};

// ── Utility functions ─────────────────────────────────────────────────────────

/** Look up admin username string from their _id */
async function resolveAdminUsername(adminId) {
  const admin = await Admin.findById(adminId).lean();
  if (!admin) return null;
  const prefix = admin.role === 'super_admin' ? 'superadmin' : 'admin';
  return `${prefix}:${adminId}`;
}

/** Find a socket id for a given username */
function findSocketId(username) {
  return Object.entries(onlineUsers).find(([, info]) => info.username === username)?.[0] ?? null;
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
    if (participants.has(info.username)) {
      io.to(sid).emit(event, payload);
    }
  }

  // Also notify admin room if one side is admin / superadmin
  if (msg.from === 'admin' || msg.to === 'admin') {
    io.to('admin').emit(event, payload);
  }

  // Notify specific admin room if adminId is set
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
 * admin       → their own employees + the super_admin
 * employee    → not handled here (uses user_message)
 */
async function canSendTo(role, adminId, company, toUsername) {
  if (role === 'super_admin') return true; // super_admin can message anyone in company

  if (role === 'admin') {
    // Can message super_admin
    if (toUsername.startsWith('superadmin:')) return true;
    // Can message their own employees
    const employee = await ChatUser.findOne({ username: toUsername, company, adminId }).lean();
    return !!employee;
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

  if (role === 'super_admin') {
    // All regular admins in this company
    const admins = await Admin.find({ company, role: 'admin' }).lean();
    for (const a of admins) {
      const username = `admin:${a._id}`;
      const doc = await ChatUser.findOneAndUpdate(
        { username },
        { username, company, role: 'admin', adminId: a._id, userId: a._id, displayName: a.name, lastSeen: new Date() },
        { upsert: true, new: true }
      ).lean();
      contacts.push(doc);
    }

    // All employees in this company
    const employees = await User.find({ company }).lean();
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
    // Super admin of this company
    const superAdminDoc = await Admin.findOne({ company, role: 'super_admin' }).lean();
    if (superAdminDoc) {
      const username = `superadmin:${superAdminDoc._id}`;
      const doc = await ChatUser.findOneAndUpdate(
        { username },
        { username, company, role: 'super_admin', adminId: superAdminDoc._id, userId: superAdminDoc._id, displayName: superAdminDoc.name, lastSeen: new Date() },
        { upsert: true, new: true }
      ).lean();
      contacts.push(doc);
    }

    // Employees created by this admin
    const employees = await User.find({ company, createdBy: adminId }).lean();
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