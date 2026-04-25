const CONNECTION_MODE_DIRECT = "direct";
const CONNECTION_MODE_BACKEND = "backend";
const VALID_CONNECTION_MODES = new Set([CONNECTION_MODE_DIRECT, CONNECTION_MODE_BACKEND]);

const CONNECTION_MODE_STORAGE_KEY = "connectionMode";
const BACKEND_URL_STORAGE_KEY = "backendBaseUrl";
const DIRECT_PROVIDER_STORAGE_KEY = "directProvider";
const DIRECT_MODEL_STORAGE_KEY = "directModel";
const DIRECT_API_KEY_STORAGE_KEY = "directApiKey";
const DIRECT_BASE_URL_STORAGE_KEY = "directBaseUrl";
const LEGACY_DIRECT_GEMINI_MODEL_STORAGE_KEY = "directGeminiModel";
const LEGACY_DIRECT_GEMINI_API_KEY_STORAGE_KEY = "directGeminiApiKey";

const DEFAULT_BACKEND_BASE_URL = "http://localhost:3000";
const DIRECT_PROVIDER_GEMINI = "gemini";
const DIRECT_PROVIDER_OPENAI_COMPATIBLE = "openai-compatible";
const DIRECT_PROVIDER_XAI = "xai";
const VALID_DIRECT_PROVIDERS = new Set([
  DIRECT_PROVIDER_GEMINI,
  DIRECT_PROVIDER_OPENAI_COMPATIBLE,
  DIRECT_PROVIDER_XAI,
]);
const DEFAULT_DIRECT_PROVIDER = DIRECT_PROVIDER_GEMINI;
const DEFAULT_DIRECT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_DIRECT_OPENAI_COMPATIBLE_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_DIRECT_XAI_BASE_URL = "https://api.x.ai/v1";
const DIRECT_SYSTEM_INSTRUCTION = [
  "You are Clarity.AI, a helpful learning assistant.",
  "Explain highlighted text clearly, naturally, and in plain English.",
  "Focus on what the text means and what it means in the context provided.",
  "Be specific and easy to follow.",
  "Never mention prompts, JSON, field names, or formatting instructions.",
].join("\n");

const EXPLAIN_ENDPOINT_PATH = "/api/explain";
const MAX_SELECTION_LENGTH = 1500;
const MAX_CONTEXT_LENGTH = 420;
const CACHE_LIMIT = 60;
const CONTEXT_MENU_ID = "clarity-explain-selection";
const PDF_VIEWER_PAGE_PATH = "src/extension/pdfjs/web/viewer.html";
const RESULT_STORAGE_PREFIX = "clarity-result:";
const CACHE_SCHEMA_VERSION = "v24";
const LOCAL_CACHE_PREFIX = `clarity-backend-cache:${CACHE_SCHEMA_VERSION}:`;
const LOCAL_CACHE_INDEX_KEY = `clarity-backend-cache-index:${CACHE_SCHEMA_VERSION}`;
const LOCAL_CACHE_LIMIT = 240;
const LOCAL_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const DEFAULT_MODE = "default";
const ELI12_MODE = "eli12";
const DEEP_MODE = "deep";
const VALID_EXPLANATION_MODES = new Set([DEFAULT_MODE, ELI12_MODE, DEEP_MODE]);

const explanationCache = new Map();

chrome.runtime.onInstalled.addListener(() => {
  void ensureContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureContextMenu();
});

if (chrome.webNavigation?.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    void maybeOpenPdfInClarityViewer(details);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === "GET_EXPLANATION") {
    (async () => {
      try {
        const explanation = await handleExplanationRequest(message);
        sendResponse({ ok: true, explanation });
      } catch (error) {
        console.error("Clarity.AI explanation error:", error);
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();

    return true;
  }

  if (message?.action === "TEST_CONNECTION") {
    (async () => {
      try {
        const result = await testConnection(message?.settings);
        sendResponse({ ok: true, result });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();

    return true;
  }

  if (message?.action === "OPEN_OPTIONS") {
    (async () => {
      try {
        await openOptionsPage();
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();

    return true;
  }

  return false;
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) {
    return;
  }

  void handleContextMenuSelection(info.selectionText, tab?.id);
});

async function handleExplanationRequest(requestInput) {
  const request = normalizeExplanationRequest(requestInput);
  const { selection } = request;

  if (!selection.text) {
    throw new Error("Select some text first.");
  }

  if (selection.text.length > MAX_SELECTION_LENGTH) {
    throw new Error(`Select a shorter passage (${MAX_SELECTION_LENGTH} characters max).`);
  }

  const connectionSettings = await getStoredConnectionSettings();
  const connectionError = getConnectionValidationError(connectionSettings);

  if (connectionError) {
    throw new Error(connectionError);
  }

  const cacheSignature = getRequestCacheSignature(request, getTransportSignature(connectionSettings));

  if (explanationCache.has(cacheSignature)) {
    return explanationCache.get(cacheSignature);
  }

  const cachedExplanation = await getPersistentCachedExplanation(cacheSignature);

  if (cachedExplanation) {
    explanationCache.set(cacheSignature, cachedExplanation);
    trimCache(explanationCache, CACHE_LIMIT);
    return cachedExplanation;
  }

  const explanation = await requestExplanationWithConfiguredConnection(request, connectionSettings);
  explanationCache.set(cacheSignature, explanation);
  trimCache(explanationCache, CACHE_LIMIT);
  await persistCachedExplanation(cacheSignature, explanation);
  return explanation;
}

async function requestExplanationWithConfiguredConnection(request, connectionSettings) {
  if (connectionSettings.connectionMode === CONNECTION_MODE_DIRECT) {
    return isOpenAICompatibleDirectProvider(connectionSettings.directProvider)
      ? requestDirectOpenAICompatibleExplanation(request, connectionSettings)
      : requestDirectGeminiExplanation(request, connectionSettings);
  }

  return requestBackendExplanation(request, connectionSettings.backendBaseUrl);
}

async function requestBackendExplanation(request, backendBaseUrl) {
  let response;

  try {
    response = await fetch(getBackendUrl(backendBaseUrl, EXPLAIN_ENDPOINT_PATH), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        selection: request.selection,
        mode: request.mode,
        sourceExplanation: request.sourceExplanation || undefined,
      }),
    });
  } catch (error) {
    throw new Error("Clarity.AI could not reach the backend. Check the backend URL and make sure the server is running.");
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const normalizedError = normalizeBackendError(response.status, data?.error);
    console.warn("Clarity.AI backend error:", normalizedError.debug);
    throw new Error(normalizedError.userMessage);
  }

  const explanation = sanitizeExplanation(data?.explanation, request.mode);

  if (!explanation?.definition) {
    throw new Error("Clarity.AI could not generate an explanation right now. Please try again.");
  }

  return explanation;
}

async function requestDirectGeminiExplanation(request, connectionSettings) {
  let response;

  try {
    response = await fetch(getDirectGeminiEndpoint(connectionSettings.directGeminiModel), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": connectionSettings.directGeminiApiKey,
      },
      body: JSON.stringify(buildDirectGeminiRequestBody(request)),
    });
  } catch (error) {
    throw new Error("Clarity.AI could not reach Gemini. Check your internet connection and API key.");
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.warn("Clarity.AI Gemini error:", {
      status: response.status,
      error: data?.error || null,
      model: connectionSettings.directGeminiModel,
    });
    throw new Error(normalizeDirectGeminiError(response.status, data?.error));
  }

  const explanation = extractExplanationFromGeminiResponse(data, request);
  return explanation?.definition ? explanation : buildDirectFallbackExplanation(request);
}

async function requestDirectOpenAICompatibleExplanation(request, connectionSettings) {
  let response;

  try {
    response = await fetch(getDirectOpenAICompatibleEndpoint(connectionSettings.directBaseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${connectionSettings.directApiKey}`,
      },
      body: JSON.stringify(buildDirectOpenAICompatibleRequestBody(request, connectionSettings.directModel)),
    });
  } catch (error) {
    throw new Error(
      "Clarity.AI could not reach the OpenAI-compatible endpoint. Check the base URL, internet connection, and API key."
    );
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.warn("Clarity.AI OpenAI-compatible error:", {
      status: response.status,
      error: data?.error || null,
      model: connectionSettings.directModel,
      baseUrl: connectionSettings.directBaseUrl,
    });
    throw new Error(normalizeDirectOpenAICompatibleError(response.status, data?.error || data));
  }

  const explanation = extractExplanationFromOpenAICompatibleResponse(data, request);
  return explanation?.definition ? explanation : buildDirectFallbackExplanation(request);
}

async function testConnection(inputSettings) {
  const connectionSettings = inputSettings
    ? normalizeConnectionSettings(inputSettings)
    : await getStoredConnectionSettings();
  const connectionError = getConnectionValidationError(connectionSettings);

  if (connectionError) {
    throw new Error(connectionError);
  }

  if (connectionSettings.connectionMode === CONNECTION_MODE_DIRECT) {
    if (isOpenAICompatibleDirectProvider(connectionSettings.directProvider)) {
      await testDirectOpenAICompatibleConnection(connectionSettings);
    } else {
      await testDirectGeminiConnection(connectionSettings);
    }

    return {
      state: "success",
      message: `${formatDirectProviderLabel(connectionSettings.directProvider)} is reachable. Model: ${connectionSettings.directModel}.`,
    };
  }

  return testBackendConnection(connectionSettings.backendBaseUrl);
}

async function testDirectGeminiConnection(connectionSettings) {
  let response;

  try {
    response = await fetch(getDirectGeminiEndpoint(connectionSettings.directGeminiModel), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": connectionSettings.directGeminiApiKey,
      },
      body: JSON.stringify(buildDirectGeminiTestRequestBody()),
    });
  } catch (error) {
    throw new Error("Clarity.AI could not reach Gemini. Check your internet connection and API key.");
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.warn("Clarity.AI Gemini test error:", {
      status: response.status,
      error: data?.error || null,
      model: connectionSettings.directGeminiModel,
    });
    throw new Error(normalizeDirectGeminiError(response.status, data?.error));
  }

  return data;
}

async function testDirectOpenAICompatibleConnection(connectionSettings) {
  let response;

  try {
    response = await fetch(getDirectOpenAICompatibleEndpoint(connectionSettings.directBaseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${connectionSettings.directApiKey}`,
      },
      body: JSON.stringify(buildDirectOpenAICompatibleTestRequestBody(connectionSettings.directModel)),
    });
  } catch (error) {
    throw new Error(
      "Clarity.AI could not reach the OpenAI-compatible endpoint. Check the base URL, internet connection, and API key."
    );
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.warn("Clarity.AI OpenAI-compatible test error:", {
      status: response.status,
      error: data?.error || null,
      model: connectionSettings.directModel,
      baseUrl: connectionSettings.directBaseUrl,
    });
    throw new Error(normalizeDirectOpenAICompatibleError(response.status, data?.error || data));
  }

  return data;
}

async function testBackendConnection(backendBaseUrl) {
  let response;

  try {
    response = await fetch(getBackendUrl(backendBaseUrl, "/api/health"));
  } catch (error) {
    throw new Error("Could not reach /api/health at that backend URL.");
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data?.ok) {
    throw new Error("The backend health check failed.");
  }

  if (!data.ready || !data.hasApiKey) {
    throw new Error(data.configurationMessage || "Backend is reachable, but the AI provider is not configured.");
  }

  return {
    state: "success",
    message: `Backend is reachable. Provider: ${data.providerLabel || formatDirectProviderLabel(data.provider)}. Model: ${data.model}.`,
  };
}

async function handleContextMenuSelection(selectionText, tabId) {
  const { selection, anchorPoint } = await resolveContextMenuSelection(selectionText, tabId);

  if (!selection.text) {
    const payload = {
      selection,
      selectedText: "",
      error: "No selected text was provided by the browser.",
      source: "context-menu",
      anchorPoint,
    };

    if (await showContextMenuResultInTab(tabId, payload)) {
      return;
    }

    await openResultPage(payload);
    return;
  }

  try {
    const explanation = await handleExplanationRequest({
      action: "GET_EXPLANATION",
      selection,
      mode: DEFAULT_MODE,
    });

    const payload = {
      selection,
      selectedText: selection.text,
      explanation,
      source: "context-menu",
      anchorPoint,
    };

    if (await showContextMenuResultInTab(tabId, payload)) {
      return;
    }

    await openResultPage(payload);
  } catch (error) {
    const payload = {
      selection,
      selectedText: selection.text,
      error: error.message,
      source: "context-menu",
      anchorPoint,
    };

    if (await showContextMenuResultInTab(tabId, payload)) {
      return;
    }

    await openResultPage(payload);
  }
}

async function resolveContextMenuSelection(selectionText, tabId) {
  const fallbackSelection = normalizeSelection(selectionText);

  if (!tabId) {
    return {
      selection: fallbackSelection,
      anchorPoint: null,
    };
  }

  try {
    const contextPayload = await requestSelectionContextFromTab(tabId);
    const contextSelection = contextPayload?.selection || contextPayload;
    const anchorPoint = normalizeAnchorPoint(contextPayload?.anchorPoint);

    if (
      contextSelection?.text &&
      normalizeSelectionText(contextSelection.text) === fallbackSelection.text
    ) {
      return {
        selection: normalizeSelection(contextSelection),
        anchorPoint,
      };
    }

    return {
      selection: fallbackSelection,
      anchorPoint,
    };
  } catch (error) {
    console.warn("Clarity.AI could not read page selection context:", error);
  }

  return {
    selection: fallbackSelection,
    anchorPoint: null,
  };
}

function requestSelectionContextFromTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { action: "GET_SELECTION_CONTEXT" }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!response?.ok) {
        resolve(null);
        return;
      }

      resolve({
        selection: response.selection || null,
        anchorPoint: response.anchorPoint || null,
      });
    });
  });
}

async function showContextMenuResultInTab(tabId, payload) {
  if (!tabId) {
    return false;
  }

  try {
    const response = await sendMessageToTab(tabId, {
      action: "SHOW_CONTEXT_MENU_RESULT",
      selection: payload.selection,
      explanation: payload.explanation || null,
      error: payload.error || "",
      mode: payload.explanation?.mode || DEFAULT_MODE,
      anchorPoint: payload.anchorPoint || null,
    });
    return Boolean(response?.ok);
  } catch (error) {
    console.warn("Clarity.AI could not render the popup in the current tab:", error);
    return false;
  }
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response || null);
    });
  });
}

function normalizeExplanationRequest(input) {
  const mode = normalizeMode(input?.mode);
  const legacySelection = typeof input === "string" ? input : input?.text;

  return {
    selection: normalizeSelection(input?.selection || legacySelection),
    mode,
    sourceExplanation: sanitizeExplanation(input?.sourceExplanation, DEFAULT_MODE),
  };
}

function normalizeSelection(input) {
  if (typeof input === "string") {
    return {
      text: normalizeSelectionText(input),
      contextText: "",
    };
  }

  return {
    text: normalizeSelectionText(input?.text),
    contextText: normalizeContextText(input?.contextText),
    pageTitle: normalizeSelectionText(input?.pageTitle).slice(0, 140),
    hostname: normalizeSelectionText(input?.hostname).slice(0, 120),
  };
}

function normalizeContextText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, MAX_CONTEXT_LENGTH);
}

function normalizeSelectionText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizeAnchorPoint(anchorPoint) {
  if (
    Number.isFinite(anchorPoint?.x) &&
    Number.isFinite(anchorPoint?.y)
  ) {
    return {
      x: anchorPoint.x,
      y: anchorPoint.y,
    };
  }

  return null;
}

function normalizeMode(mode) {
  const normalizedMode = String(mode || DEFAULT_MODE).trim().toLowerCase();
  return VALID_EXPLANATION_MODES.has(normalizedMode) ? normalizedMode : DEFAULT_MODE;
}

function sanitizeExplanation(explanation, fallbackMode = DEFAULT_MODE) {
  if (!explanation || typeof explanation !== "object") {
    return null;
  }

  return {
    definition: normalizeSelectionText(explanation.definition),
    usage: normalizeSelectionText(explanation.usage),
    mode: normalizeMode(explanation.mode || fallbackMode),
  };
}

function normalizeBackendError(status, errorPayload) {
  const backendError =
    errorPayload && typeof errorPayload === "object"
      ? errorPayload
      : {
          message: String(errorPayload || ""),
        };

  const debug = {
    status,
    code: backendError.code || "",
    message: backendError.message || "",
    requestId: backendError.requestId || "",
  };

  if (status === 400) {
    return {
      userMessage: backendError.message || "Select a shorter or clearer highlight and try again.",
      debug,
    };
  }

  if (status === 403) {
    return {
      userMessage:
        backendError.message || "This backend rejected the extension origin. Check ALLOWED_EXTENSION_ORIGINS in .env.",
      debug,
    };
  }

  if (status === 404) {
    return {
      userMessage: "The backend URL looks wrong. Check Clarity.AI settings.",
      debug,
    };
  }

  if (status === 429) {
    return {
      userMessage: backendError.message || "The backend is busy right now. Please try again in a moment.",
      debug,
    };
  }

  return {
    userMessage: backendError.message || "Clarity.AI could not generate an explanation right now. Please try again.",
    debug,
  };
}

function normalizeDirectGeminiError(status, errorPayload) {
  const geminiError =
    errorPayload && typeof errorPayload === "object"
      ? errorPayload
      : {
          message: String(errorPayload || ""),
        };
  const message = normalizeSelectionText(geminiError.message);
  const detailsText = getGeminiErrorDetailsText(geminiError.details);
  const combinedMessage = [message, detailsText].filter(Boolean).join(" ").trim();

  if (/api key not valid|invalid api key|credential|unauthorized|permission|forbidden|referer/i.test(combinedMessage)) {
    return "Gemini rejected the API key. Open Clarity.AI settings and check it.";
  }

  if (
    /models\/[a-z0-9._-]+.*not found|model [a-z0-9._-]+.*not found|not found for api version/i.test(
      combinedMessage
    )
  ) {
    return "Gemini rejected the model name. Check the model in Clarity.AI settings.";
  }

  if (status === 400) {
    return combinedMessage || "Gemini rejected the request. Check the direct Gemini settings and try again.";
  }

  if (status === 403) {
    return "Gemini rejected the API key. Open Clarity.AI settings and check it.";
  }

  if (status === 429) {
    return "Gemini rate limits or quota were hit. Try again later or check your billing/quota.";
  }

  return combinedMessage || "Gemini could not generate an explanation right now. Please try again.";
}

function normalizeDirectOpenAICompatibleError(status, errorPayload) {
  const providerError =
    errorPayload && typeof errorPayload === "object"
      ? errorPayload
      : {
          message: String(errorPayload || ""),
        };
  const message = normalizeSelectionText(
    providerError.message || providerError.error?.message || providerError.detail || providerError.type || ""
  );
  const code = normalizeSelectionText(providerError.code || providerError.type);
  const combinedMessage = [code, message].filter(Boolean).join(" ").trim();

  if (/api key|incorrect api key|invalid api key|unauthorized|authentication|forbidden|bearer/i.test(combinedMessage)) {
    return "The provider rejected the API key. Open Clarity.AI settings and check it.";
  }

  if (/model.*not found|unknown model|invalid model|does not exist|unsupported model/i.test(combinedMessage)) {
    return "The provider rejected the model name. Check the model in Clarity.AI settings.";
  }

  if (status === 404) {
    return "The provider base URL looks wrong. Check the direct mode base URL in Clarity.AI settings.";
  }

  if (status === 429) {
    return "The provider rate limit or quota was hit. Try again later or check billing/quota.";
  }

  if (status === 400) {
    return combinedMessage || "The provider rejected the request. Check the direct settings and try again.";
  }

  return combinedMessage || "The provider could not generate an explanation right now. Please try again.";
}

function formatDirectProviderLabel(directProvider) {
  if (directProvider === DIRECT_PROVIDER_XAI) {
    return "xAI / Grok";
  }

  return directProvider === DIRECT_PROVIDER_OPENAI_COMPATIBLE ? "OpenAI-compatible provider" : "Gemini";
}

function getGeminiErrorDetailsText(details) {
  if (!Array.isArray(details) || !details.length) {
    return "";
  }

  const extractedMessages = details
    .map((detail) => {
      if (!detail || typeof detail !== "object") {
        return "";
      }

      if (typeof detail.message === "string") {
        return detail.message;
      }

      if (typeof detail.reason === "string") {
        return detail.reason;
      }

      if (Array.isArray(detail.fieldViolations)) {
        return detail.fieldViolations
          .map((violation) =>
            [violation?.field, violation?.description].filter(Boolean).join(": ")
          )
          .filter(Boolean)
          .join(" ");
      }

      if (Array.isArray(detail.violations)) {
        return detail.violations
          .map((violation) =>
            [violation?.field, violation?.description].filter(Boolean).join(": ")
          )
          .filter(Boolean)
          .join(" ");
      }

      return "";
    })
    .filter(Boolean);

  return normalizeSelectionText(extractedMessages.join(" "));
}

function getRequestCacheSignature(request, transportSignature) {
  return [
    transportSignature,
    request.mode,
    request.selection.text,
    request.selection.contextText,
    request.selection.pageTitle,
    request.selection.hostname,
    request.mode === DEFAULT_MODE ? "" : normalizeSelectionText(request.sourceExplanation?.definition),
    request.mode === DEFAULT_MODE ? "" : normalizeSelectionText(request.sourceExplanation?.usage),
  ].join("\n<context>\n");
}

function getTransportSignature(connectionSettings) {
  if (connectionSettings.connectionMode === CONNECTION_MODE_DIRECT) {
    return [
      CONNECTION_MODE_DIRECT,
      connectionSettings.directProvider,
      connectionSettings.directModel,
      isOpenAICompatibleDirectProvider(connectionSettings.directProvider) ? connectionSettings.directBaseUrl : "",
    ].join(":");
  }

  return `${CONNECTION_MODE_BACKEND}:${connectionSettings.backendBaseUrl}`;
}

function getConnectionValidationError(connectionSettings) {
  if (connectionSettings.connectionMode === CONNECTION_MODE_DIRECT) {
    if (!connectionSettings.directApiKey) {
      return "Open Clarity.AI settings and add your direct-mode API key, or switch to backend mode.";
    }

    if (!connectionSettings.directModel) {
      return getDirectModelValidationMessage(connectionSettings.directProvider);
    }

    if (
      isOpenAICompatibleDirectProvider(connectionSettings.directProvider) &&
      !connectionSettings.directBaseUrl
    ) {
      return connectionSettings.directProvider === DIRECT_PROVIDER_XAI
        ? "Open Clarity.AI settings and add the xAI base URL, https://api.x.ai/v1."
        : "Open Clarity.AI settings and add a base URL such as https://api.openai.com/v1.";
    }

    return "";
  }

  if (!connectionSettings.backendBaseUrl) {
    return "Open Clarity.AI settings and add a backend URL.";
  }

  return "";
}

async function getStoredConnectionSettings() {
  const [syncValues, localValues] = await Promise.all([
    getSyncStorageValues([
      CONNECTION_MODE_STORAGE_KEY,
      BACKEND_URL_STORAGE_KEY,
      DIRECT_PROVIDER_STORAGE_KEY,
      DIRECT_MODEL_STORAGE_KEY,
      DIRECT_BASE_URL_STORAGE_KEY,
      LEGACY_DIRECT_GEMINI_MODEL_STORAGE_KEY,
    ]),
    getLocalStorageValues([
      DIRECT_API_KEY_STORAGE_KEY,
      LEGACY_DIRECT_GEMINI_API_KEY_STORAGE_KEY,
      BACKEND_URL_STORAGE_KEY,
      CONNECTION_MODE_STORAGE_KEY,
      DIRECT_PROVIDER_STORAGE_KEY,
      DIRECT_MODEL_STORAGE_KEY,
      DIRECT_BASE_URL_STORAGE_KEY,
      LEGACY_DIRECT_GEMINI_MODEL_STORAGE_KEY,
    ]),
  ]);

  const storedDirectProvider = syncValues[DIRECT_PROVIDER_STORAGE_KEY] || localValues[DIRECT_PROVIDER_STORAGE_KEY];
  const storedDirectModel = syncValues[DIRECT_MODEL_STORAGE_KEY] || localValues[DIRECT_MODEL_STORAGE_KEY];
  const storedDirectBaseUrl = syncValues[DIRECT_BASE_URL_STORAGE_KEY] || localValues[DIRECT_BASE_URL_STORAGE_KEY];
  const storedDirectApiKey = localValues[DIRECT_API_KEY_STORAGE_KEY];
  const hasModernDirectSettings = Boolean(
    normalizeDirectProvider(storedDirectProvider) ||
      normalizeDirectModel(storedDirectModel) ||
      normalizeBackendBaseUrl(storedDirectBaseUrl) ||
      normalizeApiKey(storedDirectApiKey)
  );

  return normalizeConnectionSettings({
    connectionMode: syncValues[CONNECTION_MODE_STORAGE_KEY] || localValues[CONNECTION_MODE_STORAGE_KEY],
    backendBaseUrl: syncValues[BACKEND_URL_STORAGE_KEY] || localValues[BACKEND_URL_STORAGE_KEY],
    directProvider: hasModernDirectSettings ? storedDirectProvider : DIRECT_PROVIDER_GEMINI,
    directModel:
      storedDirectModel ||
      (!hasModernDirectSettings
        ? syncValues[LEGACY_DIRECT_GEMINI_MODEL_STORAGE_KEY] || localValues[LEGACY_DIRECT_GEMINI_MODEL_STORAGE_KEY]
        : ""),
    directBaseUrl: storedDirectBaseUrl,
    directApiKey:
      storedDirectApiKey ||
      (!hasModernDirectSettings ? localValues[LEGACY_DIRECT_GEMINI_API_KEY_STORAGE_KEY] : ""),
  });
}

function normalizeConnectionSettings(input) {
  const normalizedDirectModel = normalizeDirectModel(input?.directModel || input?.directGeminiModel);
  const normalizedDirectBaseUrl = normalizeBackendBaseUrl(input?.directBaseUrl);
  const directProvider = resolveDirectProvider(
    input?.directProvider,
    normalizedDirectModel,
    normalizedDirectBaseUrl
  );
  const directApiKey = normalizeApiKey(input?.directApiKey ?? input?.directGeminiApiKey);
  const backendBaseUrl = normalizeBackendBaseUrl(input?.backendBaseUrl);
  const connectionMode = resolveConnectionMode(
    normalizeConnectionMode(input?.connectionMode || input?.mode),
    directApiKey,
    backendBaseUrl
  );
  const directModel = normalizedDirectModel || getDefaultDirectModel(directProvider);

  return {
    connectionMode,
    directProvider,
    directApiKey,
    directModel,
    directBaseUrl: normalizedDirectBaseUrl || getDefaultDirectBaseUrl(directProvider),
    directGeminiApiKey: directApiKey,
    directGeminiModel: directModel,
    backendBaseUrl: backendBaseUrl || DEFAULT_BACKEND_BASE_URL,
  };
}

function resolveConnectionMode(explicitMode, directApiKey, backendBaseUrl) {
  if (VALID_CONNECTION_MODES.has(explicitMode)) {
    return explicitMode;
  }

  if (directApiKey) {
    return CONNECTION_MODE_DIRECT;
  }

  if (backendBaseUrl) {
    return CONNECTION_MODE_BACKEND;
  }

  return CONNECTION_MODE_DIRECT;
}

function normalizeConnectionMode(value) {
  const normalizedValue = String(value || "").trim().toLowerCase();
  return VALID_CONNECTION_MODES.has(normalizedValue) ? normalizedValue : "";
}

function normalizeDirectProvider(value) {
  const normalizedValue = String(value || "").trim().toLowerCase();
  return VALID_DIRECT_PROVIDERS.has(normalizedValue) ? normalizedValue : "";
}

function resolveDirectProvider(value, model, baseUrl) {
  const directProvider = normalizeDirectProvider(value);
  const directModel = normalizeDirectModel(model);
  const directBaseUrl = normalizeBackendBaseUrl(baseUrl);

  if (directProvider === DIRECT_PROVIDER_XAI) {
    return DIRECT_PROVIDER_XAI;
  }

  if (isGrokDirectModel(directModel)) {
    if (
      !directProvider ||
      directProvider === DIRECT_PROVIDER_GEMINI ||
      (directProvider === DIRECT_PROVIDER_OPENAI_COMPATIBLE &&
        (!directBaseUrl || directBaseUrl === DEFAULT_DIRECT_OPENAI_COMPATIBLE_BASE_URL))
    ) {
      return DIRECT_PROVIDER_XAI;
    }
  }

  if (
    isXaiBaseUrl(directBaseUrl) &&
    (!directProvider || directProvider === DIRECT_PROVIDER_OPENAI_COMPATIBLE)
  ) {
    return DIRECT_PROVIDER_XAI;
  }

  return directProvider || DEFAULT_DIRECT_PROVIDER;
}

function normalizeBackendBaseUrl(value) {
  const normalizedValue = String(value || "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(normalizedValue) ? normalizedValue : "";
}

function normalizeDirectModel(value) {
  const normalizedValue = String(value || "").trim();
  return /^[^\s]{1,120}$/i.test(normalizedValue) ? normalizedValue : "";
}

function getDefaultDirectModel(directProvider) {
  return directProvider === DIRECT_PROVIDER_GEMINI ? DEFAULT_DIRECT_GEMINI_MODEL : "";
}

function getDefaultDirectBaseUrl(directProvider) {
  return directProvider === DIRECT_PROVIDER_XAI
    ? DEFAULT_DIRECT_XAI_BASE_URL
    : DEFAULT_DIRECT_OPENAI_COMPATIBLE_BASE_URL;
}

function isOpenAICompatibleDirectProvider(directProvider) {
  return directProvider === DIRECT_PROVIDER_OPENAI_COMPATIBLE || directProvider === DIRECT_PROVIDER_XAI;
}

function isGrokDirectModel(model) {
  return /^grok(?:[-.]|$)/i.test(String(model || "").trim());
}

function isXaiBaseUrl(baseUrl) {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.x.ai";
  } catch (error) {
    return false;
  }
}

function getDirectModelValidationMessage(directProvider) {
  if (directProvider === DIRECT_PROVIDER_XAI) {
    return "Open Clarity.AI settings and add a Grok model name.";
  }

  return directProvider === DIRECT_PROVIDER_OPENAI_COMPATIBLE
    ? "Open Clarity.AI settings and add an OpenAI-compatible model name."
    : "Open Clarity.AI settings and add a Gemini model name such as gemini-2.5-flash.";
}

function normalizeApiKey(value) {
  return String(value || "").trim();
}

function getDirectGeminiEndpoint(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

function buildDirectGeminiRequestBody(request) {
  return {
    systemInstruction: {
      parts: [
        {
          text: DIRECT_SYSTEM_INSTRUCTION,
        },
      ],
    },
    contents: [
      {
        parts: [
          {
            text: buildDirectPrompt(request),
          },
        ],
      },
    ],
    generationConfig: {
      temperature: getDirectTemperatureForMode(request.mode),
      maxOutputTokens: getDirectMaxOutputTokensForMode(request.mode),
      responseMimeType: "application/json",
      responseSchema: getGeminiResponseSchema(),
    },
  };
}

function buildDirectGeminiTestRequestBody() {
  return {
    systemInstruction: {
      parts: [
        {
          text: DIRECT_SYSTEM_INSTRUCTION,
        },
      ],
    },
    contents: [
      {
        parts: [
          {
            text: 'Return JSON with definition "ok" and usage "ok".',
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 32,
      responseMimeType: "application/json",
      responseSchema: getGeminiResponseSchema(),
    },
  };
}

function getGeminiResponseSchema() {
  return {
    type: "object",
    properties: {
      definition: {
        type: "string",
        description: "Plain-English explanation of what the selected text means.",
      },
      usage: {
        type: "string",
        description: "What the selected text means in this context and what role it plays here.",
      },
    },
    required: ["definition", "usage"],
  };
}

function getDirectOpenAICompatibleEndpoint(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function buildDirectOpenAICompatibleRequestBody(request, model) {
  return {
    model,
    messages: [
      {
        role: "system",
        content: DIRECT_SYSTEM_INSTRUCTION,
      },
      {
        role: "user",
        content: buildDirectPrompt(request),
      },
    ],
    temperature: getDirectTemperatureForMode(request.mode),
    max_tokens: getDirectMaxOutputTokensForMode(request.mode),
  };
}

function buildDirectOpenAICompatibleTestRequestBody(model) {
  return {
    model,
    messages: [
      {
        role: "system",
        content: DIRECT_SYSTEM_INSTRUCTION,
      },
      {
        role: "user",
        content: 'Return JSON with definition "ok" and usage "ok".',
      },
    ],
    temperature: 0,
    max_tokens: 32,
  };
}

function getDirectTemperatureForMode(mode) {
  if (mode === ELI12_MODE) {
    return 0.15;
  }

  if (mode === DEEP_MODE) {
    return 0.18;
  }

  return 0.1;
}

function getDirectMaxOutputTokensForMode(mode) {
  if (mode === ELI12_MODE) {
    return 220;
  }

  if (mode === DEEP_MODE) {
    return 640;
  }

  return 360;
}

function buildDirectPrompt(request) {
  if (request.mode === ELI12_MODE) {
    return buildDirectEli12Prompt(request);
  }

  if (request.mode === DEEP_MODE) {
    return buildDirectDeepPrompt(request);
  }

  const contextText = normalizeSelectionText(request.selection.contextText);
  const pageTitle = normalizeSelectionText(request.selection.pageTitle);
  const hostname = normalizeSelectionText(request.selection.hostname);
  const contextSignals = getSelectionContextSignals(request.selection.text, contextText);

  return [
    "Return JSON with definition and usage.",
    "Definition: explain what the highlighted text means clearly in 2 to 4 sentences.",
    "Usage: explain what the highlighted text means in this exact context in 1 to 3 sentences.",
    "If the highlighted text is part of a longer technical phrase, use that nearby phrase to explain the role it plays here.",
    "Be natural, specific, and easy to follow.",
    pageTitle ? `Page title: ${pageTitle}` : "",
    hostname ? `Website: ${hostname}` : "",
    contextSignals.compoundPhrase ? `Nearby phrase: ${contextSignals.compoundPhrase}` : "",
    contextText ? `Context: ${contextText}` : "",
    `Highlighted text: ${request.selection.text}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildDirectEli12Prompt(request) {
  const sourceDefinition = normalizeSelectionText(request.sourceExplanation?.definition);
  const sourceUsage = normalizeSelectionText(request.sourceExplanation?.usage);
  const contextText = normalizeSelectionText(request.selection.contextText);
  const pageTitle = normalizeSelectionText(request.selection.pageTitle);
  const contextSignals = getSelectionContextSignals(request.selection.text, contextText);

  return [
    "Explain this for a 12-year-old.",
    "Use short everyday words.",
    "Definition: explain what the highlighted text means simply.",
    "Usage: explain what it means in the context where it appears.",
    "If it is part of a longer phrase, use that phrase to explain what job it is doing here.",
    `Highlighted text: ${request.selection.text}`,
    pageTitle ? `Page title: ${pageTitle}` : "",
    contextSignals.compoundPhrase ? `Nearby phrase: ${contextSignals.compoundPhrase}` : "",
    sourceDefinition ? `Current definition: ${sourceDefinition}` : "",
    sourceUsage ? `Current in-context explanation: ${sourceUsage}` : "",
    !sourceDefinition && contextText ? `Context: ${contextText}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildDirectDeepPrompt(request) {
  const sourceDefinition = normalizeSelectionText(request.sourceExplanation?.definition);
  const sourceUsage = normalizeSelectionText(request.sourceExplanation?.usage);
  const contextText = normalizeSelectionText(request.selection.contextText);
  const pageTitle = normalizeSelectionText(request.selection.pageTitle);
  const contextSignals = getSelectionContextSignals(request.selection.text, contextText);

  return [
    "Give a more detailed explanation than the regular version.",
    "Keep it natural, clear, and easy to read.",
    "Definition: explain the core meaning in fuller detail.",
    "Usage: explain how it is being used here, why that matters, and include one short concrete example or illustration.",
    "If the highlight is part of a longer technical phrase, use that phrase and explain how the modifiers change the meaning.",
    `Highlighted text: ${request.selection.text}`,
    pageTitle ? `Page title: ${pageTitle}` : "",
    contextSignals.compoundPhrase ? `Nearby phrase: ${contextSignals.compoundPhrase}` : "",
    sourceDefinition ? `Current definition: ${sourceDefinition}` : "",
    sourceUsage ? `Current in-context explanation: ${sourceUsage}` : "",
    contextText ? `Context: ${contextText}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function extractExplanationFromGeminiResponse(data, request) {
  if (data?.promptFeedback?.blockReason) {
    return buildDirectFallbackExplanation(request);
  }

  const rawText = data?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();

  if (!rawText) {
    return buildDirectFallbackExplanation(request);
  }

  const parsed = parseExplanationFromRawText(rawText);
  const explanation = sanitizeGeneratedExplanation(parsed, request);

  if (!explanation?.definition) {
    return buildDirectFallbackExplanation(request);
  }

  return explanation;
}

function extractExplanationFromOpenAICompatibleResponse(data, request) {
  const rawText = extractChatMessageText(data?.choices?.[0]?.message?.content);

  if (!rawText) {
    return buildDirectFallbackExplanation(request);
  }

  const parsed = parseExplanationFromRawText(rawText);
  const explanation = sanitizeGeneratedExplanation(parsed, request);

  if (!explanation?.definition) {
    return buildDirectFallbackExplanation(request);
  }

  return explanation;
}

function extractChatMessageText(content) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (!part || typeof part !== "object") {
          return "";
        }

        if (typeof part.text === "string") {
          return part.text;
        }

        if (typeof part.text?.value === "string") {
          return part.text.value;
        }

        if (typeof part.content === "string") {
          return part.content;
        }

        return "";
      })
      .join("")
      .trim();
  }

  if (content && typeof content === "object") {
    if (typeof content.text === "string") {
      return content.text.trim();
    }

    if (typeof content.text?.value === "string") {
      return content.text.value.trim();
    }
  }

  return "";
}

function parseExplanationFromRawText(rawText) {
  const cleanedText = stripCodeFences(rawText);

  for (const candidate of getJsonCandidates(cleanedText)) {
    const parsed = tryParseJsonRecursively(candidate);

    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  }

  const recoveredFromFields = {
    definition: extractJsonStringField(cleanedText, "definition"),
    usage: combineExplanationText(
      extractJsonStringField(cleanedText, "usage"),
      extractJsonStringField(cleanedText, "inContext"),
      extractJsonStringField(cleanedText, "context")
    ),
  };

  if (recoveredFromFields.definition || recoveredFromFields.usage) {
    return recoveredFromFields;
  }

  const labeledSections = parseLabeledSections(cleanedText);

  if (labeledSections.definition || labeledSections.usage) {
    return labeledSections;
  }

  return {
    definition: cleanedText,
    usage: "",
  };
}

function sanitizeGeneratedExplanation(explanation, request) {
  const normalizedExplanation = sanitizeExplanation(explanation, request.mode);
  let definition = cleanGeneratedField(normalizeSelectionText(normalizedExplanation?.definition));
  let usage = cleanGeneratedField(normalizeSelectionText(normalizedExplanation?.usage));

  if (isPlaceholderFieldValue(definition) || looksTruncatedField(definition)) {
    definition = "";
  }

  if (
    isPlaceholderUsageValue(usage) ||
    looksTruncatedField(usage) ||
    isClearlyGenericUsage(usage)
  ) {
    usage = "";
  }

  if (!usage && definition) {
    usage = buildFallbackUsage(request, definition);
  }

  return {
    definition,
    usage,
    mode: request.mode,
  };
}

function stripCodeFences(text) {
  return String(text || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function getJsonCandidates(text) {
  const candidates = [text];
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  return candidates;
}

function tryParseJsonRecursively(value, depth = 0) {
  if (depth > 2 || typeof value !== "string") {
    return typeof value === "object" && value ? value : null;
  }

  try {
    const parsed = JSON.parse(value);

    if (typeof parsed === "string") {
      return tryParseJsonRecursively(parsed, depth + 1);
    }

    return parsed;
  } catch (error) {
    return null;
  }
}

function extractJsonStringField(text, fieldName) {
  const fieldPattern = new RegExp(`"${fieldName}"\\s*:\\s*"((?:\\\\.|[^"])*)"`, "i");
  const match = String(text || "").match(fieldPattern);

  if (!match) {
    return "";
  }

  try {
    return JSON.parse(`"${match[1]}"`);
  } catch (error) {
    return match[1];
  }
}

function parseLabeledSections(text) {
  const normalizedText = String(text || "");
  const definitionMatch = normalizedText.match(
    /definition\s*[:\-]\s*([\s\S]*?)(?=\n\s*(?:usage|in context|context)\s*[:\-]|$)/i
  );
  const usageMatch = normalizedText.match(
    /(?:usage|in context|context)\s*[:\-]\s*([\s\S]*)$/i
  );

  return {
    definition: definitionMatch?.[1]?.trim() || "",
    usage: usageMatch?.[1]?.trim() || "",
  };
}

function combineExplanationText(...parts) {
  return parts
    .map((part) => normalizeSelectionText(part))
    .filter(Boolean)
    .join(" ");
}

function cleanGeneratedField(text) {
  return normalizeSelectionText(text)
    .replace(/^[{[]+/, "")
    .replace(/[}\]]+$/, "")
    .replace(/^"(.*)"$/i, "$1")
    .replace(/^'(.*)'$/i, "$1");
}

function buildFallbackUsage(request, definitionText = "") {
  const selectionText = normalizeSelectionText(request.selection?.text);
  const contextText = normalizeSelectionText(request.selection?.contextText);
  const isEli12 = request.mode === ELI12_MODE;
  const contextSignals = getSelectionContextSignals(selectionText, contextText);
  const compoundFallback = buildCompoundAwareFallback(selectionText, contextSignals, isEli12);
  const definitionSummary = summarizeDefinitionForUsage(definitionText, selectionText);

  if (compoundFallback?.usage) {
    if (request.mode === DEEP_MODE) {
      return combineExplanationText(
        compoundFallback.usage,
        "That role comes from how the highlighted term modifies the larger technical phrase."
      );
    }

    return compoundFallback.usage;
  }

  if (request.mode === ELI12_MODE) {
    if (definitionSummary) {
      return `Here, this term refers to ${definitionSummary}.`;
    }

    return "Here, that is what the sentence is trying to say in simpler words.";
  }

  if (request.mode === DEEP_MODE) {
    if (definitionSummary) {
      return combineExplanationText(
        `Here, "${selectionText}" refers to ${toSentenceFragment(definitionSummary)} in this context.`,
        "The surrounding sentence is using it as part of the technical point being made."
      );
    }

    return combineExplanationText(
      `Here, "${selectionText}" carries that meaning in this context.`,
      "A deeper explanation was unavailable, but it is part of the point the passage is making."
    );
  }

  if (definitionSummary) {
    return `Here, "${selectionText}" refers to ${toSentenceFragment(definitionSummary)} in this sentence.`;
  }

  if (contextSignals.compoundPhrase) {
    return `Here, it is part of the phrase "${contextSignals.compoundPhrase}" in the sentence.`;
  }

  if (definitionText) {
    return `Here, "${selectionText}" is being used with that meaning in this context.`;
  }

  return "Here, it is being used with a specific meaning in the surrounding sentence.";
}

function isPlaceholderFieldValue(text) {
  const normalizedText = normalizeSelectionText(text).toLowerCase();

  return (
    normalizedText === "definition" ||
    normalizedText === "usage" ||
    normalizedText === "in context" ||
    normalizedText === "context" ||
    normalizedText === "meaning"
  );
}

function isPlaceholderUsageValue(text) {
  const normalizedText = normalizeSelectionText(text).toLowerCase();

  return (
    isPlaceholderFieldValue(normalizedText) ||
    /\b(?:describe|describes|describing|point|points|pointing)\s+(?:to|at)\s+definition\b/i.test(normalizedText) ||
    /\bused to\s+(?:describe|point to)\s+definition\b/i.test(normalizedText) ||
    /\bused to\s+(?:describe|point to)\s+usage\b/i.test(normalizedText)
  );
}

function looksTruncatedField(text) {
  const normalizedText = normalizeSelectionText(text);

  if (!normalizedText) {
    return false;
  }

  if (/[\\/]$/.test(normalizedText)) {
    return true;
  }

  if (/[,:;([{]$/.test(normalizedText)) {
    return true;
  }

  const doubleQuoteCount = (normalizedText.match(/"/g) || []).length;
  return doubleQuoteCount % 2 === 1;
}

function isClearlyGenericUsage(text) {
  const normalizedText = normalizeSelectionText(text);

  return (
    /^in this context[,:\s]*$/i.test(normalizedText) ||
    /^here[,:\s]*$/i.test(normalizedText) ||
    /^definition$/i.test(normalizedText) ||
    /^usage$/i.test(normalizedText) ||
    /\bit names the specific idea the sentence is talking about\b/i.test(normalizedText) ||
    /\bit points to the specific idea the sentence is talking about\b/i.test(normalizedText) ||
    /\bthe highlighted text is being used to\b/i.test(normalizedText) ||
    /\bdescribe or point to definition\b/i.test(normalizedText) ||
    /\bpoint to definition\b/i.test(normalizedText)
  );
}

function summarizeDefinitionForUsage(definitionText, selectionText) {
  let summary = normalizeSelectionText(definitionText)
    .split(/(?<=[.!?])\s+/)[0]
    ?.trim();

  if (!summary) {
    return "";
  }

  const escapedSelection = escapeRegExp(normalizeSelectionText(selectionText));

  summary = summary
    .replace(new RegExp(`^(?:the\\s+word|word|the\\s+term|term)\\s+["']?${escapedSelection}["']?\\s+(?:is|means|refers to)\\s+`, "i"), "")
    .replace(new RegExp(`^(?:the|a|an)\\s+${escapedSelection}\\s+(?:is|means|refers to)\\s+`, "i"), "")
    .replace(new RegExp(`^${escapedSelection}\\s+(?:is|means|refers to)\\s+`, "i"), "")
    .replace(/^it\s+(?:is|means|refers to)\s+/i, "")
    .replace(/^this\s+(?:is|means|refers to)\s+/i, "")
    .replace(/[.]+$/, "")
    .trim();

  return summary;
}

function toSentenceFragment(text) {
  return cleanGeneratedField(normalizeSelectionText(text)).replace(/[.]+$/, "").trim();
}

function getSelectionContextSignals(selectionText, contextText) {
  const normalizedSelection = normalizeSelectionText(selectionText);
  const normalizedContext = normalizeSelectionText(contextText);
  const escapedSelection = escapeRegExp(normalizedSelection);

  if (!normalizedSelection || !normalizedContext) {
    return {
      compoundPhrase: "",
    };
  }

  const compoundMatch = normalizedContext.match(
    new RegExp(`\\b[\\w-]*${escapedSelection}[\\w-]*\\b`, "i")
  );
  const compoundPhrase = compoundMatch?.[0] || "";

  return {
    compoundPhrase: compoundPhrase.includes("-") ? compoundPhrase : "",
  };
}

function buildCompoundAwareFallback(selectionText, contextSignals, isEli12) {
  const selectionLower = normalizeSelectionText(selectionText).toLowerCase();
  const compoundPhrase = normalizeSelectionText(contextSignals?.compoundPhrase);

  if (!compoundPhrase) {
    return buildSingleWordFallback(selectionText, isEli12);
  }

  const compoundLower = compoundPhrase.toLowerCase();
  const parts = compoundPhrase.split("-");
  const firstPart = parts[0] || "";

  if (selectionLower === "tolerant") {
    return {
      definition: isEli12
        ? "Tolerant means able to keep working well even when conditions are pushed or changed."
        : "Tolerant means able to handle strain, variation, or difficult conditions without failing or losing effectiveness.",
      usage: firstPart
        ? `Here, in "${compoundPhrase}", it means the system can still work properly even under ${firstPart}.`
        : `Here, in "${compoundPhrase}", it describes something that can keep working under stress.`,
    };
  }

  if (selectionLower === "efficient" && compoundLower.includes("energy-efficient")) {
    return {
      definition: isEli12
        ? "Efficient means doing the job well while using less energy or effort."
        : "Efficient means achieving the desired result while using relatively little energy, time, or other resources.",
      usage: `Here, in "${compoundPhrase}", it means the system performs its task while using less energy.`,
    };
  }

  if (selectionLower === "lightweight") {
    return {
      definition: isEli12
        ? "Lightweight means designed to use fewer resources or stay small and simple."
        : "Lightweight means designed to be smaller, simpler, or less demanding in terms of computation, memory, or hardware resources.",
      usage: `Here, it describes the AI inference as needing fewer computing resources.`,
    };
  }

  if (selectionLower === "overclocking") {
    return {
      definition: isEli12
        ? "Overclocking means running a chip or processor faster than its normal rated clock speed."
        : "Overclocking means operating a processor or other hardware above its standard rated clock speed in order to gain more performance.",
      usage: `Here, in "${compoundPhrase}", it describes behavior connected to hardware being run beyond its usual clock-speed setting.`,
    };
  }

  return buildSingleWordFallback(selectionText, isEli12, compoundPhrase);
}

function buildSingleWordFallback(selectionText, isEli12, compoundPhrase = "") {
  const selectionLower = normalizeSelectionText(selectionText).toLowerCase();

  if (selectionLower === "tolerant") {
    return {
      definition: isEli12
        ? "Tolerant means able to handle problems, changes, or stress without failing."
        : "Tolerant means able to withstand variation, stress, or difficult conditions without serious failure.",
      usage: compoundPhrase
        ? `Here, it helps describe what "${compoundPhrase}" can handle.`
        : "Here, it describes something that can keep working even under tougher conditions.",
    };
  }

  if (selectionLower === "efficient") {
    return {
      definition: isEli12
        ? "Efficient means doing the job well while using less energy, time, or effort."
        : "Efficient means achieving a result while using relatively little energy, time, or other resources.",
      usage: compoundPhrase
        ? `Here, it helps describe what "${compoundPhrase}" is optimized to do with fewer resources.`
        : "Here, it describes something that does its job while using fewer resources.",
    };
  }

  if (selectionLower === "lightweight") {
    return {
      definition: isEli12
        ? "Lightweight means smaller, simpler, or less demanding to run."
        : "Lightweight means smaller, simpler, or less resource-intensive than heavier alternatives.",
      usage: compoundPhrase
        ? `Here, it helps describe the kind of system or process in "${compoundPhrase}".`
        : "Here, it describes something designed to run with fewer resources.",
    };
  }

  if (selectionLower === "overclocking") {
    return {
      definition: isEli12
        ? "Overclocking means making a chip run faster than its usual set speed."
        : "Overclocking means running a processor or other hardware at a clock speed higher than its standard rated setting.",
      usage: compoundPhrase
        ? `Here, it helps describe what "${compoundPhrase}" is able to handle.`
        : "Here, it refers to increasing hardware clock speed to push performance higher.",
    };
  }

  return null;
}

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildDirectFallbackExplanation(request) {
  const selectionText = normalizeSelectionText(request.selection?.text) || "This text";

  if (request.mode === ELI12_MODE) {
    return {
      definition: `${selectionText} means something specific here, but a simpler explanation was not available.`,
      usage: "Here, it is being used in a specific way in the sentence.",
      mode: request.mode,
    };
  }

  if (request.mode === DEEP_MODE) {
    return {
      definition: `${selectionText} refers to a specific idea in the passage, but a deeper explanation was not available.`,
      usage: "Here, it is part of the main point or mechanism being described in the surrounding text.",
      mode: request.mode,
    };
  }

  return {
    definition: `${selectionText} refers to a specific idea in this passage.`,
    usage: "Here, it is being used with that meaning in the surrounding context.",
    mode: request.mode,
  };
}

function getBackendUrl(baseUrl, pathname) {
  return `${baseUrl.replace(/\/+$/, "")}${pathname}`;
}

async function getPersistentCachedExplanation(cacheSignature) {
  const cacheKey = getPersistentCacheKey(cacheSignature);
  const storedValues = await getLocalStorageValues([cacheKey]);
  const entry = storedValues?.[cacheKey];

  if (!entry || entry.signature !== cacheSignature || isExpiredCacheEntry(entry)) {
    if (entry) {
      await removePersistentCacheEntries([cacheKey]);
    }

    return null;
  }

  await touchPersistentCacheKey(cacheKey);
  return sanitizeExplanation(entry.explanation) || null;
}

async function persistCachedExplanation(cacheSignature, explanation) {
  const cacheKey = getPersistentCacheKey(cacheSignature);
  await setLocalStorageValues({
    [cacheKey]: {
      signature: cacheSignature,
      explanation,
      updatedAt: Date.now(),
    },
  });

  await touchPersistentCacheKey(cacheKey);
}

function getPersistentCacheKey(cacheSignature) {
  return `${LOCAL_CACHE_PREFIX}${hashText(cacheSignature)}:${cacheSignature.length}`;
}

function hashText(text) {
  let hash = 2166136261;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function isExpiredCacheEntry(entry) {
  const updatedAt = Number(entry?.updatedAt || 0);
  return !updatedAt || Date.now() - updatedAt > LOCAL_CACHE_TTL_MS;
}

function ensureContextMenu() {
  return new Promise((resolve, reject) => {
    chrome.contextMenus.removeAll(() => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      chrome.contextMenus.create(
        {
          id: CONTEXT_MENU_ID,
          title: "Explain with Clarity.AI",
          contexts: ["selection"],
        },
        () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          resolve();
        }
      );
    });
  });
}

async function maybeOpenPdfInClarityViewer(details) {
  if (!shouldRedirectPdfNavigation(details)) {
    return;
  }

  try {
    await updateTabUrl(details.tabId, getPdfViewerUrl(details.url));
  } catch (error) {
    console.warn("Clarity.AI could not redirect the PDF tab into the custom viewer:", error);
  }
}

function shouldRedirectPdfNavigation(details) {
  if (!details || details.frameId !== 0 || details.tabId < 0) {
    return false;
  }

  const navigationUrl = normalizeTabUrl(details.url);

  if (!navigationUrl || isClarityExtensionUrl(navigationUrl)) {
    return false;
  }

  return looksLikePdfUrl(navigationUrl);
}

function isClarityExtensionUrl(url) {
  const extensionRootUrl = chrome.runtime.getURL("");
  return String(url || "").startsWith(extensionRootUrl);
}

function looksLikePdfUrl(url) {
  try {
    const parsedUrl = new URL(url);

    if (!/^(?:https?|file):$/i.test(parsedUrl.protocol)) {
      return false;
    }

    const pathname = parsedUrl.pathname.toLowerCase();

    if (pathname.endsWith(".pdf")) {
      return true;
    }

    const candidateQueryParams = ["file", "filename", "document", "download", "attachment", "url"];
    return candidateQueryParams.some((paramName) =>
      String(parsedUrl.searchParams.get(paramName) || "").toLowerCase().includes(".pdf")
    );
  } catch (error) {
    return false;
  }
}

function getPdfViewerUrl(fileUrl) {
  try {
    const parsedUrl = new URL(fileUrl);
    const initialViewState = parsedUrl.hash.replace(/^#/, "");
    parsedUrl.hash = "";

    return chrome.runtime.getURL(
      `${PDF_VIEWER_PAGE_PATH}?file=${encodeURIComponent(parsedUrl.toString())}${
        initialViewState ? `#${initialViewState}` : ""
      }`
    );
  } catch (error) {
    return chrome.runtime.getURL(
      `${PDF_VIEWER_PAGE_PATH}?file=${encodeURIComponent(fileUrl)}`
    );
  }
}

function updateTabUrl(tabId, url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, { url }, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(tab);
    });
  });
}

function openOptionsPage() {
  return new Promise((resolve, reject) => {
    chrome.runtime.openOptionsPage(() => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve();
    });
  });
}

function normalizeTabUrl(url) {
  return String(url || "").trim();
}

async function openResultPage(payload) {
  const resultId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await setLocalStorageValues({
    [`${RESULT_STORAGE_PREFIX}${resultId}`]: {
      ...payload,
      createdAt: Date.now(),
    },
  });

  return new Promise((resolve, reject) => {
    chrome.tabs.create(
      {
        url: chrome.runtime.getURL(`src/extension/result.html?id=${encodeURIComponent(resultId)}`),
      },
      (tab) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(tab);
      }
    );
  });
}

async function touchPersistentCacheKey(cacheKey) {
  const storedValues = await getLocalStorageValues([LOCAL_CACHE_INDEX_KEY]);
  const currentIndex = Array.isArray(storedValues?.[LOCAL_CACHE_INDEX_KEY]) ? storedValues[LOCAL_CACHE_INDEX_KEY] : [];
  const nextIndex = [cacheKey, ...currentIndex.filter((key) => key !== cacheKey)];
  const evictedKeys = nextIndex.slice(LOCAL_CACHE_LIMIT);
  const trimmedIndex = nextIndex.slice(0, LOCAL_CACHE_LIMIT);

  await setLocalStorageValues({
    [LOCAL_CACHE_INDEX_KEY]: trimmedIndex,
  });

  if (evictedKeys.length > 0) {
    await removeLocalStorageValues(evictedKeys);
  }
}

async function removePersistentCacheEntries(cacheKeys) {
  if (!cacheKeys.length) {
    return;
  }

  const storedValues = await getLocalStorageValues([LOCAL_CACHE_INDEX_KEY]);
  const currentIndex = Array.isArray(storedValues?.[LOCAL_CACHE_INDEX_KEY]) ? storedValues[LOCAL_CACHE_INDEX_KEY] : [];
  const keysToRemove = new Set(cacheKeys);
  const trimmedIndex = currentIndex.filter((key) => !keysToRemove.has(key));

  await Promise.all([
    removeLocalStorageValues(cacheKeys),
    setLocalStorageValues({
      [LOCAL_CACHE_INDEX_KEY]: trimmedIndex,
    }),
  ]);
}

function getLocalStorageValues(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(result || {});
    });
  });
}

function getSyncStorageValues(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(result || {});
    });
  });
}

function setLocalStorageValues(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve();
    });
  });
}

function removeLocalStorageValues(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve();
    });
  });
}

function trimCache(cache, maxEntries) {
  while (cache.size > maxEntries) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
}
