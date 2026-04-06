const Message  = require('../models/Message');
const ChatUser = require('../models/ChatUser');

const onlineUsers = {}; // { socketId: username }

const initSocket = (io) => {

  io.on('connection', (socket) => {

    // User joins
    // FIX: frontend was sending { username } object — now accept both forms
    socket.on('user_join', async (payload) => {
      // Accept either a plain string ("alice") or an object ({ username: "alice" })
      const username = typeof payload === 'object' && payload !== null
        ? payload.username
        : payload;

      if (!username) return;

      onlineUsers[socket.id] = username;

      await ChatUser.findOneAndUpdate(
        { username },
        { lastSeen: new Date() },
        { upsert: true, new: true }
      );

      io.emit('users_list', onlineUsers);

      // Send chat history to this user
      const history = await Message.find({
        $or: [
          { from: username, to: 'admin' },
          { from: 'admin',  to: username }
        ]
      }).sort({ timestamp: 1 });

      socket.emit('chat_history', history);
    });

    // User sends message to admin
    socket.on('user_message', async ({ message }) => {
      const username = onlineUsers[socket.id];
      if (!username) return;

      await Message.create({ from: username, to: 'admin', message });

      io.to('admin').emit('receive_user_message', {
        from: username,
        socketId: socket.id,
        message
      });
    });

    // Admin joins
    socket.on('admin_join', async () => {
      socket.join('admin');

      const allUsers = await ChatUser.find().sort({ lastSeen: -1 });
      socket.emit('all_users_db', allUsers);
    });

    // Admin requests history for a specific user
    socket.on('admin_fetch_history', async ({ username }) => {
      const history = await Message.find({
        $or: [
          { from: username, to: 'admin' },
          { from: 'admin',  to: username }
        ]
      }).sort({ timestamp: 1 });

      socket.emit('admin_chat_history', { username, history });
    });

    // Admin sends message to user
    socket.on('admin_message', async ({ toSocketId, toUsername, message }) => {
      await Message.create({ from: 'admin', to: toUsername, message });

      // FIX: also emit back to admin's own chat state
      socket.emit('admin_message_sent', { toUsername, message });

      if (toSocketId) {
        io.to(toSocketId).emit('receive_admin_message', { message });
      }
    });

    // Disconnect
    socket.on('disconnect', () => {
      delete onlineUsers[socket.id];
      io.emit('users_list', onlineUsers);
    });

  });

};

module.exports = initSocket;