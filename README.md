# Playlist to Book

Convert a YouTube playlist into a downloadable LaTeX book package. The app fetches playlist metadata and transcripts, rewrites each transcript into a chapter, converts the result to LaTeX, and downloads everything as a ZIP.

## Stack

- React 19
- TypeScript
- Vite 7
- Tailwind CSS 4
- Vercel Functions for secret-bearing API calls

## Quick Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=YOUR_GITHUB_REPO_URL)

See [DEPLOYMENT.md](./DEPLOYMENT.md) for complete deployment instructions.

## Local setup

1. Install dependencies:

```bash
npm install
```

2. Create a local env file:

```bash
cp .env.example .env.local
```

3. Set these variables in `.env.local`:

- `GEMINI_API_KEY` - Your Gemini API key from [Google AI Studio](https://aistudio.google.com/)
- `GEMINI_MODEL` (optional, defaults to `gemini-2.0-flash-lite`)

4. Start the Python API dev server (in a separate terminal):

```bash
pip install -r api/requirements.txt
python api_dev_server.py
```

5. Start the Vite dev app (in another terminal):

```bash
npm run dev
```

The Vite dev server will proxy `/api/*` requests to the Python dev server automatically.

## GitHub-ready changes in this repo

- Secrets were removed from the frontend source.
- API calls that require credentials now go through server-side Vercel Functions under `api/`.
- Build output, dependencies, Vercel metadata, and local env files are ignored via `.gitignore`.
- The project uses `package-lock.json` as the single lockfile for deployment.
- Python API files moved to `api/` directory for Vercel serverless function compatibility.

## Vercel deployment

1. Push this repo to GitHub.
2. Import the repository into Vercel.
3. Add these Project Environment Variables in Vercel:

- `GEMINI_API_KEY` (required)
- `GEMINI_MODEL` (optional, defaults to `gemini-2.0-flash-lite`)

4. Deploy.

This repo includes `vercel.json` with:

- `outputDirectory: "dist"` for the Vite build output
- SPA rewrites for client-side routing
- Function duration settings for the proxy endpoints
- Python 3.12 runtime configuration for API functions

## Commands

```bash
npm run typecheck    # Type check TypeScript
npm run build        # Build for production
npm run preview      # Preview production build
npm run dev          # Start development server
```

## Architecture note

The original app called Supadata and Gemini directly from the browser. That is not safe for a public GitHub repo or Vercel deployment because client-side secrets are exposed. The current setup keeps those keys on the server side using Vercel serverless functions, but the app remains frontend-driven and still returns the generated ZIP in the browser.

## API Routes

- `GET /api/playlist?id=PLAYLIST_ID` - Get playlist videos
- `GET /api/video?id=VIDEO_ID` - Get video metadata
- `GET /api/transcript?videoId=VIDEO_ID` - Get video transcript
- `POST /api/rewrite` - Proxy to Gemini API

## Docs

- [Deployment Guide](./DEPLOYMENT.md)
- Vercel Vite framework docs: https://vercel.com/docs/frameworks/frontend/vite
- Vercel project config docs: https://vercel.com/docs/project-configuration/vercel-json
