# Self-Hosting Clarity.AI

Most people do not need a backend. Clarity.AI works out of the box in direct mode, which is the simplest setup.

Use the backend only if you want the API key to live on a server instead of inside the extension, or if you want tighter control over which extension origins can call it.

## Run it locally

1. Copy `.env.example` to `.env`.
2. Choose a provider:

   `AI_PROVIDER=gemini`

   or

   `AI_PROVIDER=xai`

   or

   `AI_PROVIDER=openai-compatible`

3. Add your API key:

   `AI_API_KEY=your_real_key`

4. Add a model if needed:

   `AI_MODEL=your_provider_model`

5. If you chose `xai`, the default base URL is `https://api.x.ai/v1`. If you chose `openai-compatible`, also add a base URL:

   `AI_BASE_URL=https://api.openai.com/v1`

6. Optionally change the other settings in `.env`:

   `PORT=3000`

   `ALLOWED_EXTENSION_ORIGINS=chrome-extension://YOUR_EXTENSION_ID`

   `CLARITY_LOG_PROMPT_METRICS=false`

7. Start the backend:

   `npm run dev`

8. Open `http://localhost:3000/api/health` and make sure it returns `ok: true`.
9. In the extension settings, switch to `Self-hosted backend`, set the backend URL to `http://localhost:3000`, save, and use `Test backend`.

Legacy Gemini envs still work:

- `GEMINI_API_KEY`
- `GEMINI_MODEL`

xAI aliases also work for Grok-style setups:

- `XAI_API_KEY`
- `XAI_MODEL`
- `XAI_BASE_URL`

If you use a Grok reasoning model, the backend now gives it a longer timeout by default. You can still force a specific timeout with:

- `CLARITY_REQUEST_TIMEOUT_MS=120000`

## Deploy it elsewhere

The backend is a small Node 18+ service. It only exposes two routes:

- `GET /api/health`
- `POST /api/explain`

If you deploy it to your own server or platform, point the extension at the deployed base URL in settings and run `Test backend` before relying on it.

## Security notes

- If `ALLOWED_EXTENSION_ORIGINS` is blank, the backend accepts requests from any origin.
- For anything beyond local testing, set `ALLOWED_EXTENSION_ORIGINS` to your actual extension ID or IDs.
- Keep `.env` private and out of version control.
- If other people are self-hosting Clarity.AI, they should create their own `.env` with their own key.

## Packaging the extension separately

If you only want to distribute the browser extension, include:

- `manifest.json`
- `src/extension/background.js`
- `src/extension/content.js`
- `src/extension/styles.css`
- `src/extension/options.html`
- `src/extension/options.css`
- `src/extension/options.js`
- `src/extension/result.html`
- `src/extension/result.css`
- `src/extension/result.js`
- `src/extension/icons/icon16.png`
- `src/extension/icons/icon32.png`
- `src/extension/icons/icon48.png`
- `src/extension/icons/icon128.png`

Do not include:

- `.env`
- `.env.example`
- `src/backend/`
- `package.json`
- `package-lock.json`

## Quick sanity check

Before sharing a self-hosted setup, make sure:

- `/api/health` responds
- `Test backend` succeeds in the settings page
- a normal explanation works
- `Explain like I'm 12` works
- `Explain deeply` works
- backend errors show clear messages
