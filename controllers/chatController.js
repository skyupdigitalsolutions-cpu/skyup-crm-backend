const ChatUser = require('../models/ChatUser');
const Message  = require('../models/Message');
const { readPagination, sendList, applyPage } = require('../utils/paginate');

// POST /api/chat/users — create or fetch chat user
const createOrFetchChatUser = async (req, res) => {
  const { username } = req.body;
  if (!username || !username.trim())
    return res.status(400).json({ error: 'Username is required' });

  try {
    const user = await ChatUser.findOneAndUpdate(
      { username: username.trim() },
      { username: username.trim(), lastSeen: new Date() },
      { upsert: true, new: true }
    );
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET /api/chat/users — get all chat users
const getAllChatUsers = async (req, res) => {
  try {
    const pg = readPagination(req, { defaultLimit: 50, maxLimit: 200 });
    const [users, total] = await Promise.all([
      applyPage(ChatUser.find().sort({ lastSeen: -1 }), pg).lean(),
      pg.enabled ? ChatUser.countDocuments() : null,
    ]);
    return sendList(res, users, pg, total);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET /api/chat/history/:username — get chat history
const getChatHistory = async (req, res) => {
  const { username } = req.params;
  try {
    const filter = {
      $or: [
        { from: username, to: 'admin' },
        { from: 'admin',  to: username }
      ]
    };
    // Paginated mode returns the NEWEST page first-in-time order:
    // page 1 = latest `limit` messages (still sorted oldest → newest).
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
    res.status(500).json({ error: err.message });
  }
};

// PUT /api/chat/message/:id — edit a message (sender or admin)
const editMessage = async (req, res) => {
  const { id } = req.params;
  const { newText, requester } = req.body; // requester: username or 'admin'

  if (!newText || !newText.trim())
    return res.status(400).json({ error: 'New message text is required' });

  try {
    const msg = await Message.findById(id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.isDeleted) return res.status(400).json({ error: 'Cannot edit a deleted message' });

    // Only the original sender or admin can edit
    const isAdmin = requester === 'admin';
    const isSender = msg.from === requester;
    if (!isAdmin && !isSender)
      return res.status(403).json({ error: 'Not authorised to edit this message' });

    msg.message  = newText.trim();
    msg.editedAt = new Date();
    await msg.save();

    res.json({ success: true, message: msg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// DELETE /api/chat/message/:id — soft-delete a message (sender or admin)
const deleteMessage = async (req, res) => {
  const { id } = req.params;
  const { requester } = req.body; // requester: username or 'admin'

  try {
    const msg = await Message.findById(id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });

    // Only the original sender or admin can delete
    const isAdmin = requester === 'admin';
    const isSender = msg.from === requester;
    if (!isAdmin && !isSender)
      return res.status(403).json({ error: 'Not authorised to delete this message' });

    msg.isDeleted = true;
    msg.message   = 'This message was deleted';
    await msg.save();

    res.json({ success: true, message: msg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  createOrFetchChatUser,
  getAllChatUsers,
  getChatHistory,
  editMessage,
  deleteMessage,
};