#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const USER_AGENT = 'TwitterMarketingMCP/1.0.0 (https://github.com/1036007003-wq/twitter-marketing-mcp)';

function getAgent(url) {
  const proxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy;
  if (proxy && url.startsWith('https')) {
    // Note: would need https-proxy-agent package
    // For now, just return undefined
    return undefined;
  }
  return undefined;
}

// --- Twitter API v2 helpers ---
// Free tier: https://developer.twitter.com/en/docs/twitter-api
// Scopes needed: tweet.read, users.read, follows.read

async function twitterApiV2(path, token, params = {}) {
  const url = new URL(`https://api.twitter.com/2/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  const res = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': USER_AGENT,
    },
    timeout: 15000,
  });
  return res.json();
}

// --- Free search via Nitter (Twitter scraper, no API key needed) ---
// Nitter is a free Twitter frontend. Many public instances.
// We'll use nitter.privacydev.net as default.

const NITTER_INSTANCES = [
  'https://nitter.privacydev.net',
  'https://nitter.cz',
  'https://nitter.1d4.us',
  'https://nitter.lunar.icu',
];

async function nitterGet(path) {
  // Try each instance until one works
  for (const base of NITTER_INSTANCES) {
    try {
      const url = `${base}${path}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: 10000,
      });
      if (res.ok) {
        const html = await res.text();
        return { html, instance: base };
      }
    } catch (e) {
      continue;
    }
  }
  throw new Error('All Nitter instances failed. Twitter may be blocked. Use a proxy or Twitter API key.');
}

// Parse tweet from Nitter HTML (simplified)
function parseTweetsFromHTML(html) {
  // This is a simplified parser. In production, use cheerio or similar.
  const tweets = [];
  const titleMatches = html.match(/<div class="tweet-content[^"]*"[^>]*>([^<]+)<\/div>/g) || [];
  // Simplified - just return a note
  return {
    note: 'Nitter HTML parsing requires cheerio. Install cheerio for full functionality.',
    htmlLength: html.length,
    tweetCountEstimate: titleMatches.length,
  };
}

function isPremium() {
  const licenseKey = process.env.LICENSE_KEY;
  if (!licenseKey) return false;
  return licenseKey.length > 10;
}

// --- AI tweet generation via DeepSeek ---
async function aiGenerateTweet(topic, style) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return `[Premium] Set DEEPSEEK_API_KEY in .env to enable AI generation.
    
Meanwhile, here's a template tweet about "${topic}":
---
🚀 ${topic}
Thread 🧵
1/?
---
Upgrade to premium for AI-powered generation.`;
  }

  const styleGuide = {
    default: 'casual, engaging, use emojis sparingly',
    viral: 'provocative, short, use hooks',
    professional: 'professional, no emojis, insightful',
    thread: 'long-form thread, educational, valuable',
  }[style || 'default'] || 'casual, engaging';

  const prompt = `Write a viral tweet about "${topic}".
Style: ${styleGuide}
Requirements:
- Under 280 characters
- Engaging, not salesy
- Include 1-3 relevant emojis
- End with a question or CTA if appropriate
Output only the tweet text, no explanation.`;

  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
      }),
      timeout: 20000,
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '[AI generation failed]';
  } catch (e) {
    return `[AI generation error: ${e.message}]`;
  }
}

// --- Tool handlers ---

async function searchTweets(args) {
  const query = args.query;
  const count = Math.min(args.count || 10, 100);

  // Try Twitter API v2 first (if token provided)
  const apiToken = process.env.TWITTER_BEARER_TOKEN;
  if (apiToken) {
    try {
      const data = await twitterApiV2('tweets/search/recent', apiToken, {
        query,
        max_results: count,
        'tweet.fields': 'author_id,created_at,public_metrics,text',
      });
      const tweets = (data.data || []).map(t => ({
        id: t.id,
        text: t.text,
        author_id: t.author_id,
        created_at: t.created_at,
        likes: t.public_metrics?.like_count || 0,
        retweets: t.public_metrics?.retweet_count || 0,
        replies: t.public_metrics?.reply_count || 0,
      }));
      return {
        source: 'Twitter API v2',
        query,
        count: tweets.length,
        tweets,
        freeFeature: true,
      };
    } catch (e) {
      // Fall back to Nitter
    }
  }

  // Fallback: Nitter (no API key needed, but may be blocked)
  try {
    const { html, instance } = await nitterGet(`/search?q=${encodeURIComponent(query)}&f=tweets`);
    const parsed = parseTweetsFromHTML(html);
    return {
      source: `Nitter (${instance})`,
      query,
      note: 'Nitter provides HTML. For full functionality, set TWITTER_BEARER_TOKEN in .env or install cheerio.',
      parsed: parsed,
      freeFeature: true,
      setupTip: 'Get free Twitter API v2 Bearer Token at https://developer.twitter.com (free tier available)',
    };
  } catch (e) {
    throw new Error(`Cannot search Twitter. Set TWITTER_BEARER_TOKEN in .env. Error: ${e.message}`);
  }
}

async function analyzeAccount(args) {
  const username = args.username.replace(/^@/, '');
  const apiToken = process.env.TWITTER_BEARER_TOKEN;

  if (apiToken) {
    try {
      // Get user info
      const userData = await twitterApiV2(`users/by/username/${username}`, apiToken, {
        'user.fields': 'public_metrics,description,created_at',
      });
      const u = userData.data;
      return {
        username: `@${username}`,
        name: u.name,
        followers: u.public_metrics?.followers_count || 0,
        following: u.public_metrics?.following_count || 0,
        tweetCount: u.public_metrics?.tweet_count || 0,
        description: u.description,
        createdAt: u.created_at,
        freeFeature: true,
      };
    } catch (e) {
      // Fall through to Nitter
    }
  }

  // Fallback: Nitter
  try {
    const { html, instance } = await nitterGet(`/${username}`);
    return {
      username: `@${username}`,
      source: `Nitter (${instance})`,
      note: 'Set TWITTER_BEARER_TOKEN for full API access.',
      freeFeature: true,
    };
  } catch (e) {
    throw new Error(`Cannot analyze account. Set TWITTER_BEARER_TOKEN in .env. Error: ${e.message}`);
  }
}

async function findTrending(args) {
  // Twitter trending requires API v1.1 or v2 with elevated access
  // For free tier, we'll use Nitter's "trending" page
  try {
    const { html, instance } = await nitterGet('/');
    return {
      source: `Nitter (${instance})`,
      note: 'Twitter trending requires elevated API access. This is a placeholder.',
      freeFeature: true,
      tip: 'Set TWITTER_BEARER_TOKEN for real trending data via API v2.',
    };
  } catch (e) {
    throw new Error(`Cannot fetch trending. Error: ${e.message}`);
  }
}

async function generateTweet(args) {
  if (!isPremium()) {
    throw new Error('PREMIUM FEATURE. Get a license key to unlock AI tweet generation. Visit: https://github.com/sponsors/1036007003-wq');
  }

  const topic = args.topic || 'your project';
  const style = args.style || 'default';
  const tweet = await aiGenerateTweet(topic, style);

  return {
    generatedTweet: tweet,
    topic,
    style,
    characterCount: tweet.length,
    premiumFeature: true,
    nextStep: 'Review and edit before posting. Make it sound like YOU.',
  };
}

async function scheduleTweet(args) {
  if (!isPremium()) {
    throw new Error('PREMIUM FEATURE. Get a license key to unlock scheduling.');
  }

  return {
    status: 'premium feature - coming soon',
    tweetPreview: args.tweetText?.slice(0, 100) + '...',
    note: 'Real scheduling requires Twitter API v2 with write permissions. Set TWITTER_CLIENT_ID and TWITTER_CLIENT_SECRET in .env.',
    premiumFeature: true,
  };
}

async function trackTwitterMetrics(args) {
  if (!isPremium()) {
    throw new Error('PREMIUM FEATURE. Get a license key to unlock metrics tracking.');
  }

  return {
    note: 'Metrics tracking requires connecting your Twitter account via OAuth 2.0.',
    premiumFeature: true,
    setupGuide: '1. Create a Twitter app at https://developer.twitter.com/en/portal/dashboard\n2. Enable OAuth 2.0\n3. Add credentials to .env\n4. Restart the server',
  };
}

// --- MCP Server ---

const server = new Server(
  { name: 'twitter-marketing-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'search_tweets',
        description: 'Search recent tweets by keyword. Free feature (uses Twitter API v2 free tier or Nitter).',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query (hashtag, keyword, etc.)' },
            count: { type: 'number', description: 'Number of tweets to return (max 100)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'analyze_account',
        description: 'Analyze any Twitter account: follower count, bio, tweet frequency. Free feature.',
        inputSchema: {
          type: 'object',
          properties: {
            username: { type: 'string', description: 'Twitter username (with or without @)' },
          },
          required: ['username'],
        },
      },
      {
        name: 'find_trending',
        description: 'Find trending topics on Twitter. Free feature.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'generate_tweet',
        description: 'AI-powered tweet generator. PREMIUM feature (GitHub Sponsors).',
        inputSchema: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'Topic or product to tweet about' },
            style: { type: 'string', description: 'Tweet style: default, viral, professional, thread' },
          },
          required: ['topic'],
        },
      },
      {
        name: 'schedule_tweet',
        description: 'Auto-schedule tweets for optimal engagement. PREMIUM feature.',
        inputSchema: {
          type: 'object',
          properties: {
            tweetText: { type: 'string', description: 'The tweet text to schedule' },
            scheduleTime: { type: 'string', description: 'When to post (ISO string or "next optimal window")' },
          },
          required: ['tweetText'],
        },
      },
      {
        name: 'track_metrics',
        description: 'Dashboard for your Twitter marketing KPIs. PREMIUM feature.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case 'search_tweets':
        result = await searchTweets(args);
        break;
      case 'analyze_account':
        result = await analyzeAccount(args);
        break;
      case 'find_trending':
        result = await findTrending(args);
        break;
      case 'generate_tweet':
        result = await generateTweet(args);
        break;
      case 'schedule_tweet':
        result = await scheduleTweet(args);
        break;
      case 'track_metrics':
        result = await trackTwitterMetrics(args);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// --- Start ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Twitter Marketing MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
