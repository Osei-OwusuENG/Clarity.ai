# Clarity.AI

Clarity.AI is an open-source browser extension for understanding what you read without breaking flow.

Highlight a word, phrase, or passage, press your shortcut, and get a clear explanation in context. Direct mode works inside the extension with your own API key, and you can choose either Google Gemini or any OpenAI-compatible API. A self-hosted backend is still available if you prefer to keep keys out of the extension.

![Clarity.AI explaining highlighted text in context](images/clarity-ai-screenshot.jpeg)

First public version.

## Why Clarity.AI

- In-place explanations instead of tab switching
- Context-aware responses that use nearby page content
- Direct mode with Gemini or OpenAI-compatible APIs
- Optional self-hosted backend for users who prefer keeping keys out of the extension
- Open-source codebase with no fixed hosted dependency

## Features

- Explains highlighted words, phrases, and passages in plain language
- Uses nearby page context to make explanations more accurate
- Includes `Explain like I'm 12` and `Explain deeply` modes
- Supports copyable results and an in-tab context-menu popup for PDFs/browser documents, with a result-page fallback when needed
- Redirects direct `.pdf` navigations into an extension-owned PDF viewer so text selection and the Clarity shortcut work inside supported PDFs
- Works in direct mode or with an optional self-hosted backend

## Install

1. Download ZIP.
2. Extract it.
3. Open `chrome://extensions`.
4. Enable `Developer mode`.
5. Click `Load unpacked`.
6. Select the folder.

## Setup

1. Load the extension.
2. Open the extension settings.
3. Keep `Direct mode` selected unless you want to use a backend.
4. Choose `Google Gemini` or `OpenAI-compatible`.
5. Add your API key.
6. Add a model name.
7. If you chose `OpenAI-compatible`, also add the provider base URL.
8. Save.
9. Highlight text on any page and trigger Clarity.AI with your configured shortcut.

## Optional backend mode

If you prefer not to store the API key in the extension, Clarity.AI can also talk to a self-hosted backend from this repo:

1. Copy `.env.example` to `.env`.
2. Set `AI_PROVIDER=gemini` or `AI_PROVIDER=openai-compatible`.
3. Add `AI_API_KEY`.
4. Add `AI_MODEL` if your provider needs an explicit model name.
5. If you chose `openai-compatible`, set `AI_BASE_URL`.
6. Start the backend with `npm run dev`.
7. In the settings page, switch to `Self-hosted backend`.
8. Use `http://localhost:3000` as the backend URL.

Legacy backend envs `GEMINI_API_KEY` and `GEMINI_MODEL` are still supported for Gemini-only setups.

## Development checks

- Run `npm run check` to syntax-check the extension and backend files.
- Run `npm run dev` only if you want backend mode.
- Reload the unpacked extension after changing files under `src/extension`.

## Project structure

- `manifest.json`: extension manifest kept at the repo root so the whole repo can be loaded unpacked in Chrome
- `src/extension/`: extension runtime, settings pages, result pages, styling, and icons
- `src/extension/pdfjs/`: vendored PDF.js viewer assets used for the custom in-extension PDF reader
- `src/backend/server.js`: local backend entry point
- `src/backend/api/`: backend endpoints for `/api/explain` and `/api/health`
- `README.md` and `DEPLOY.md`: primary project documentation

## Configuration

- `AI_PROVIDER`: backend mode only; `gemini` or `openai-compatible`
- `AI_API_KEY`: backend mode only; provider API key
- `AI_MODEL`: backend mode only; provider model name
- `AI_BASE_URL`: backend mode only; base URL for OpenAI-compatible providers
- `PORT`: backend mode only; local backend port, usually `3000`
- `ALLOWED_EXTENSION_ORIGINS`: backend mode only; optional comma-separated allowlist such as `chrome-extension://YOUR_EXTENSION_ID`
- `CLARITY_LOG_PROMPT_METRICS`: backend mode only; optional debug flag; use `true` to enable or `false` or blank to disable
- `CLARITY_REQUEST_TIMEOUT_MS`: backend mode only; optional timeout override in milliseconds

Compatibility notes:

- `GEMINI_API_KEY` and `GEMINI_MODEL` still work as Gemini fallbacks in backend mode.
- `OPENAI_API_KEY`, `OPENAI_MODEL`, and `OPENAI_BASE_URL` are also accepted in backend mode for OpenAI-compatible setups.
- `XAI_API_KEY`, `XAI_MODEL`, and `XAI_BASE_URL` are also accepted in backend mode for Grok or other xAI setups.
- Grok reasoning models get a longer backend timeout by default, and `CLARITY_REQUEST_TIMEOUT_MS` can override it if needed.
- Direct mode stores the API key in extension storage. Backend mode keeps the key on your server instead.

If `ALLOWED_EXTENSION_ORIGINS` is empty, the backend accepts requests from any origin. For a tighter setup, set it to your unpacked or published extension origin, for example `chrome-extension://YOUR_EXTENSION_ID`.

## License

This project is released under the GNU General Public License v3.0. See `LICENSE`.

## Notes

- Normal webpages provide the best context quality.
- Direct `.pdf` URLs are redirected into Clarity.AI's bundled PDF viewer so selection and shortcuts can work there.
- Local `file:///...pdf` files can also be redirected into the bundled viewer, but Chrome requires `Allow access to file URLs` to be enabled on the extension details page.
- PDFs served from non-`.pdf` URLs may still need the context-menu flow, because Chrome does not expose response-header based PDF detection to this extension in a reliable redirect hook.
- Deployment and self-hosting notes are in `DEPLOY.md`.
