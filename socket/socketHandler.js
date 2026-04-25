const Message  = require('../models/Message');
const ChatUser = require('../models/ChatUser');

const onlineUsers = {}; // { socketId: username }

const initSocket = (io) => {

  io.on('connection', (socket) => {

    // User joins
    socket.on('user_join', async (payload) => {
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

      const saved = await Message.create({ from: username, to: 'admin', message });

      io.to('admin').emit('receive_user_message', {
        from: username,
        socketId: socket.id,
        message,
        _id: saved._id,
      });

      // Echo back to user with the saved _id so they can edit/delete
      socket.emit('message_saved', { _id: saved._id, message, from: username });
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
      const saved = await Message.create({ from: 'admin', to: toUsername, message });

      socket.emit('admin_message_sent', { toUsername, message, _id: saved._id });

      if (toSocketId) {
        io.to(toSocketId).emit('receive_admin_message', { message, _id: saved._id });
      }
    });

    // ── Edit message ─────────────────────────────────────────────────────────
    // Payload: { _id, newText, requester }  (requester = username or 'admin')
    socket.on('edit_message', async ({ _id, newText, requester }) => {
      try {
        const msg = await Message.findById(_id);
        if (!msg || msg.isDeleted) return;

        const isAdmin  = requester === 'admin';
        const isSender = msg.from === requester;
        if (!isAdmin && !isSender) return;

        msg.message  = newText.trim();
        msg.editedAt = new Date();
        await msg.save();

        const payload = { _id: msg._id.toString(), newText: msg.message, editedAt: msg.editedAt };

        // Notify admin room
        io.to('admin').emit('message_edited', payload);

        // Notify the user whose conversation this belongs to
        const targetUsername = msg.from === 'admin' ? msg.to : msg.from;
        const targetSocketId = Object.entries(onlineUsers).find(([, n]) => n === targetUsername)?.[0];
        if (targetSocketId) {
          io.to(targetSocketId).emit('message_edited', payload);
        }
      } catch (err) {
        console.error('edit_message error', err);
      }
    });

    // ── Delete message ───────────────────────────────────────────────────────
    // Payload: { _id, requester }
    socket.on('delete_message', async ({ _id, requester }) => {
      try {
        const msg = await Message.findById(_id);
        if (!msg) return;

        const isAdmin  = requester === 'admin';
        const isSender = msg.from === requester;
        if (!isAdmin && !isSender) return;

        msg.isDeleted = true;
        msg.message   = 'This message was deleted';
        await msg.save();

        const payload = { _id: msg._id.toString() };

        io.to('admin').emit('message_deleted', payload);

        const targetUsername = msg.from === 'admin' ? msg.to : msg.from;
        const targetSocketId = Object.entries(onlineUsers).find(([, n]) => n === targetUsername)?.[0];
        if (targetSocketId) {
          io.to(targetSocketId).emit('message_deleted', payload);
        }
      } catch (err) {
        console.error('delete_message error', err);
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