require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const request = require('request');
const mongoose = require('mongoose');

const app = express();
app.use(bodyParser.json());

// Basic route for testing
app.get('/', (req, res) => {
  res.send('Duet Dating Bot is running!');
});

// Connect to MongoDB
console.log('Attempting to connect to MongoDB...');
const mongoUri = process.env.MONGODB_URI ? process.env.MONGODB_URI.trim() : '';
console.log('MongoDB URI:', mongoUri);

mongoose.connect(mongoUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
  retryWrites: true
})
.then(() => console.log('Successfully connected to MongoDB'))
.catch(err => {
  console.error('MongoDB connection error:', err);
  // Log additional connection details
  console.log('Connection details:', {
    uri: mongoUri.replace(/mongodb\+srv:\/\/[^:]+:[^@]+@/, 'mongodb+srv://USER:PASS@'),
    error: err.message
  });
});

// Define schemas
const userSchema = new mongoose.Schema({
  facebookId: String,
  name: String,
  photo: String,
  gender: String,  // "male" or "female"
  lookingFor: String,  // "male" or "female"
  createdAt: { type: Date, default: Date.now }
});

const coupleSchema = new mongoose.Schema({
  user1: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  user2: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  votes: [{
    userId: String,
    vote: Boolean,
    comment: String,  // Optional comment about why they think it's a good/bad match
    createdAt: { type: Date, default: Date.now }
  }],
  totalVotes: { type: Number, default: 0 },
  positiveVotes: { type: Number, default: 0 },
  matchScore: { type: Number, default: 0 },  // Calculated based on votes and compatibility
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Couple = mongoose.model('Couple', coupleSchema);

// Add this route before the webhook routes
app.get('/clear-db/:token', async (req, res) => {
  const expectedToken = process.env.VERIFY_TOKEN; // Using the same token as webhook for simplicity
  const providedToken = req.params.token;

  if (providedToken !== expectedToken) {
    return res.status(403).send('Invalid token');
  }

  try {
    await User.deleteMany({});
    await Couple.deleteMany({});
    res.send('Database cleared successfully!');
  } catch (error) {
    console.error('Error clearing database:', error);
    res.status(500).send('Error clearing database');
  }
});

// Webhook verification
app.get('/webhook', (req, res) => {
  console.log('Received webhook verification request:', req.query);
  
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
    console.log("Webhook verified");
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error("Failed verification. Make sure the verify tokens match.");
    console.error("Expected:", process.env.VERIFY_TOKEN);
    console.error("Received:", req.query['hub.verify_token']);
    res.sendStatus(403);
  }
});

// Handle incoming messages
app.post('/webhook', (req, res) => {
  console.log('Received webhook event:', JSON.stringify(req.body));
  
  if (req.body.object === 'page') {
    req.body.entry.forEach(entry => {
      entry.messaging.forEach(event => {
        if (event.message) {
          handleMessage(event);
        }
      });
    });
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// Handle incoming messages
async function handleMessage(event) {
  console.log('Handling message event:', JSON.stringify(event));
  console.log('Sender ID:', event.sender.id);
  
  const senderId = event.sender.id;
  const message = event.message;

  try {
    // Check if user exists
    let user = await User.findOne({ facebookId: senderId });
    console.log('Existing user:', user);
    
    if (!user) {
      console.log('Creating new user...');
      // Get user profile from Facebook
      const userProfile = await getUserProfile(senderId);
      console.log('Facebook user profile:', userProfile);
      
      user = new User({
        facebookId: senderId,
        name: userProfile.first_name + ' ' + userProfile.last_name
      });
      await user.save();
      console.log('New user saved:', user);
      
      // Send welcome message
      await sendMessage(senderId, {
        text: `Welcome to Duet Dating, ${userProfile.first_name}! To get started, please send us a photo of yourself.`
      });
    } else if (!user.photo && message.attachments && message.attachments[0].type === 'image') {
      // Handle photo upload
      user.photo = message.attachments[0].payload.url;
      await user.save();
      
      // Ask for gender
      await sendMessage(senderId, {
        text: 'Great photo! Are you a man or woman? (Please reply with "man" or "woman")'
      });
    } else if (!user.gender && message.text) {
      // Handle gender input
      const gender = message.text.toLowerCase();
      if (gender === 'man' || gender === 'woman') {
        user.gender = gender;
        await user.save();
        
        // Ask who they're looking for
        await sendMessage(senderId, {
          text: `Perfect! Are you looking to meet a man or woman? (Please reply with "man" or "woman")`
        });
      } else {
        await sendMessage(senderId, {
          text: 'Please reply with either "man" or "woman"'
        });
      }
    } else if (!user.lookingFor && message.text) {
      // Handle preference input
      const lookingFor = message.text.toLowerCase();
      if (lookingFor === 'man' || lookingFor === 'woman') {
        user.lookingFor = lookingFor;
        await user.save();
        
        // Send completion message
        await sendMessage(senderId, {
          text: `Great! Your profile is complete. We'll start showing your profile to potential matches. Want to see some potential matches now? (Yes/No)`
        });
      } else {
        await sendMessage(senderId, {
          text: 'Please reply with either "man" or "woman"'
        });
      }
    } else if (message.text && message.text.toLowerCase() === 'yes') {
      // Show potential matches
      // TODO: Implement match showing logic
      await sendMessage(senderId, {
        text: 'Great! We\'ll show you some potential matches soon. Stay tuned!'
      });
    } else {
      // Handle other messages
      await sendMessage(senderId, {
        text: 'Please send a photo to get started!'
      });
    }
  } catch (error) {
    console.error('Error handling message:', error);
    try {
      await sendMessage(senderId, {
        text: 'Sorry, there was an error processing your message. Please try again.'
      });
    } catch (sendError) {
      console.error('Error sending error message:', sendError);
    }
  }
}

// Get user profile from Facebook
function getUserProfile(senderId) {
  return new Promise((resolve, reject) => {
    request({
      url: `https://graph.facebook.com/v18.0/${senderId}`,
      qs: {
        access_token: process.env.PAGE_ACCESS_TOKEN,
        fields: 'first_name,last_name'
      },
      method: 'GET'
    }, (error, response, body) => {
      if (error) {
        console.error('Error getting user profile:', error);
        reject(error);
      } else {
        try {
          const data = JSON.parse(body);
          if (data.error) {
            console.error('Facebook API error:', data.error);
            reject(new Error(data.error.message));
          } else {
            resolve(data);
          }
        } catch (parseError) {
          console.error('Error parsing user profile response:', parseError);
          reject(parseError);
        }
      }
    });
  });
}

// Send message to user
function sendMessage(senderId, message) {
  return new Promise((resolve, reject) => {
    request({
      url: 'https://graph.facebook.com/v18.0/me/messages',
      qs: { access_token: process.env.PAGE_ACCESS_TOKEN },
      method: 'POST',
      json: {
        recipient: { id: senderId },
        message: message
      }
    }, (error, response, body) => {
      if (error) {
        console.error('Error sending message:', error);
        reject(error);
      } else if (body.error) {
        console.error('Facebook API error:', body.error);
        reject(new Error(body.error.message));
      } else {
        resolve(body);
      }
    });
  });
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
}); 