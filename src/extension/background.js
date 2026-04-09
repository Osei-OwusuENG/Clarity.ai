const CONNECTION_MODE_DIRECT = "direct";
const CONNECTION_MODE_BACKEND = "backend";
const VALID_CONNECTION_MODES = new Set([CONNECTION_MODE_DIRECT, CONNECTION_MODE_BACKEND]);

const CONNECTION_MODE_STORAGE_KEY = "connectionMode";
const BACKEND_URL_STORAGE_KEY = "backendBaseUrl";
const DIRECT_GEMINI_MODEL_STORAGE_KEY = "directGeminiModel";
const DIRECT_GEMINI_API_KEY_STORAGE_KEY = "directGeminiApiKey";

const DEFAULT_BACKEND_BASE_URL = "http://localhost:3000";
const DEFAULT_DIRECT_GEMINI_MODEL = "gemini-2.5-flash";
const DIRECT_GEMINI_SYSTEM_INSTRUCTION = [
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
const RESULT_STORAGE_PREFIX = "clarity-result:";
const CACHE_SCHEMA_VERSION = "v23";
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
    return requestDirectGeminiExplanation(request, connectionSettings);
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

async function testConnection(inputSettings) {
  const connectionSettings = inputSettings
    ? normalizeConnectionSettings(inputSettings)
    : await getStoredConnectionSettings();
  const connectionError = getConnectionValidationError(connectionSettings);

  if (connectionError) {
    throw new Error(connectionError);
  }

  if (connectionSettings.connectionMode === CONNECTION_MODE_DIRECT) {
    await testDirectGeminiConnection(connectionSettings);
    return {
      state: "success",
      message: `Gemini is reachable. Model: ${connectionSettings.directGeminiModel}.`,
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

  if (!data.hasGeminiKey) {
    throw new Error("Backend is reachable, but GEMINI_API_KEY is missing in .env.");
  }

  return {
    state: "success",
    message: `Backend is reachable. Model: ${data.model}.`,
  };
}

async function handleContextMenuSelection(selectionText, tabId) {
  const selection = await resolveContextMenuSelection(selectionText, tabId);

  if (!selection.text) {
    await openResultPage({
      selection,
      selectedText: "",
      error: "No selected text was provided by the browser.",
    });
    return;
  }

  try {
    const explanation = await handleExplanationRequest({
      action: "GET_EXPLANATION",
      selection,
      mode: DEFAULT_MODE,
    });

    await openResultPage({
      selection,
      selectedText: selection.text,
      explanation,
      source: "context-menu",
    });
  } catch (error) {
    await openResultPage({
      selection,
      selectedText: selection.text,
      error: error.message,
      source: "context-menu",
    });
  }
}

async function resolveContextMenuSelection(selectionText, tabId) {
  const fallbackSelection = normalizeSelection(selectionText);

  if (!tabId) {
    return fallbackSelection;
  }

  try {
    const contextSelection = await requestSelectionContextFromTab(tabId);

    if (
      contextSelection?.text &&
      normalizeSelectionText(contextSelection.text) === fallbackSelection.text
    ) {
      return normalizeSelection(contextSelection);
    }
  } catch (error) {
    console.warn("Clarity.AI could not read page selection context:", error);
  }

  return fallbackSelection;
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

      resolve(response.selection || null);
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
    return `${CONNECTION_MODE_DIRECT}:${connectionSettings.directGeminiModel}`;
  }

  return `${CONNECTION_MODE_BACKEND}:${connectionSettings.backendBaseUrl}`;
}

function getConnectionValidationError(connectionSettings) {
  if (connectionSettings.connectionMode === CONNECTION_MODE_DIRECT) {
    if (!connectionSettings.directGeminiApiKey) {
      return "Open Clarity.AI settings and add your Gemini API key, or switch to backend mode.";
    }

    if (!connectionSettings.directGeminiModel) {
      return "Open Clarity.AI settings and add a Gemini model name such as gemini-2.5-flash.";
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
      DIRECT_GEMINI_MODEL_STORAGE_KEY,
    ]),
    getLocalStorageValues([
      DIRECT_GEMINI_API_KEY_STORAGE_KEY,
      BACKEND_URL_STORAGE_KEY,
      CONNECTION_MODE_STORAGE_KEY,
      DIRECT_GEMINI_MODEL_STORAGE_KEY,
    ]),
  ]);

  return normalizeConnectionSettings({
    connectionMode: syncValues[CONNECTION_MODE_STORAGE_KEY] || localValues[CONNECTION_MODE_STORAGE_KEY],
    backendBaseUrl: syncValues[BACKEND_URL_STORAGE_KEY] || localValues[BACKEND_URL_STORAGE_KEY],
    directGeminiModel:
      syncValues[DIRECT_GEMINI_MODEL_STORAGE_KEY] || localValues[DIRECT_GEMINI_MODEL_STORAGE_KEY],
    directGeminiApiKey: localValues[DIRECT_GEMINI_API_KEY_STORAGE_KEY],
  });
}

function normalizeConnectionSettings(input) {
  const directGeminiApiKey = normalizeApiKey(input?.directGeminiApiKey);
  const backendBaseUrl = normalizeBackendBaseUrl(input?.backendBaseUrl);
  const connectionMode = resolveConnectionMode(
    normalizeConnectionMode(input?.connectionMode || input?.mode),
    directGeminiApiKey,
    backendBaseUrl
  );

  return {
    connectionMode,
    directGeminiApiKey,
    directGeminiModel: normalizeGeminiModel(input?.directGeminiModel) || DEFAULT_DIRECT_GEMINI_MODEL,
    backendBaseUrl: backendBaseUrl || DEFAULT_BACKEND_BASE_URL,
  };
}

function resolveConnectionMode(explicitMode, directGeminiApiKey, backendBaseUrl) {
  if (VALID_CONNECTION_MODES.has(explicitMode)) {
    return explicitMode;
  }

  if (directGeminiApiKey) {
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

function normalizeBackendBaseUrl(value) {
  const normalizedValue = String(value || "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(normalizedValue) ? normalizedValue : "";
}

function normalizeGeminiModel(value) {
  const normalizedValue = String(value || "").trim();
  return /^[a-z0-9][a-z0-9._-]{1,80}$/i.test(normalizedValue) ? normalizedValue : "";
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
          text: DIRECT_GEMINI_SYSTEM_INSTRUCTION,
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
          text: DIRECT_GEMINI_SYSTEM_INSTRUCTION,
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
    return 180;
  }

  if (mode === DEEP_MODE) {
    return 560;
  }

  return 280;
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

  return [
    "Return JSON with definition and usage.",
    "Definition: explain what the highlighted text means clearly.",
    "Usage: explain what the highlighted text means in this exact context.",
    "Be natural, specific, and easy to follow.",
    pageTitle ? `Page title: ${pageTitle}` : "",
    hostname ? `Website: ${hostname}` : "",
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

  return [
    "Explain this for a 12-year-old.",
    "Use short everyday words.",
    "Definition: explain what the highlighted text means simply.",
    "Usage: explain what it means in the context where it appears.",
    `Highlighted text: ${request.selection.text}`,
    pageTitle ? `Page title: ${pageTitle}` : "",
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

  return [
    "Give a more detailed explanation than the regular version.",
    "Keep it natural, clear, and easy to read.",
    "Definition: explain the core meaning in fuller detail.",
    "Usage: explain how it is being used here, why that matters, and include one short concrete example or illustration.",
    `Highlighted text: ${request.selection.text}`,
    pageTitle ? `Page title: ${pageTitle}` : "",
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
  const definition = cleanGeneratedField(normalizeSelectionText(normalizedExplanation?.definition));
  const usage =
    cleanGeneratedField(normalizeSelectionText(normalizedExplanation?.usage)) ||
    buildFallbackUsage(request, definition);

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

  if (request.mode === ELI12_MODE) {
    return "Here, that is what the sentence is trying to say in simpler words.";
  }

  if (request.mode === DEEP_MODE) {
    return combineExplanationText(
      `Here, "${selectionText}" carries that meaning in this context.`,
      "A deeper explanation was unavailable, but it is part of the point the passage is making."
    );
  }

  if (definitionText) {
    return `Here, "${selectionText}" is being used with that meaning in this context.`;
  }

  return "Here, it is being used with a specific meaning in the surrounding sentence.";
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
