# Clarity Self-Hosting Guide

## Local setup

1. Copy `.env.example` to `.env`.
2. Set `GEMINI_API_KEY=your_real_gemini_key`.
3. Optionally set:
   - `GEMINI_MODEL=gemini-2.5-flash`
   - `PORT=3000`
   - `ALLOWED_EXTENSION_ORIGINS=chrome-extension://YOUR_EXTENSION_ID`
   - `CLARITY_LOG_PROMPT_METRICS=false`
4. Start the backend with `npm run dev`.
5. Verify the backend with `http://localhost:3000/api/health`.
6. Load the extension unpacked and keep the backend URL in settings at `http://localhost:3000`.

## Optional deployment

You can deploy the backend anywhere that can run Node 18+ and expose:

- `GET /api/health`
- `POST /api/explain`

After deploying:

1. Open the Clarity settings page.
2. Set the backend URL to your deployed base URL.
3. Save settings.
4. Use `Test backend` to confirm the extension can reach `/api/health`.

## Packaging notes

The extension and backend are intentionally separate.

Files to include in the extension package:

- `manifest.json`
- `background.js`
- `content.js`
- `styles.css`
- `options.html`
- `options.css`
- `options.js`
- `result.html`
- `result.css`
- `result.js`
- `icons/icon16.png`
- `icons/icon32.png`
- `icons/icon48.png`
- `icons/icon128.png`

Files not to publish with the extension package:

- `.env`
- `.env.example`
- `api/`
- `server.js`
- `package.json`
- `package-lock.json`

## Hardening

- Leave `ALLOWED_EXTENSION_ORIGINS` blank for quick local use.
- Set `ALLOWED_EXTENSION_ORIGINS` before sharing or deploying the backend publicly.
- Keep `.env` private. Users should create their own local copy with their own key.

## Verification checklist

1. `GET /api/health` returns `ok: true`.
2. The settings page can reach the backend with `Test backend`.
3. Normal explanation works.
4. `Explain like I'm 12` works.
5. `Explain deeply` works.
6. Copy works in popup and result views.
7. Oversized-selection and backend-error states render cleanly.
