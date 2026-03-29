const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema({
  name:  { type: String, required: true },
  phone: { type: String, required: true }, // real number, never sent to frontend
  email: { type: String },
}, { timestamps: true });

module.exports = mongoose.model('Contact', contactSchema);