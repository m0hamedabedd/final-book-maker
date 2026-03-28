# Playlist to Book

Convert a YouTube playlist into a downloadable LaTeX book package. The app fetches playlist metadata and transcripts, rewrites each transcript into a chapter, converts the result to LaTeX, and downloads everything as a ZIP.

## Stack

- React 19
- TypeScript
- Vite 7
- Tailwind CSS 4
- Vercel Functions for secret-bearing API calls

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

- `SUPADATA_API_KEY`
- `GEMINI_API_KEY`
- `GEMINI_MODEL` (optional, defaults to the current project model)

4. Start the app:

```bash
npm run dev
```

## GitHub-ready changes in this repo

- Secrets were removed from the frontend source.
- API calls that require credentials now go through server-side Vercel Functions under `api/`.
- Build output, dependencies, Vercel metadata, and local env files are ignored via `.gitignore`.
- The project uses `package-lock.json` as the single lockfile for deployment.

## Vercel deployment

1. Push this repo to GitHub.
2. Import the repository into Vercel.
3. Add these Project Environment Variables in Vercel:

- `SUPADATA_API_KEY`
- `GEMINI_API_KEY`
- `GEMINI_MODEL` (optional)

4. Deploy.

This repo includes `vercel.json` with:

- `outputDirectory: "dist"` for the Vite build output
- function duration settings for the proxy endpoints

## Commands

```bash
npm run typecheck
npm run build
npm run preview
```

## Architecture note

The original app called Supadata and Gemini directly from the browser. That is not safe for a public GitHub repo or Vercel deployment because client-side secrets are exposed. The current setup keeps those keys on the server side, but the app remains frontend-driven and still returns the generated ZIP in the browser.

## Docs

- Vercel Vite framework docs: https://vercel.com/docs/frameworks/frontend/vite
- Vercel project config docs: https://vercel.com/docs/project-configuration/vercel-json
