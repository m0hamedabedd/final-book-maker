# Project Details

## Current architecture

This project is now structured for a public GitHub repository and Vercel deployment:

- the React app stays in `src/`
- secret-bearing upstream calls are proxied through Vercel Functions in `api/`
- local and hosted configuration comes from environment variables instead of committed keys

## Runtime flow

1. The browser UI collects playlist and book metadata.
2. The frontend calls internal endpoints:
   - `GET /api/playlist`
   - `GET /api/video`
   - `GET /api/transcript`
   - `POST /api/rewrite`
3. Those endpoints call Supadata and Gemini with server-side environment variables.
4. The frontend converts Markdown to LaTeX locally and packages the ZIP in the browser.

## Required environment variables

- `SUPADATA_API_KEY`
- `GEMINI_API_KEY`
- `GEMINI_MODEL` (optional)

Optional overrides:

- `SUPADATA_BASE_URL`
- `GEMINI_BASE_URL`

## Deployment notes

- Vercel output is configured in `vercel.json`.
- Function durations are increased for the rewrite endpoint because it is the longest-running call.
- The repo is set up to use `package-lock.json` as the single deployment lockfile.

## Remaining product caveat

Secrets are no longer committed or exposed directly in source control, but the app still depends on external APIs for playlist data, transcripts, and chapter rewriting. Operational limits from Supadata and Gemini still apply.
