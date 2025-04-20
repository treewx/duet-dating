require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const request = require('request');
const mongoose = require('mongoose');

const app = express();
app.use(bodyParser.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

// Define schemas
const userSchema = new mongoose.Schema({
  facebookId: String,
  name: String,
  photos: [String],
  gender: String,
  lookingFor: String,
  createdAt: { type: Date, default: Date.now }
});

const coupleSchema = new mongoose.Schema({
  user1: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  user2: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  votes: [{
    userId: String,
    vote: Boolean
  }],
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Couple = mongoose.model('Couple', coupleSchema);

// Webhook verification
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
    console.log("Webhook verified");
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error("Failed verification. Make sure the verify tokens match.");
    res.sendStatus(403);
  }
});

// Handle incoming messages
app.post('/webhook', (req, res) => {
  if (req.body.object === 'page') {
    req.body.entry.forEach(entry => {
      entry.messaging.forEach(event => {
        if (event.message) {
          handleMessage(event);
        }
      });
    });
    res.sendStatus(200);
  }
});

// Handle incoming messages
async function handleMessage(event) {
  const senderId = event.sender.id;
  const message = event.message;

  // Check if user exists
  let user = await User.findOne({ facebookId: senderId });
  
  if (!user) {
    // Get user profile from Facebook
    const userProfile = await getUserProfile(senderId);
    user = new User({
      facebookId: senderId,
      name: userProfile.first_name + ' ' + userProfile.last_name
    });
    await user.save();
    
    // Send welcome message
    sendMessage(senderId, {
      text: `Welcome to Duet Dating, ${userProfile.first_name}! To get started, please send us a photo of yourself.`
    });
  } else if (message.attachments && message.attachments[0].type === 'image') {
    // Handle photo upload
    user.photos.push(message.attachments[0].payload.url);
    await user.save();
    
    sendMessage(senderId, {
      text: 'Great! Photo received. Would you like to be matched with someone?'
    });
  } else {
    // Handle text messages
    sendMessage(senderId, {
      text: 'Please send a photo to get started!'
    });
  }
}

// Get user profile from Facebook
function getUserProfile(senderId) {
  return new Promise((resolve, reject) => {
    request({
      url: `https://graph.facebook.com/${senderId}`,
      qs: {
        access_token: process.env.PAGE_ACCESS_TOKEN,
        fields: 'first_name,last_name'
      },
      method: 'GET'
    }, (error, response, body) => {
      if (error) {
        reject(error);
      } else {
        resolve(JSON.parse(body));
      }
    });
  });
}

// Send message to user
function sendMessage(senderId, message) {
  request({
    url: 'https://graph.facebook.com/v12.0/me/messages',
    qs: { access_token: process.env.PAGE_ACCESS_TOKEN },
    method: 'POST',
    json: {
      recipient: { id: senderId },
      message: message
    }
  }, (error, response, body) => {
    if (error) {
      console.error('Error sending message:', error);
    }
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
}); 