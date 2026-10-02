// controllers/chatController.js
// ─────────────────────────────────────────────────────────────────────────────
// Internal admin ↔ employee chat — REST side.
//
// SECURITY (data-leak hardening):
//   • Every query is scoped to the caller's OWN company (from the token).
//   • The caller's identity (username/role) comes from the token, never from
//     the request body — `requester` in the body is ignored.
//   • Employees only see themselves + their company's admins in the user list
//     and only their own threads in history.
// ─────────────────────────────────────────────────────────────────────────────
const mongoose = require('mongoose');
const ChatUser = require('../models/ChatUser');
const Message  = require('../models/Message');
const { readPagination, sendList, applyPage } = require('../utils/paginate');

const idStr = (v) => (v == null ? null : String(v._id || v));

/** Who is calling — derived only from the verified token (protectAny). */
function callerOf(req) {
  if (req.admin && req.admin._id) {
    const role = req.admin.role === 'super_admin' || req.superAdmin ? 'super_admin' : 'admin';
    const id = idStr(req.admin._id);
    return {
      kind: 'admin',
      role,
      id,
      company: idStr(req.callerCompany || req.admin.company),
      username: `${role === 'super_admin' ? 'superadmin' : 'admin'}:${id}`,
    };
  }
  if (req.user) {
    return {
      kind: 'employee',
      role: 'employee',
      id: idStr(req.user._id || req.user.userId),
      company: idStr(req.user.company || req.user.companyId || req.callerCompany),
      adminId: idStr(req.user.createdBy),
      username: req.user.name,
    };
  }
  return null;
}

const toOid = (v) => (mongoose.Types.ObjectId.isValid(v) ? new mongoose.Types.ObjectId(String(v)) : v);
const threadKey = (companyId, a, b) => `${companyId}:${[a, b].sort().join(':')}`;

// POST /api/chat/users — create or fetch the CALLER's own chat user record
const createOrFetchChatUser = async (req, res) => {
  const me = callerOf(req);
  if (!me || !me.company) return res.status(403).json({ error: 'No company context' });

  const username = String(req.body?.username || me.username || '').trim();
  if (!username) return res.status(400).json({ error: 'Username is required' });
  // You can only create/fetch your own record.
  if (username !== me.username) return res.status(403).json({ error: 'Not allowed' });

  try {
    const existing = await ChatUser.findOne({ username }).lean();
    if (existing && existing.company && idStr(existing.company) !== me.company) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    const user = await ChatUser.findOneAndUpdate(
      { username },
      { username, company: me.company, lastSeen: new Date() },
      { upsert: true, new: true }
    );
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// GET /api/chat/users — chat users of the caller's company only
const getAllChatUsers = async (req, res) => {
  const me = callerOf(req);
  if (!me || !me.company) return res.json([]);
  try {
    const filter = { company: toOid(me.company) };
    if (me.kind === 'employee') {
      // Employees: themselves + the company's admins / super admin.
      filter.$or = [{ userId: toOid(me.id) }, { role: { $in: ['admin', 'super_admin'] } }];
    } else if (me.role === 'admin') {
      // Admins: their own employees + admins/super admin of the company.
      filter.$or = [{ adminId: toOid(me.id) }, { role: { $in: ['admin', 'super_admin'] } }];
    }
    const pg = readPagination(req, { defaultLimit: 50, maxLimit: 200 });
    const [users, total] = await Promise.all([
      applyPage(ChatUser.find(filter).sort({ lastSeen: -1 }), pg).lean(),
      pg.enabled ? ChatUser.countDocuments(filter) : null,
    ]);
    return sendList(res, users, pg, total);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// GET /api/chat/history/:username — the caller's thread with :username
const getChatHistory = async (req, res) => {
  const me = callerOf(req);
  if (!me || !me.company) return res.json([]);
  const other = String(req.params.username || '');
  try {
    const filter = { company: toOid(me.company), threadKey: threadKey(me.company, me.username, other) };
    const pg = readPagination(req, { defaultLimit: 100, maxLimit: 300 });
    if (!pg.enabled) {
      const messages = await Message.find(filter).sort({ timestamp: 1 }).lean();
      return res.json(messages);
    }
    const [desc, total] = await Promise.all([
      Message.find(filter).sort({ timestamp: -1, _id: -1 }).skip(pg.skip).limit(pg.limit).lean(),
      Message.countDocuments(filter),
    ]);
    return sendList(res, desc.reverse(), pg, total);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

/** Can this caller edit/delete this message? Same company + (sender or its admin). */
function canModify(me, msg) {
  if (!me || !msg) return false;
  if (!msg.company || idStr(msg.company) !== me.company) return false;
  if (msg.from === me.username) return true;
  if (me.role === 'super_admin') return true;
  if (me.role === 'admin') return idStr(msg.adminId) === me.id || msg.to === me.username;
  return false;
}

// PUT /api/chat/message/:id — edit a message (sender, or admin of that thread)
const editMessage = async (req, res) => {
  const { id } = req.params;
  const { newText } = req.body || {};
  if (!newText || !String(newText).trim())
    return res.status(400).json({ error: 'New message text is required' });
  if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).json({ error: 'Message not found' });

  try {
    const msg = await Message.findById(id);
    const me = callerOf(req);
    if (!msg || !canModify(me, msg)) return res.status(404).json({ error: 'Message not found' });
    if (msg.isDeleted) return res.status(400).json({ error: 'Cannot edit a deleted message' });

    msg.message  = String(newText).trim();
    msg.editedAt = new Date();
    await msg.save();
    res.json({ success: true, message: msg });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// DELETE /api/chat/message/:id — soft-delete a message (sender, or admin of that thread)
const deleteMessage = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).json({ error: 'Message not found' });
  try {
    const msg = await Message.findById(id);
    const me = callerOf(req);
    if (!msg || !canModify(me, msg)) return res.status(404).json({ error: 'Message not found' });

    msg.isDeleted = true;
    msg.message   = 'This message was deleted';
    await msg.save();
    res.json({ success: true, message: msg });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  createOrFetchChatUser,
  getAllChatUsers,
  getChatHistory,
  editMessage,
  deleteMessage,
  _callerOf: callerOf,
  _canModify: canModify,
};
