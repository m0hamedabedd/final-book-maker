# Vercel Deployment Guide

## Quick Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=YOUR_GITHUB_REPO_URL)

## Prerequisites

- A Vercel account (free tier is sufficient)
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/)
- Your code pushed to a Git repository (GitHub, GitLab, or Bitbucket)

## Step-by-Step Deployment

### 1. Connect Your Repository

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Click **"Add New..."** → **"Project"**
3. Import your Git repository
4. Vercel will auto-detect the project settings

### 2. Configure Environment Variables

In the Vercel project settings, add the following environment variables:

**Required:**
- `GEMINI_API_KEY` - Your Gemini API key from Google AI Studio

**Optional:**
- `GEMINI_MODEL` - The Gemini model to use (default: `gemini-2.0-flash-lite`)
- `GEMINI_BASE_URL` - Custom Gemini API endpoint (default: `https://generativelanguage.googleapis.com/v1beta`)

**How to add environment variables:**
1. Go to your Vercel project dashboard
2. Navigate to **Settings** → **Environment Variables**
3. Add each variable for **Production**, **Preview**, and **Development** environments
4. Click **Save**

### 3. Deploy

Vercel will automatically deploy when you push to your main branch. You can also manually trigger a deployment from the Vercel dashboard.

**Deployment URL:** `https://your-project-name.vercel.app`

## Project Structure

```
final book maker/
├── api/                      # Serverless functions
│   ├── _lib/
│   │   └── vercel.ts        # TypeScript API utilities
│   ├── playlist.py          # YouTube playlist fetcher (Python)
│   ├── video.py             # YouTube video metadata (Python)
│   ├── transcript.py        # YouTube transcript fetcher (Python)
│   ├── rewrite.ts           # Gemini AI proxy (TypeScript)
│   └── requirements.txt     # Python dependencies
├── src/                      # React frontend
├── dist/                     # Build output (auto-generated)
├── vercel.json               # Vercel configuration
└── .env.example              # Environment variables template
```

## How It Works

### Frontend
- React + Vite application that builds to a single `index.html` file
- Deployed as static files on Vercel's CDN
- Client-side routing with SPA fallbacks

### Backend (Serverless Functions)
Vercel automatically deploys files in the `api/` directory as serverless functions:

- **`api/playlist.py`** - Fetches YouTube playlist videos using pytubefix
- **`api/video.py`** - Gets video metadata (title, author, duration)
- **`api/transcript.py`** - Extracts transcripts using youtube-transcript-api
- **`api/rewrite.ts`** - Proxies requests to Gemini API with your API key

### API Routes
- `GET /api/playlist?id=PLAYLIST_ID` - Get playlist videos
- `GET /api/video?id=VIDEO_ID` - Get video metadata
- `GET /api/transcript?videoId=VIDEO_ID` - Get video transcript
- `POST /api/rewrite` - Send text to Gemini for processing

## Local Development

### Frontend
```bash
npm install
npm run dev
```

### Backend (Python API)
```bash
pip install -r api/requirements.txt
python api_dev_server.py
```

The Vite dev server proxies `/api/*` requests to the Python dev server automatically.

### Build
```bash
npm run build
```

## Important Notes

### ⚠️ Security
- **NEVER** commit your `.env` or `.env.local` files to Git
- The `.env.example` file is provided as a template with placeholder values
- Your `GEMINI_API_KEY` is sensitive - keep it secure in Vercel's environment variables

### ⚠️ YouTube API Limits
- The YouTube transcript and playlist functions rely on YouTube's public APIs
- Rate limits may apply - the code includes retry logic with exponential backoff
- Some videos may not have transcripts available

### ⚠️ Gemini API Costs
- Gemini API usage may incur costs depending on your Google AI Studio plan
- The free tier provides sufficient quota for moderate usage
- Monitor your usage at [Google AI Studio](https://aistudio.google.com/)

### ⚠️ Serverless Function Limits
- Python functions have a maximum duration of 30 seconds
- TypeScript rewrite function has a maximum duration of 60 seconds
- Vercel's free tier has limitations on serverless function execution time and memory

## Troubleshooting

### Build Fails
- Ensure all dependencies are in `package.json`
- Run `npm run build` locally first to catch any errors
- Check that TypeScript compiles without errors

### API Functions Not Working
- Verify environment variables are set in Vercel
- Check Vercel function logs in the dashboard
- Ensure `api/requirements.txt` exists for Python dependencies

### "Missing GEMINI_API_KEY" Error
- Add the `GEMINI_API_KEY` environment variable in Vercel settings
- Redeploy after adding environment variables (they don't apply to existing deployments)

## Custom Domain

1. Go to your Vercel project **Settings**
2. Navigate to **Domains**
3. Add your custom domain
4. Update DNS records as instructed by Vercel

## Monitoring

- Use Vercel's built-in analytics to monitor deployments
- Check serverless function logs in the Vercel dashboard
- Monitor Gemini API usage at Google AI Studio

## Support

For issues related to:
- **Vercel deployment**: Check [Vercel Documentation](https://vercel.com/docs)
- **Gemini API**: Check [Google AI Studio Documentation](https://ai.google.dev/)
- **YouTube APIs**: The code uses public APIs via pytubefix and youtube-transcript-api
