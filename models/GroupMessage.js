const mongoose = require('mongoose');

const groupMessageSchema = new mongoose.Schema({
  from_user: {
    type: String,
    required: [true, 'Sender username is required'],
    trim: true
  },
  room: {
    type: String,
    required: [true, 'Room name is required'],
    trim: true
  },
  message: {
    type: String,
    required: [true, 'Message content is required']
  },
  date_sent: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('GroupMessage', groupMessageSchema);
