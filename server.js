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
    } else if (message.text && message.text.toLowerCase() === '!createtest') {
      // Create test profiles
      const testProfiles = await createTestProfiles();
      if (testProfiles) {
        await sendMessage(senderId, {
          text: `Created ${testProfiles.length} test profiles and generated couples for rating!`
        });
        await sendMessage(senderId, {
          text: "Would you like to rate some couples? (Type 'Yes')"
        });
      } else {
        await sendMessage(senderId, {
          text: "Sorry, there was an error creating the test profiles."
        });
      }
    } else if (message.text && message.text.toLowerCase() === 'yes') {
      // Show a couple to rate
      await showCoupleToRate(senderId);
    } else if (message.text && ['yes', 'no', 'skip'].includes(message.text.toLowerCase())) {
      await handleVote(senderId, message.text.toLowerCase());
    } else if (message.quick_reply && message.quick_reply.payload.startsWith('VOTE_')) {
      const vote = message.quick_reply.payload.split('_')[1].toLowerCase();
      await handleVote(senderId, vote);
    } else if (message.text && ['like', 'pass'].includes(message.text.toLowerCase())) {
      // Handle voting on current match
      if (!user.currentMatches || user.currentMatchIndex === undefined) {
        await sendMessage(senderId, {
          text: "Would you like to see some matches? Reply with 'Yes'"
        });
        return;
      }

      const vote = message.text.toLowerCase() === 'like';
      // TODO: Store the vote

      // Show next match if available
      user.currentMatchIndex++;
      if (user.currentMatchIndex < user.currentMatches.length) {
        const nextMatch = await User.findById(user.currentMatches[user.currentMatchIndex]);
        if (nextMatch) {
          await showMatch(senderId, nextMatch);
        }
      } else {
        await sendMessage(senderId, {
          text: "That's all the matches we have for now! Check back later for more."
        });
        user.currentMatches = undefined;
        user.currentMatchIndex = undefined;
      }
      await user.save();
    } else if (message.text && ['profile', 'stats', 'my profile'].includes(message.text.toLowerCase())) {
      await showUserProfile(senderId);
    } else if (message.text && ['help', '?'].includes(message.text.toLowerCase())) {
      await showHelp(senderId);
    } else if (message.quick_reply) {
      switch (message.quick_reply.payload) {
        case 'START_RATING':
          await showCoupleToRate(senderId);
          break;
        case 'SHOW_HELP':
          await showHelp(senderId);
          break;
        case 'VOTE_YES':
        case 'VOTE_NO':
        case 'VOTE_SKIP':
          const vote = message.quick_reply.payload.split('_')[1].toLowerCase();
          await handleVote(senderId, vote);
          break;
      }
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
    const user = await User.findOne({ facebookId: senderId })
      .populate({
        path: 'votingHistory.coupleId',
        populate: {
          path: 'user1 user2',
          select: 'name photo'
        }
      });

    if (!user) {
      await sendMessage(senderId, {
        text: "Profile not found. Please send a message to get started!"
      });
      return;
    }

    // Basic profile info
    let profileText = `📊 Your Profile Stats:\n`;
    profileText += `Name: ${user.name}\n`;
    profileText += `Total Votes: ${user.totalVotes}\n\n`;

    // Get voting breakdown
    const yesVotes = user.votingHistory.filter(v => v.vote === 'yes').length;
    const noVotes = user.votingHistory.filter(v => v.vote === 'no').length;
    const skipVotes = user.votingHistory.filter(v => v.vote === 'skip').length;

    profileText += `Voting Breakdown:\n`;
    profileText += `👍 Yes votes: ${yesVotes}\n`;
    profileText += `👎 No votes: ${noVotes}\n`;
    profileText += `⏭️ Skipped: ${skipVotes}\n\n`;

    await sendMessage(senderId, { text: profileText });

    // Find top rated couples user has voted on
    const votedCouples = await Couple.find({
      'votes.userId': senderId,
      'statistics.totalVotes': { $gt: 0 }
    })
    .populate('user1 user2')
    .sort({ 'statistics.matchPercentage': -1 })
    .limit(3);

    if (votedCouples.length > 0) {
      await sendMessage(senderId, {
        text: "🏆 Top Rated Couples You've Voted On:"
      });

      for (const couple of votedCouples) {
        const userVote = couple.votes.find(v => v.userId === senderId)?.vote || 'unknown';
        const message = `${couple.user1.name} & ${couple.user2.name}\n` +
                       `Match Rating: ${couple.statistics.matchPercentage}%\n` +
                       `Total Votes: ${couple.statistics.totalVotes}\n` +
                       `Your Vote: ${userVote.toUpperCase()}`;
        
        await sendMessage(senderId, { text: message });

        // Show couple photos
        await sendMessage(senderId, {
          attachment: {
            type: "template",
            payload: {
              template_type: "generic",
              elements: [
                {
                  title: couple.user1.name,
                  image_url: couple.user1.photo,
                  subtitle: "Potential Match"
                },
                {
                  title: couple.user2.name,
                  image_url: couple.user2.photo,
                  subtitle: "Potential Match"
                }
              ]
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
}); 