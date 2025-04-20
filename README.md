# Duet Dating - Facebook Messenger App

A crowd-sourced dating app that runs on Facebook Messenger. Users submit their photos and get matched with potential partners based on community voting.

## Features

- User registration through Facebook Messenger
- Photo submission and storage
- Couple matching system
- Community voting on potential matches
- Real-time notifications

## Setup Instructions

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file with the following variables:
```
PAGE_ACCESS_TOKEN=your_page_access_token_here
VERIFY_TOKEN=your_verify_token_here
MONGODB_URI=your_mongodb_uri_here
```

3. Set up a Facebook Page and App:
   - Create a Facebook Page for your app
   - Create a Facebook App in the Facebook Developers Console
   - Enable the Messenger Platform
   - Generate a Page Access Token
   - Set up webhooks with your server's URL

4. Start the server:
```bash
npm start
```

## How It Works

1. Users start a conversation with your Facebook Page
2. They submit their photos through Messenger
3. The app matches them with potential partners
4. Other users vote on whether they think the matches would make a good couple
5. Users with high match ratings are notified and can start chatting

## Development

For development, use:
```bash
npm run dev
```

This will start the server with nodemon for automatic reloading.

## Security Notes

- Keep your Page Access Token and Verify Token secure
- Use HTTPS for your webhook URL
- Implement proper user authentication and data protection 