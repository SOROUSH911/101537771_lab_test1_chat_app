const express = require('express');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

const User = require('./models/User');
const GroupMessage = require('./models/GroupMessage');
const PrivateMessage = require('./models/PrivateMessage');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/chat_app';

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'view')));

// Predefined rooms
const ROOMS = ['devops', 'cloud computing', 'covid19', 'sports', 'nodeJS'];

// ========================
// REST API Routes
// ========================

// Signup
app.post('/api/signup', async (req, res) => {
  try {
    const { username, firstname, lastname, password } = req.body;

    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    const user = new User({ username, firstname, lastname, password });
    await user.save();

    res.status(201).json({ message: 'User created successfully', username: user.username });
  } catch (err) {
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    res.json({
      message: 'Login successful',
      username: user.username,
      firstname: user.firstname,
      lastname: user.lastname
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get rooms list
app.get('/api/rooms', (req, res) => {
  res.json(ROOMS);
});

// Get messages for a room
app.get('/api/messages/:room', async (req, res) => {
  try {
    const messages = await GroupMessage.find({ room: req.params.room })
      .sort({ date_sent: 1 })
      .limit(100);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get private messages between two users
app.get('/api/private-messages/:user1/:user2', async (req, res) => {
  try {
    const { user1, user2 } = req.params;
    const messages = await PrivateMessage.find({
      $or: [
        { from_user: user1, to_user: user2 },
        { from_user: user2, to_user: user1 }
      ]
    }).sort({ date_sent: 1 }).limit(100);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Serve pages
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'view', 'login.html'));
});

app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'view', 'signup.html'));
});

app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'view', 'chat.html'));
});

// ========================
// Socket.io Events
// ========================

// Track users in rooms: { socketId: { username, room } }
const users = {};

function getRoomUsers(room) {
  return Object.values(users).filter(u => u.room === room);
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Join room
  socket.on('joinRoom', async ({ username, room }) => {
    // Leave previous room if any
    if (users[socket.id] && users[socket.id].room) {
      const prevRoom = users[socket.id].room;
      socket.leave(prevRoom);
      io.to(prevRoom).emit('message', {
        from_user: 'Chat App Bot',
        message: `${users[socket.id].username} has left the chat`,
        date_sent: new Date()
      });
      io.to(prevRoom).emit('roomUsers', getRoomUsers(prevRoom));
    }

    users[socket.id] = { username, room };
    socket.join(room);

    // Welcome message to the user
    socket.emit('message', {
      from_user: 'Chat App Bot',
      message: 'Welcome to chat app :)',
      date_sent: new Date()
    });

    // Broadcast to room that user joined
    socket.broadcast.to(room).emit('message', {
      from_user: 'Chat App Bot',
      message: `${username} has joined the chat`,
      date_sent: new Date()
    });

    // Send room users list
    io.to(room).emit('roomUsers', getRoomUsers(room));

    // Send previous messages for this room
    try {
      const previousMessages = await GroupMessage.find({ room })
        .sort({ date_sent: 1 })
        .limit(50);
      socket.emit('previousMessages', previousMessages);
    } catch (err) {
      console.error('Error loading previous messages:', err);
    }
  });

  // Chat message (group)
  socket.on('chatMessage', async (msg) => {
    const user = users[socket.id];
    if (!user) return;

    const messageData = {
      from_user: user.username,
      room: user.room,
      message: msg,
      date_sent: new Date()
    };

    // Save to MongoDB
    try {
      const groupMessage = new GroupMessage(messageData);
      await groupMessage.save();
    } catch (err) {
      console.error('Error saving message:', err);
    }

    // Broadcast to room
    io.to(user.room).emit('message', messageData);
  });

  // Private message
  socket.on('privateMessage', async ({ to_user, message }) => {
    const user = users[socket.id];
    if (!user) return;

    const messageData = {
      from_user: user.username,
      to_user,
      message,
      date_sent: new Date()
    };

    // Save to MongoDB
    try {
      const privateMsg = new PrivateMessage(messageData);
      await privateMsg.save();
    } catch (err) {
      console.error('Error saving private message:', err);
    }

    // Find recipient socket
    const recipientSocket = Object.entries(users).find(
      ([, u]) => u.username === to_user
    );

    // Send to recipient
    if (recipientSocket) {
      io.to(recipientSocket[0]).emit('privateMessage', messageData);
    }

    // Echo back to sender
    socket.emit('privateMessage', messageData);
  });

  // Typing indicator
  socket.on('typing', ({ username, room, to_user }) => {
    if (to_user) {
      // Private typing indicator
      const recipientSocket = Object.entries(users).find(
        ([, u]) => u.username === to_user
      );
      if (recipientSocket) {
        io.to(recipientSocket[0]).emit('typing', { username });
      }
    } else if (room) {
      socket.broadcast.to(room).emit('typing', { username });
    }
  });

  // Stop typing
  socket.on('stopTyping', ({ room, to_user }) => {
    if (to_user) {
      const recipientSocket = Object.entries(users).find(
        ([, u]) => u.username === to_user
      );
      if (recipientSocket) {
        io.to(recipientSocket[0]).emit('stopTyping');
      }
    } else if (room) {
      socket.broadcast.to(room).emit('stopTyping');
    }
  });

  // Leave room
  socket.on('leaveRoom', () => {
    const user = users[socket.id];
    if (!user) return;

    socket.leave(user.room);

    io.to(user.room).emit('message', {
      from_user: 'Chat App Bot',
      message: `${user.username} has left the chat`,
      date_sent: new Date()
    });

    io.to(user.room).emit('roomUsers', getRoomUsers(user.room));
    delete users[socket.id];
  });

  // Disconnect
  socket.on('disconnect', () => {
    const user = users[socket.id];
    if (user) {
      io.to(user.room).emit('message', {
        from_user: 'Chat App Bot',
        message: `${user.username} has left the chat`,
        date_sent: new Date()
      });
      io.to(user.room).emit('roomUsers', getRoomUsers(user.room));
      delete users[socket.id];
    }
    console.log(`User disconnected: ${socket.id}`);
  });
});

// ========================
// Start Server
// ========================
mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    server.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });
