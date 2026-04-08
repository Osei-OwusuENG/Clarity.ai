const DEFAULT_BACKEND_BASE_URL = "http://localhost:3000";
const BACKEND_URL_STORAGE_KEY = "backendBaseUrl";
const EXPLAIN_ENDPOINT_PATH = "/api/explain";
const MAX_SELECTION_LENGTH = 1500;
const MAX_CONTEXT_LENGTH = 420;
const CACHE_LIMIT = 60;
const CONTEXT_MENU_ID = "clarity-explain-selection";
const RESULT_STORAGE_PREFIX = "clarity-result:";
const CACHE_SCHEMA_VERSION = "v22";
const LOCAL_CACHE_PREFIX = `clarity-backend-cache:${CACHE_SCHEMA_VERSION}:`;
const LOCAL_CACHE_INDEX_KEY = `clarity-backend-cache-index:${CACHE_SCHEMA_VERSION}`;
const LOCAL_CACHE_LIMIT = 240;
const LOCAL_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const DEFAULT_MODE = "default";
const VALID_EXPLANATION_MODES = new Set(["default", "eli12", "deep"]);

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
        console.error("Clarity explanation error:", error);
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

  const backendBaseUrl = await getBackendBaseUrl();

  if (!backendBaseUrl) {
    throw new Error("Open Clarity settings and add a backend URL.");
  }

  const cacheSignature = getRequestCacheSignature(request);

  if (explanationCache.has(cacheSignature)) {
    return explanationCache.get(cacheSignature);
  }

  const cachedExplanation = await getPersistentCachedExplanation(cacheSignature);

  if (cachedExplanation) {
    explanationCache.set(cacheSignature, cachedExplanation);
    trimCache(explanationCache, CACHE_LIMIT);
    return cachedExplanation;
  }

  const explanation = await requestBackendExplanation(request, backendBaseUrl);
  explanationCache.set(cacheSignature, explanation);
  trimCache(explanationCache, CACHE_LIMIT);
  await persistCachedExplanation(cacheSignature, explanation);
  return explanation;
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
    throw new Error("Clarity could not reach the backend. Check the backend URL and make sure the server is running.");
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const normalizedError = normalizeBackendError(response.status, data?.error);
    console.warn("Clarity backend error:", normalizedError.debug);
    throw new Error(normalizedError.userMessage);
  }

  const explanation = sanitizeExplanation(data?.explanation, request.mode);

  if (!explanation?.definition) {
    throw new Error("Clarity could not generate an explanation right now. Please try again.");
  }

  return explanation;
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
    console.warn("Clarity could not read page selection context:", error);
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
      userMessage: "The backend URL looks wrong. Check Clarity settings.",
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
    userMessage: backendError.message || "Clarity could not generate an explanation right now. Please try again.",
    debug,
  };
}

function getRequestCacheSignature(request) {
  return [
    request.mode,
    request.selection.text,
    request.selection.contextText,
    request.selection.pageTitle,
    request.selection.hostname,
    request.mode === DEFAULT_MODE ? "" : normalizeSelectionText(request.sourceExplanation?.definition),
    request.mode === DEFAULT_MODE ? "" : normalizeSelectionText(request.sourceExplanation?.usage),
  ].join("\n<context>\n");
}

async function getBackendBaseUrl() {
  try {
    const storedValues = await getSyncStorageValues([BACKEND_URL_STORAGE_KEY]);
    return normalizeBackendBaseUrl(storedValues[BACKEND_URL_STORAGE_KEY]) || DEFAULT_BACKEND_BASE_URL;
  } catch (error) {
    return DEFAULT_BACKEND_BASE_URL;
  }
}

function normalizeBackendBaseUrl(value) {
  const normalizedValue = String(value || "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(normalizedValue) ? normalizedValue : "";
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
          title: "Explain with Clarity",
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
        url: chrome.runtime.getURL(`result.html?id=${encodeURIComponent(resultId)}`),
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
