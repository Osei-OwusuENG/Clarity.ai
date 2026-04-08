# Clarity

Clarity is an open-source browser extension that turns highlighted text into fast, context-aware explanations.

It keeps the reading flow intact: highlight text, press a shortcut, and get an explanation in place. The backend is self-hosted from this repo, so each user can supply their own Gemini API key in a local `.env` file.

## Features

- Explains highlighted words, phrases, and passages in plain language
- Uses nearby page context to make explanations more accurate
- Includes `Explain like I'm 12` and `Explain deeply` modes
- Supports copyable results and a context-menu flow for PDFs/browser documents
- Runs against a local or self-hosted backend URL instead of a fixed hosted service

## Quick start

1. Copy `.env.example` to `.env`.
2. Add your Gemini key to `GEMINI_API_KEY`.
3. Start the backend with `npm run dev`.
4. Load this folder as an unpacked Chrome extension.
5. Open the extension settings page and keep the backend URL at `http://localhost:3000` unless you deployed it elsewhere.
6. Highlight text on any page and trigger Clarity with your configured shortcut.

## Project structure

- `server.js`: local backend runner for `/api/explain` and `/api/health`
- `background.js`: extension service worker and backend request layer
- `content.js`: text selection handling, popup UI, and shortcut flow
- `styles.css`: popup styling
- `options.html`, `options.js`, `options.css`: extension settings
- `result.html`, `result.js`, `result.css`: standalone explanation view for context-menu flows
- `api/explain.js`: explanation endpoint
- `api/health.js`: health endpoint

## Configuration

- `GEMINI_API_KEY`: required
- `GEMINI_MODEL`: optional, defaults to `gemini-2.5-flash`
- `PORT`: optional, defaults to `3000`
- `ALLOWED_EXTENSION_ORIGINS`: optional comma-separated allowlist of extension origins
- `CLARITY_LOG_PROMPT_METRICS`: optional debug logging flag

If `ALLOWED_EXTENSION_ORIGINS` is empty, the backend accepts requests from any origin. For a tighter setup, set it to your unpacked or published extension origin, for example `chrome-extension://YOUR_EXTENSION_ID`.

## Notes

- Normal webpages provide the best context quality.
- Native browser PDF viewers can expose less surrounding context than regular pages.
- After changing extension files, reload the extension and refresh open tabs.
- Deployment and self-hosting notes are in `DEPLOY.md`.
