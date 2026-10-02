const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    // PERF (database is far from this server — ~150 ms per round trip):
    //  • minPoolSize keeps warm connections open, so requests never pay for a
    //    fresh TCP+TLS+auth handshake (several round trips ≈ 0.5–1 s).
    //  • zlib compression shrinks large lead lists on the wire.
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/skyup-crm', {
      maxPoolSize: 50,
      minPoolSize: 10,
      maxIdleTimeMS: 0,
      compressors: ['zlib'],
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 60000,
    });
    console.log('MongoDB connected');
  } catch (err) {
    console.error('MongoDB error:', err);
    process.exit(1);
  }
};

module.exports = connectDB;