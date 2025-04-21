require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const request = require('request');
const mongoose = require('mongoose');

const app = express();
app.use(bodyParser.json());

// Add health check endpoint at the top of the routes
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Basic route for testing
app.get('/', (req, res) => {
  res.send('Duet Dating Bot is running!');
});

// Connect to MongoDB
console.log('Attempting to connect to MongoDB...');
const mongoUri = process.env.MONGODB_URI ? process.env.MONGODB_URI.trim() : '';
console.log('MongoDB URI:', mongoUri.replace(/mongodb\+srv:\/\/[^:]+:[^@]+@/, 'mongodb+srv://USER:PASS@'));

mongoose.connect(mongoUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 10000, // Increase timeout to 10s
  retryWrites: true
})
.then(() => {
  console.log('Successfully connected to MongoDB');
  
  // Only start the server after MongoDB connection is established
  const PORT = process.env.PORT || 10000;
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log('All systems operational!');
  });
})
.catch(err => {
  console.error('MongoDB connection error:', err);
  // Log additional connection details
  console.log('Connection details:', {
    uri: mongoUri.replace(/mongodb\+srv:\/\/[^:]+:[^@]+@/, 'mongodb+srv://USER:PASS@'),
    error: err.message
  });
  // Exit the process if we can't connect to MongoDB
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM signal. Starting graceful shutdown...');
  mongoose.connection.close()
    .then(() => {
      console.log('MongoDB connection closed.');
      process.exit(0);
    })
    .catch(err => {
      console.error('Error during graceful shutdown:', err);
      process.exit(1);
    });
});

// Define schemas
const userSchema = new mongoose.Schema({
  facebookId: String,
  name: String,
  photo: String,
  gender: String,  // "male" or "female"
  lookingFor: String,  // "male" or "female"
  createdAt: { type: Date, default: Date.now },
  currentMatches: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  currentMatchIndex: Number,
  currentCoupleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Couple' },
  votingHistory: [{
    coupleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Couple' },
    vote: String,  // 'yes', 'no', or 'skip'
    votedAt: { type: Date, default: Date.now }
  }],
  totalVotes: { type: Number, default: 0 }
});

const coupleSchema = new mongoose.Schema({
  user1: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  user2: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  votes: [{
    userId: String,
    vote: String,  // 'yes', 'no', or 'skip'
    votedAt: { type: Date, default: Date.now }
  }],
  statistics: {
    totalVotes: { type: Number, default: 0 },
    yesVotes: { type: Number, default: 0 },
    noVotes: { type: Number, default: 0 },
    skipVotes: { type: Number, default: 0 },
    matchPercentage: { type: Number, default: 0 }
  },
  createdAt: { type: Date, default: Date.now }
});

coupleSchema.methods.calculateMatchPercentage = function() {
  if (this.statistics.totalVotes === 0) return 0;
  return Math.round((this.statistics.yesVotes / (this.statistics.yesVotes + this.statistics.noVotes)) * 100) || 0;
};

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
        } else if (event.postback) {
          handleMessage(event);  // We're using the same handler for both messages and postbacks
        }
      });
    });
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// Update the persistent menu setup
app.get('/setup', async (req, res) => {
  try {
    // Set up persistent menu
    await new Promise((resolve, reject) => {
      request({
        url: 'https://graph.facebook.com/v18.0/me/messenger_profile',
        qs: { access_token: process.env.PAGE_ACCESS_TOKEN },
        method: 'POST',
        json: {
          persistent_menu: [{
            locale: "default",
            composer_input_disabled: false,
            call_to_actions: [
              {
                type: "postback",
                title: "Rate Couples 💘",
                payload: "START_RATING"
              },
              {
                type: "postback",
                title: "Update Profile 📝",
                payload: "UPDATE_PROFILE"
              },
              {
                type: "postback",
                title: "View Profile 👤",
                payload: "VIEW_PROFILE"
              },
              {
                type: "postback",
                title: "Help ❓",
                payload: "SHOW_HELP"
              }
            ]
          }]
        }
      }, (error, response, body) => {
        if (error) {
          console.error('Error setting up persistent menu:', error);
          reject(error);
        } else if (body.error) {
          console.error('Facebook API error:', body.error);
          reject(new Error(body.error.message));
        } else {
          resolve(body);
        }
      });
    });

    // Also set up get started button
    await new Promise((resolve, reject) => {
      request({
        url: 'https://graph.facebook.com/v18.0/me/messenger_profile',
        qs: { access_token: process.env.PAGE_ACCESS_TOKEN },
        method: 'POST',
        json: {
          get_started: {
            payload: "GET_STARTED"
          }
        }
      }, (error, response, body) => {
        if (error) {
          console.error('Error setting up get started button:', error);
          reject(error);
        } else if (body.error) {
          console.error('Facebook API error:', body.error);
          reject(new Error(body.error.message));
        } else {
          resolve(body);
        }
      });
    });

    res.send('Messenger profile set up successfully!');
  } catch (error) {
    console.error('Error in setup:', error);
    res.status(500).send('Error setting up messenger profile');
  }
});

// Update handleMessage to validate Facebook photos
async function handleMessage(event) {
  console.log('Handling message event:', JSON.stringify(event));
  
  const senderId = event.sender.id;
  const message = event.message;
  const postback = event.postback;

  try {
    let user = await User.findOne({ facebookId: senderId });
    
    // Handle postback buttons
    if (postback) {
      switch (postback.payload) {
        case 'START_RATING':
          await showCoupleToRate(senderId);
          break;
        case 'UPDATE_PROFILE':
          if (user) {
            user.photo = undefined;
            user.gender = undefined;
            user.lookingFor = undefined;
            await user.save();
          }
          await sendMessage(senderId, {
            text: "Please send us a photo of yourself. Make sure it's a clear photo of just you!"
          });
          break;
        case 'VIEW_PROFILE':
          await showUserProfile(senderId);
          break;
        case 'SHOW_HELP':
          await showHelp(senderId);
          break;
        case 'GET_STARTED':
          if (!user) {
            const userProfile = await getUserProfile(senderId);
            user = new User({
              facebookId: senderId,
              name: userProfile.first_name + ' ' + userProfile.last_name
            });
            await user.save();
          }
          await sendMessage(senderId, {
            text: `Welcome to Duet Dating! Please send us a photo of yourself. Make sure it's a clear photo of just you!`
          });
          break;
      }
      return;
    }

    // Handle !createtest command
    if (message.text && message.text.toLowerCase() === '!createtest') {
      const testProfiles = await createTestProfiles();
      if (testProfiles) {
        await sendMessage(senderId, {
          text: `Created ${testProfiles.length} test profiles and generated couples for rating!`
        });
        await sendMessage(senderId, {
          text: "Would you like to start rating couples?",
          quick_replies: [
            {
              content_type: "text",
              title: "Start Rating 💘",
              payload: "START_RATING"
            },
            {
              content_type: "text",
              title: "View Profile 👤",
              payload: "VIEW_PROFILE"
            }
          ]
        });
      } else {
        await sendMessage(senderId, {
          text: "Sorry, there was an error creating the test profiles."
        });
      }
      return;
    }

    if (!user) {
      console.log('Creating new user...');
      const userProfile = await getUserProfile(senderId);
      
      user = new User({
        facebookId: senderId,
        name: userProfile.first_name + ' ' + userProfile.last_name
      });
      await user.save();
      
      await sendMessage(senderId, {
        text: `Welcome to Duet Dating, ${userProfile.first_name}! Please send us a photo of yourself. Make sure it's a clear photo of just you!`
      });
    } else if (!user.photo && message.attachments && message.attachments[0].type === 'image') {
      // Validate and store photo
      const photoUrl = message.attachments[0].payload.url;
      
      // Store the photo
      user.photo = photoUrl;
      await user.save();
      
      // Show the photo and confirm
      await sendMessage(senderId, {
        text: "Great photo! Here's how it will appear on your profile:"
      });
      
      await sendMessage(senderId, {
        attachment: {
          type: "image",
          payload: {
            url: photoUrl
          }
        }
      });
      
      // Ask for gender with quick replies
      await sendMessage(senderId, {
        text: "Are you a man or woman?",
        quick_replies: [
          {
            content_type: "text",
            title: "Man 👨",
            payload: "GENDER_MAN"
          },
          {
            content_type: "text",
            title: "Woman 👩",
            payload: "GENDER_WOMAN"
          }
        ]
      });
    } else if (!user.gender && message.quick_reply && message.quick_reply.payload.startsWith('GENDER_')) {
      const gender = message.quick_reply.payload === 'GENDER_MAN' ? 'man' : 'woman';
      user.gender = gender;
      await user.save();
      
      // Ask who they're looking for with quick replies
      await sendMessage(senderId, {
        text: "And who are you looking to meet?",
        quick_replies: [
          {
            content_type: "text",
            title: "Men 👨",
            payload: "LOOKING_MAN"
          },
          {
            content_type: "text",
            title: "Women 👩",
            payload: "LOOKING_WOMAN"
          }
        ]
      });
    } else if (!user.lookingFor && message.quick_reply && message.quick_reply.payload.startsWith('LOOKING_')) {
      const lookingFor = message.quick_reply.payload === 'LOOKING_MAN' ? 'man' : 'woman';
      user.lookingFor = lookingFor;
      await user.save();
      
      // Profile complete message
      await sendMessage(senderId, {
        text: "Perfect! Your profile is complete. Would you like to start rating couples?",
        quick_replies: [
          {
            content_type: "text",
            title: "Start Rating 💘",
            payload: "START_RATING"
          },
          {
            content_type: "text",
            title: "View Profile 👤",
            payload: "VIEW_PROFILE"
          }
        ]
      });
    } else if (message.quick_reply) {
      switch (message.quick_reply.payload) {
        case 'START_RATING':
          await showCoupleToRate(senderId);
          break;
        case 'VIEW_PROFILE':
          await showUserProfile(senderId);
          break;
        case 'VOTE_YES':
        case 'VOTE_NO':
        case 'VOTE_SKIP':
          const vote = message.quick_reply.payload.split('_')[1].toLowerCase();
          await handleVote(senderId, vote);
          break;
      }
    } else if (!user.photo) {
      await sendMessage(senderId, {
        text: "Please send us a photo of yourself. Make sure it's a clear photo of just you!"
      });
    }
  } catch (error) {
    console.error('Error handling message:', error);
    await sendMessage(senderId, {
      text: 'Sorry, there was an error processing your message. Please try again.'
    });
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

// Find potential matches for a user
async function findPotentialMatches(user) {
  try {
    // Find users of the gender the current user is looking for
    // who are also looking for users of the current user's gender
    const potentialMatches = await User.find({
      facebookId: { $ne: user.facebookId },  // Not the same user
      gender: user.lookingFor,  // Matches what user is looking for
      lookingFor: user.gender,  // Looking for user's gender
      photo: { $exists: true }  // Has a photo
    }).limit(5);  // Start with 5 matches max

    return potentialMatches;
  } catch (error) {
    console.error('Error finding matches:', error);
    return [];
  }
}

// Show a potential match to user
async function showMatch(senderId, match) {
  try {
    await sendMessage(senderId, {
      text: `Here's someone who might be a good match!\nName: ${match.name}`
    });

    // Send the photo
    await sendMessage(senderId, {
      attachment: {
        type: "image",
        payload: {
          url: match.photo
        }
      }
    });

    // Send voting options
    await sendMessage(senderId, {
      text: "What do you think? (Type 'Like' or 'Pass')"
    });
  } catch (error) {
    console.error('Error showing match:', error);
  }
}

// Show a couple to rate
async function showCoupleToRate(senderId) {
  try {
    const couple = await Couple.aggregate([
      { $match: { 'statistics.totalVotes': { $lt: 50 } } },  // Show couples with fewer votes first
      { $sample: { size: 1 } }
    ]).exec();

    if (!couple || couple.length === 0) {
      await sendMessage(senderId, {
        text: "No couples to rate right now. Check back later!"
      });
      return;
    }

    const populatedCouple = await Couple.findById(couple[0]._id)
      .populate('user1')
      .populate('user2');

    if (!populatedCouple) {
      await sendMessage(senderId, {
        text: "Error finding couple details. Please try again."
      });
      return;
    }

    // Calculate current match percentage
    const matchPercentage = populatedCouple.calculateMatchPercentage();

    // Send intro message with stats
    await sendMessage(senderId, {
      text: `Rate this potential couple!\n${populatedCouple.user1.name} & ${populatedCouple.user2.name}\n\nCurrent Match Rating: ${matchPercentage}%\nTotal Votes: ${populatedCouple.statistics.totalVotes}`
    });

    // Send photos
    await sendMessage(senderId, {
      attachment: {
        type: "image",
        payload: {
          url: populatedCouple.user1.photo
        }
      }
    });

    await sendMessage(senderId, {
      attachment: {
        type: "image",
        payload: {
          url: populatedCouple.user2.photo
        }
      }
    });

    // Send voting options with quick replies
    await sendMessage(senderId, {
      text: "Would they make a cute couple?",
      quick_replies: [
        {
          content_type: "text",
          title: "Yes! 😍",
          payload: "VOTE_YES"
        },
        {
          content_type: "text",
          title: "No 🤔",
          payload: "VOTE_NO"
        },
        {
          content_type: "text",
          title: "Skip ⏭️",
          payload: "VOTE_SKIP"
        }
      ]
    });

    // Store the current couple ID
    const user = await User.findOne({ facebookId: senderId });
    user.currentCoupleId = populatedCouple._id;
    await user.save();

  } catch (error) {
    console.error('Error showing couple:', error);
    await sendMessage(senderId, {
      text: "Sorry, there was an error showing the couple. Please try again."
    });
  }
}

// Create multiple test profiles
async function createTestProfiles() {
  try {
    const testProfiles = [
      // Women
      {
        name: 'Sarah Johnson',
        photo: 'https://images.pexels.com/photos/774909/pexels-photo-774909.jpeg',
        gender: 'woman'
      },
      {
        name: 'Emily Davis',
        photo: 'https://images.pexels.com/photos/1239291/pexels-photo-1239291.jpeg',
        gender: 'woman'
      },
      {
        name: 'Jessica Wilson',
        photo: 'https://images.pexels.com/photos/1065084/pexels-photo-1065084.jpeg',
        gender: 'woman'
      },
      {
        name: 'Rachel Green',
        photo: 'https://images.pexels.com/photos/733872/pexels-photo-733872.jpeg',
        gender: 'woman'
      },
      {
        name: 'Sofia Martinez',
        photo: 'https://images.pexels.com/photos/1382731/pexels-photo-1382731.jpeg',
        gender: 'woman'
      },
      {
        name: 'Emma Thompson',
        photo: 'https://images.pexels.com/photos/1587009/pexels-photo-1587009.jpeg',
        gender: 'woman'
      },
      {
        name: 'Olivia Chen',
        photo: 'https://images.pexels.com/photos/1462637/pexels-photo-1462637.jpeg',
        gender: 'woman'
      },
      {
        name: 'Isabella Kim',
        photo: 'https://images.pexels.com/photos/1542085/pexels-photo-1542085.jpeg',
        gender: 'woman'
      },
      // Men
      {
        name: 'Michael Brown',
        photo: 'https://images.pexels.com/photos/220453/pexels-photo-220453.jpeg',
        gender: 'man'
      },
      {
        name: 'David Miller',
        photo: 'https://images.pexels.com/photos/1516680/pexels-photo-1516680.jpeg',
        gender: 'man'
      },
      {
        name: 'James Wilson',
        photo: 'https://images.pexels.com/photos/2379004/pexels-photo-2379004.jpeg',
        gender: 'man'
      },
      {
        name: 'Daniel Lee',
        photo: 'https://images.pexels.com/photos/1222271/pexels-photo-1222271.jpeg',
        gender: 'man'
      },
      {
        name: 'Alex Rodriguez',
        photo: 'https://images.pexels.com/photos/1680172/pexels-photo-1680172.jpeg',
        gender: 'man'
      },
      {
        name: 'William Taylor',
        photo: 'https://images.pexels.com/photos/2182970/pexels-photo-2182970.jpeg',
        gender: 'man'
      },
      {
        name: 'Thomas Anderson',
        photo: 'https://images.pexels.com/photos/1681010/pexels-photo-1681010.jpeg',
        gender: 'man'
      },
      {
        name: 'Christopher Martinez',
        photo: 'https://images.pexels.com/photos/1681010/pexels-photo-1681010.jpeg',
        gender: 'man'
      }
    ];

    const createdProfiles = [];
    for (const profile of testProfiles) {
      // Check if profile already exists
      const existingProfile = await User.findOne({ 
        name: profile.name,
        gender: profile.gender 
      });
      
      if (!existingProfile) {
        const testUser = new User({
          facebookId: 'test_user_' + profile.name.replace(/\s/g, '_').toLowerCase() + '_' + Date.now(),
          name: profile.name,
          photo: profile.photo,
          gender: profile.gender,
          lookingFor: profile.gender === 'man' ? 'woman' : 'man'
        });
        await testUser.save();
        createdProfiles.push(testUser);
      }
    }

    // Create couples with random combinations
    const men = await User.find({ gender: 'man' });
    const women = await User.find({ gender: 'woman' });
    
    // Delete existing couples
    await Couple.deleteMany({});
    
    // Create new couples with random combinations
    for (let man of men) {
      for (let woman of women) {
        const couple = new Couple({
          user1: man._id,
          user2: woman._id,
          totalVotes: 0,
          statistics: {
            totalVotes: 0,
            yesVotes: 0,
            noVotes: 0,
            skipVotes: 0,
            matchPercentage: 0
          }
        });
        await couple.save();
      }
    }

    return createdProfiles;
  } catch (error) {
    console.error('Error creating test profiles:', error);
    return null;
  }
}

// Update handleVote to process votes and show statistics
async function handleVote(senderId, vote) {
  try {
    const user = await User.findOne({ facebookId: senderId });
    if (!user || !user.currentCoupleId) {
      await sendMessage(senderId, {
        text: "No couple selected. Type 'Yes' to start rating couples."
      });
      return;
    }

    const couple = await Couple.findById(user.currentCoupleId);
    if (!couple) {
      await sendMessage(senderId, {
        text: "Couple not found. Let's try another one."
      });
      return;
    }

    // Update couple statistics
    couple.votes.push({
      userId: senderId,
      vote: vote
    });

    couple.statistics.totalVotes++;
    if (vote === 'yes') couple.statistics.yesVotes++;
    else if (vote === 'no') couple.statistics.noVotes++;
    else if (vote === 'skip') couple.statistics.skipVotes++;

    couple.statistics.matchPercentage = couple.calculateMatchPercentage();
    await couple.save();

    // Update user voting history
    user.votingHistory.push({
      coupleId: couple._id,
      vote: vote
    });
    user.totalVotes++;
    await user.save();

    // Show vote confirmation and stats
    let responseText = "";
    if (vote === 'skip') {
      responseText = "Skipped! Let's see another couple.";
    } else {
      responseText = `Vote recorded! This couple has a ${couple.statistics.matchPercentage}% match rating from ${couple.statistics.totalVotes} votes.`;
    }
    
    await sendMessage(senderId, { text: responseText });

    // Show next couple
    await showCoupleToRate(senderId);

  } catch (error) {
    console.error('Error processing vote:', error);
    await sendMessage(senderId, {
      text: "Sorry, there was an error processing your vote. Please try again."
    });
  }
}

// Show user profile and stats
async function showUserProfile(senderId) {
  try {
    const user = await User.findOne({ facebookId: senderId });

    if (!user) {
      await sendMessage(senderId, {
        text: "Profile not found. Please send a message to get started!"
      });
      return;
    }

    // Show user's own photo first
    if (user.photo) {
      await sendMessage(senderId, {
        attachment: {
          type: "image",
          payload: {
            url: user.photo
          }
        }
      });
    }

    // Basic profile info
    let profileText = `👤 Your Dating Profile:\n`;
    profileText += `Name: ${user.name}\n`;
    profileText += `Gender: ${user.gender ? user.gender.charAt(0).toUpperCase() + user.gender.slice(1) : 'Not set'}\n`;
    profileText += `Looking for: ${user.lookingFor ? user.lookingFor.charAt(0).toUpperCase() + user.lookingFor.slice(1) : 'Not set'}\n\n`;

    // Find how many people have rated you in couples
    const couplesWithYou = await Couple.find({
      $or: [
        { user1: user._id },
        { user2: user._id }
      ]
    }).populate('user1 user2');

    let totalRatings = 0;
    let positiveRatings = 0;
    let topMatches = [];

    for (const couple of couplesWithYou) {
      totalRatings += couple.statistics.totalVotes;
      positiveRatings += couple.statistics.yesVotes;
      
      // Calculate match percentage for this couple
      const matchPercentage = couple.calculateMatchPercentage();
      
      // Get the other person in the couple
      const otherPerson = couple.user1._id.equals(user._id) ? couple.user2 : couple.user1;
      
      topMatches.push({
        person: otherPerson,
        matchPercentage: matchPercentage,
        totalVotes: couple.statistics.totalVotes
      });
    }

    // Sort matches by percentage and get top 3
    topMatches.sort((a, b) => b.matchPercentage - a.matchPercentage);
    topMatches = topMatches.slice(0, 3);

    // Add rating statistics
    profileText += `📊 Your Match Statistics:\n`;
    profileText += `Total times rated: ${totalRatings}\n`;
    profileText += `Positive ratings: ${positiveRatings}\n`;
    if (totalRatings > 0) {
      const overallMatchRate = Math.round((positiveRatings / totalRatings) * 100);
      profileText += `Overall match rate: ${overallMatchRate}%\n`;
    }

    await sendMessage(senderId, { text: profileText });

    // Show top potential matches if any exist
    if (topMatches.length > 0) {
      await sendMessage(senderId, {
        text: "🌟 Your Top Potential Matches:"
      });

      for (const match of topMatches) {
        // Show match details
        await sendMessage(senderId, {
          text: `Match with ${match.person.name}\n` +
                `Match Rating: ${match.matchPercentage}%\n` +
                `Based on ${match.totalVotes} votes`
        });

        // Show match photo
        await sendMessage(senderId, {
          attachment: {
            type: "image",
            payload: {
              url: match.person.photo
            }
          }
        });
      }
    }

    // Show quick actions
    await sendMessage(senderId, {
      text: "What would you like to do?",
      quick_replies: [
        {
          content_type: "text",
          title: "Rate Couples 💘",
          payload: "START_RATING"
        },
        {
          content_type: "text",
          title: "Update Profile 📝",
          payload: "UPDATE_PROFILE"
        },
        {
          content_type: "text",
          title: "Help ❓",
          payload: "SHOW_HELP"
        }
      ]
    });

  } catch (error) {
    console.error('Error showing profile:', error);
    await sendMessage(senderId, {
      text: "Sorry, there was an error showing your profile. Please try again."
    });
  }
}

// Add help command function
async function showHelp(senderId) {
  const helpText = `Welcome to Duet Dating! 💘\n\n` +
    `Commands:\n` +
    `- Type 'Yes' to start rating couples\n` +
    `- Type 'Profile' to see your stats\n` +
    `- Type 'Help' to see this message\n\n` +
    `When rating couples:\n` +
    `👍 Yes - They'd make a cute couple\n` +
    `👎 No - Not a good match\n` +
    `⏭️ Skip - Not sure about this one\n\n` +
    `Your votes help determine the best matches!`;

  await sendMessage(senderId, { text: helpText });
}

// Add new function to send photo picker message
async function sendPhotoPickerMessage(senderId) {
  await sendMessage(senderId, {
    attachment: {
      type: "template",
      payload: {
        template_type: "generic",
        elements: [{
          title: "Choose Your Profile Photo",
          subtitle: "Select a photo from your Facebook albums",
          image_url: "https://images.pexels.com/photos/1337825/pexels-photo-1337825.jpeg",
          buttons: [{
            type: "web_url",
            url: `https://www.facebook.com/dialog/photos?app_id=${process.env.APP_ID}&redirect_uri=${encodeURIComponent(process.env.WEBHOOK_URL)}&response_type=token`,
            title: "Select Photo",
            webview_height_ratio: "tall"
          }]
        }]
      }
    }
  });

  await sendMessage(senderId, {
    text: "Please select a photo from your Facebook albums. This helps ensure your profile photo is authentic!"
  });
} 