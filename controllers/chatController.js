const ChatUser = require('../models/ChatUser');
const Message  = require('../models/Message');

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
    const users = await ChatUser.find().sort({ lastSeen: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET /api/chat/history/:username — get chat history
const getChatHistory = async (req, res) => {
  const { username } = req.params;
  try {
    const messages = await Message.find({
      $or: [
        { from: username, to: 'admin' },
        { from: 'admin',  to: username }
      ]
    }).sort({ timestamp: 1 });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { createOrFetchChatUser, getAllChatUsers, getChatHistory };