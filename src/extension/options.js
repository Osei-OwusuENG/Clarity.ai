const CONNECTION_MODE_DIRECT = "direct";
const CONNECTION_MODE_BACKEND = "backend";
const VALID_CONNECTION_MODES = new Set([CONNECTION_MODE_DIRECT, CONNECTION_MODE_BACKEND]);
const VALID_SHORTCUT_MODIFIERS = new Set(["none", "alt", "ctrl", "meta", "shift"]);

const DIRECT_PROVIDER_GEMINI = "gemini";
const DIRECT_PROVIDER_OPENAI_COMPATIBLE = "openai-compatible";
const DIRECT_PROVIDER_XAI = "xai";
const VALID_DIRECT_PROVIDERS = new Set([
  DIRECT_PROVIDER_GEMINI,
  DIRECT_PROVIDER_OPENAI_COMPATIBLE,
  DIRECT_PROVIDER_XAI,
]);

const DEFAULT_DIRECT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_DIRECT_OPENAI_COMPATIBLE_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_DIRECT_XAI_BASE_URL = "https://api.x.ai/v1";

const SYNC_STORAGE_KEYS = {
  connectionMode: "connectionMode",
  backendBaseUrl: "backendBaseUrl",
  directProvider: "directProvider",
  directModel: "directModel",
  directBaseUrl: "directBaseUrl",
  legacyDirectGeminiModel: "directGeminiModel",
  triggerKey: "triggerShortcutKey",
  triggerModifier: "triggerShortcutModifier",
};

const LOCAL_STORAGE_KEYS = {
  directApiKey: "directApiKey",
  legacyDirectGeminiApiKey: "directGeminiApiKey",
};

const DEFAULT_SETTINGS = {
  connectionMode: CONNECTION_MODE_DIRECT,
  directProvider: DIRECT_PROVIDER_GEMINI,
  directApiKey: "",
  directModel: DEFAULT_DIRECT_GEMINI_MODEL,
  directBaseUrl: DEFAULT_DIRECT_OPENAI_COMPATIBLE_BASE_URL,
  backendBaseUrl: "http://localhost:3000",
  key: "z",
  modifier: "none",
};

const form = document.getElementById("settings-form");
const connectionModeSelect = document.getElementById("connection-mode");
const directSettingsPanel = document.getElementById("direct-settings");
const backendSettingsPanel = document.getElementById("backend-settings");
const directProviderSelect = document.getElementById("direct-provider");
const directApiKeyInput = document.getElementById("direct-api-key");
const directModelInput = document.getElementById("direct-model");
const directBaseUrlField = document.getElementById("direct-base-url-field");
const directBaseUrlInput = document.getElementById("direct-base-url");
const directProviderHelp = document.getElementById("direct-provider-help");
const backendBaseUrlInput = document.getElementById("backend-base-url");
const toggleApiKeyVisibilityButton = document.getElementById("toggle-api-key-visibility-button");
const triggerKeyInput = document.getElementById("trigger-key");
const triggerModifierSelect = document.getElementById("trigger-modifier");
const testConnectionButton = document.getElementById("test-connection-button");
const useLocalBackendButton = document.getElementById("use-local-backend-button");
const resetShortcutButton = document.getElementById("reset-shortcut-button");
const statusText = document.getElementById("status");
const shortcutPreview = document.getElementById("shortcut-preview");

void initialize();

connectionModeSelect.addEventListener("change", () => {
  updateConnectionModeUI();
});

directProviderSelect.addEventListener("change", () => {
  const previousProvider =
    normalizeDirectProvider(directProviderSelect.dataset.currentProvider) || DEFAULT_SETTINGS.directProvider;
  const nextProvider = normalizeDirectProvider(directProviderSelect.value) || DEFAULT_SETTINGS.directProvider;
  const currentModel = normalizeDirectModel(directModelInput.value);
  const currentBaseUrl = normalizeDirectBaseUrl(directBaseUrlInput.value);

  if (!currentModel || currentModel === getDefaultDirectModel(previousProvider)) {
    directModelInput.value = getDefaultDirectModel(nextProvider);
  }

  if (
    isOpenAICompatibleDirectProvider(nextProvider) &&
    (!currentBaseUrl || currentBaseUrl === getDefaultDirectBaseUrl(previousProvider))
  ) {
    directBaseUrlInput.value = getDefaultDirectBaseUrl(nextProvider);
  }

  directProviderSelect.dataset.currentProvider = nextProvider;
  updateConnectionModeUI();
});

directModelInput.addEventListener("input", () => {
  const currentProvider = normalizeDirectProvider(directProviderSelect.value) || DEFAULT_SETTINGS.directProvider;
  const currentModel = normalizeDirectModel(directModelInput.value);

  if (currentProvider === DIRECT_PROVIDER_GEMINI && isGrokDirectModel(currentModel)) {
    directProviderSelect.value = DIRECT_PROVIDER_XAI;
    directProviderSelect.dataset.currentProvider = DIRECT_PROVIDER_XAI;
    directBaseUrlInput.value = DEFAULT_DIRECT_XAI_BASE_URL;
    updateConnectionModeUI();
  }
});

toggleApiKeyVisibilityButton.addEventListener("click", () => {
  const nextType = directApiKeyInput.type === "password" ? "text" : "password";
  directApiKeyInput.type = nextType;
  toggleApiKeyVisibilityButton.textContent = nextType === "password" ? "Show" : "Hide";
});

triggerKeyInput.addEventListener("input", () => {
  triggerKeyInput.value = sanitizeShortcutKeyInput(triggerKeyInput.value).toUpperCase();
  updateShortcutPreview();
});

triggerModifierSelect.addEventListener("change", updateShortcutPreview);

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const settings = getSettingsFromForm();
  const validationError = validateSettings(settings);

  if (validationError) {
    setStatus(validationError.message, "error");
    validationError.focusTarget?.focus();
    return;
  }

  try {
    await Promise.all([
      setSyncStorageValues({
        [SYNC_STORAGE_KEYS.connectionMode]: settings.connectionMode,
        [SYNC_STORAGE_KEYS.backendBaseUrl]: settings.backendBaseUrl,
        [SYNC_STORAGE_KEYS.directProvider]: settings.directProvider,
        [SYNC_STORAGE_KEYS.directModel]: settings.directModel,
        [SYNC_STORAGE_KEYS.directBaseUrl]: settings.directBaseUrl,
        [SYNC_STORAGE_KEYS.triggerKey]: settings.key,
        [SYNC_STORAGE_KEYS.triggerModifier]: settings.modifier,
      }),
      setLocalStorageValues({
        [LOCAL_STORAGE_KEYS.directApiKey]: settings.directApiKey,
      }),
    ]);

    setStatus(
      `Saved. Mode: ${formatConnectionModeLabel(settings.connectionMode)}. Shortcut: ${formatShortcutLabel(
        settings
      )}. Reload the page you are testing on.`,
      "success"
    );
  } catch (error) {
    setStatus(error.message, "error");
  }
});

testConnectionButton.addEventListener("click", async () => {
  const settings = getSettingsFromForm();
  const validationError = validateSettings(settings);

  if (validationError) {
    setStatus(validationError.message, "error");
    validationError.focusTarget?.focus();
    return;
  }

  testConnectionButton.disabled = true;

  try {
    const response = await sendRuntimeMessage({
      action: "TEST_CONNECTION",
      settings,
    });

    setStatus(response.result?.message || "Connection looks good.", response.result?.state || "success");
  } catch (error) {
    setStatus(error.message || "Connection test failed.", "error");
  } finally {
    testConnectionButton.disabled = false;
  }
});

useLocalBackendButton.addEventListener("click", () => {
  connectionModeSelect.value = CONNECTION_MODE_BACKEND;
  backendBaseUrlInput.value = DEFAULT_SETTINGS.backendBaseUrl;
  updateConnectionModeUI();
  setStatus("Backend mode selected and URL set to localhost. Save settings to keep it.", "success");
});

resetShortcutButton.addEventListener("click", async () => {
  applyShortcutToForm(DEFAULT_SETTINGS);
  updateShortcutPreview();

  try {
    await setSyncStorageValues({
      [SYNC_STORAGE_KEYS.triggerKey]: DEFAULT_SETTINGS.key,
      [SYNC_STORAGE_KEYS.triggerModifier]: DEFAULT_SETTINGS.modifier,
    });
    setStatus("Shortcut reset to Z. Reload the page you are testing on.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

async function initialize() {
  try {
    const [syncValues, localValues] = await Promise.all([
      getSyncStorageValues(Object.values(SYNC_STORAGE_KEYS)),
      getLocalStorageValues(Object.values(LOCAL_STORAGE_KEYS)),
    ]);

    const directValues = resolveStoredDirectValues(syncValues, localValues);
    const backendBaseUrl = normalizeBackendBaseUrl(syncValues[SYNC_STORAGE_KEYS.backendBaseUrl]);
    const explicitMode = normalizeConnectionMode(syncValues[SYNC_STORAGE_KEYS.connectionMode]);

    const settings = {
      connectionMode: resolveConnectionMode(explicitMode, directValues.directApiKey, backendBaseUrl),
      directProvider: directValues.directProvider,
      directApiKey: directValues.directApiKey,
      directModel: directValues.directModel,
      directBaseUrl: directValues.directBaseUrl,
      backendBaseUrl: backendBaseUrl || DEFAULT_SETTINGS.backendBaseUrl,
      key: normalizeShortcutKey(syncValues[SYNC_STORAGE_KEYS.triggerKey]) || DEFAULT_SETTINGS.key,
      modifier: normalizeShortcutModifier(syncValues[SYNC_STORAGE_KEYS.triggerModifier]),
    };

    applySettingsToForm(settings);
    updateConnectionModeUI();
    updateShortcutPreview();
    setStatus("", "");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function resolveStoredDirectValues(syncValues, localValues) {
  const directProvider = normalizeDirectProvider(syncValues[SYNC_STORAGE_KEYS.directProvider]);
  const directModel = normalizeDirectModel(syncValues[SYNC_STORAGE_KEYS.directModel]);
  const directBaseUrl = normalizeDirectBaseUrl(syncValues[SYNC_STORAGE_KEYS.directBaseUrl]);
  const directApiKey = normalizeApiKey(localValues[LOCAL_STORAGE_KEYS.directApiKey]);
  const hasModernDirectSettings = Boolean(directProvider || directModel || directBaseUrl || directApiKey);

  const resolvedProvider = hasModernDirectSettings
    ? resolveDirectProvider(directProvider || DEFAULT_SETTINGS.directProvider, directModel, directBaseUrl)
    : DIRECT_PROVIDER_GEMINI;
  const fallbackLegacyModel = !hasModernDirectSettings
    ? normalizeDirectModel(syncValues[SYNC_STORAGE_KEYS.legacyDirectGeminiModel])
    : "";
  const fallbackLegacyApiKey = !hasModernDirectSettings
    ? normalizeApiKey(localValues[LOCAL_STORAGE_KEYS.legacyDirectGeminiApiKey])
    : "";

  return {
    directProvider: resolvedProvider,
    directApiKey: directApiKey || fallbackLegacyApiKey,
    directModel: directModel || fallbackLegacyModel || getDefaultDirectModel(resolvedProvider),
    directBaseUrl: directBaseUrl || getDefaultDirectBaseUrl(resolvedProvider),
  };
}

function getSettingsFromForm() {
  const selectedDirectProvider = normalizeDirectProvider(directProviderSelect.value) || DEFAULT_SETTINGS.directProvider;
  const directApiKey = normalizeApiKey(directApiKeyInput.value);
  const normalizedDirectModel = normalizeDirectModel(directModelInput.value);
  const normalizedDirectBaseUrl = normalizeDirectBaseUrl(directBaseUrlInput.value);
  const directProvider = resolveDirectProvider(
    selectedDirectProvider,
    normalizedDirectModel,
    normalizedDirectBaseUrl
  );
  const directModel = normalizedDirectModel || getDefaultDirectModel(directProvider);
  const directBaseUrl = normalizedDirectBaseUrl || getDefaultDirectBaseUrl(directProvider);
  const backendBaseUrl = normalizeBackendBaseUrl(backendBaseUrlInput.value);
  const explicitMode = normalizeConnectionMode(connectionModeSelect.value);

  return {
    connectionMode: resolveConnectionMode(explicitMode, directApiKey, backendBaseUrl),
    directProvider,
    directApiKey,
    directModel,
    directBaseUrl,
    backendBaseUrl,
    key: sanitizeShortcutKeyInput(triggerKeyInput.value),
    modifier: normalizeShortcutModifier(triggerModifierSelect.value),
  };
}

function applySettingsToForm(settings) {
  connectionModeSelect.value = settings.connectionMode;
  directProviderSelect.value = settings.directProvider;
  directProviderSelect.dataset.currentProvider = settings.directProvider;
  directApiKeyInput.value = settings.directApiKey;
  directModelInput.value = settings.directModel;
  directBaseUrlInput.value = settings.directBaseUrl;
  backendBaseUrlInput.value = settings.backendBaseUrl;
  applyShortcutToForm(settings);
  updateDirectProviderUI();
}

function applyShortcutToForm(shortcut) {
  triggerKeyInput.value = shortcut.key.toUpperCase();
  triggerModifierSelect.value = shortcut.modifier;
}

function updateConnectionModeUI() {
  const connectionMode = normalizeConnectionMode(connectionModeSelect.value) || DEFAULT_SETTINGS.connectionMode;
  const isDirectMode = connectionMode === CONNECTION_MODE_DIRECT;

  directSettingsPanel.hidden = !isDirectMode;
  backendSettingsPanel.hidden = isDirectMode;
  useLocalBackendButton.hidden = isDirectMode;

  if (isDirectMode) {
    updateDirectProviderUI();
    testConnectionButton.textContent = `Test ${formatDirectProviderLabel(
      normalizeDirectProvider(directProviderSelect.value) || DEFAULT_SETTINGS.directProvider
    )}`;
    return;
  }

  testConnectionButton.textContent = "Test backend";
}

function updateDirectProviderUI() {
  const directProvider = normalizeDirectProvider(directProviderSelect.value) || DEFAULT_SETTINGS.directProvider;
  const usesOpenAICompatibleTransport = isOpenAICompatibleDirectProvider(directProvider);

  directBaseUrlField.hidden = !usesOpenAICompatibleTransport;
  directApiKeyInput.placeholder = getDirectApiKeyPlaceholder(directProvider);
  directModelInput.placeholder = getDirectModelPlaceholder(directProvider);

  if (directProvider === DIRECT_PROVIDER_XAI) {
    directProviderHelp.textContent =
      "xAI / Grok mode sends OpenAI-compatible chat completions requests to xAI.";
    return;
  }

  directProviderHelp.textContent =
    directProvider === DIRECT_PROVIDER_OPENAI_COMPATIBLE
      ? "OpenAI-compatible mode sends POST /chat/completions requests to the base URL below."
      : "Gemini mode uses Google's native Gemini API directly from the extension.";
}

function updateShortcutPreview() {
  const shortcut = getSettingsFromForm();
  shortcutPreview.textContent = `Current shortcut: ${formatShortcutLabel(shortcut)}`;
}

function validateSettings(settings) {
  if (!settings.key) {
    return {
      message: "Choose a shortcut key using one letter or number.",
      focusTarget: triggerKeyInput,
    };
  }

  if (settings.connectionMode === CONNECTION_MODE_DIRECT) {
    if (!settings.directApiKey) {
      return {
        message: "Add your API key for direct mode.",
        focusTarget: directApiKeyInput,
      };
    }

    if (!settings.directModel) {
      return {
        message: getDirectModelValidationMessage(settings.directProvider),
        focusTarget: directModelInput,
      };
    }

    if (
      isOpenAICompatibleDirectProvider(settings.directProvider) &&
      !settings.directBaseUrl
    ) {
      return {
        message:
          settings.directProvider === DIRECT_PROVIDER_XAI
            ? "Add the xAI base URL, https://api.x.ai/v1."
            : "Add a base URL such as https://api.openai.com/v1.",
        focusTarget: directBaseUrlInput,
      };
    }

    return null;
  }

  if (!settings.backendBaseUrl) {
    return {
      message: "Enter a backend URL such as http://localhost:3000.",
      focusTarget: backendBaseUrlInput,
    };
  }

  return null;
}

function formatConnectionModeLabel(connectionMode) {
  return connectionMode === CONNECTION_MODE_BACKEND ? "Self-hosted backend" : "Direct mode";
}

function formatDirectProviderLabel(directProvider) {
  if (directProvider === DIRECT_PROVIDER_XAI) {
    return "xAI / Grok";
  }

  return directProvider === DIRECT_PROVIDER_OPENAI_COMPATIBLE ? "OpenAI-compatible" : "Gemini";
}

function formatShortcutLabel(shortcut) {
  const key = (shortcut.key || DEFAULT_SETTINGS.key).toUpperCase();

  switch (shortcut.modifier) {
    case "alt":
      return `Alt + ${key}`;
    case "ctrl":
      return `Ctrl + ${key}`;
    case "meta":
      return `Meta + ${key}`;
    case "shift":
      return `Shift + ${key}`;
    case "none":
    default:
      return key;
  }
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

function getDirectApiKeyPlaceholder(directProvider) {
  if (directProvider === DIRECT_PROVIDER_GEMINI) {
    return "AIza...";
  }

  return directProvider === DIRECT_PROVIDER_XAI ? "xai-..." : "sk-...";
}

function getDirectModelPlaceholder(directProvider) {
  if (directProvider === DIRECT_PROVIDER_GEMINI) {
    return DEFAULT_DIRECT_GEMINI_MODEL;
  }

  return directProvider === DIRECT_PROVIDER_XAI ? "grok-4" : "your-provider-model";
}

function getDirectModelValidationMessage(directProvider) {
  if (directProvider === DIRECT_PROVIDER_XAI) {
    return "Add a Grok model name.";
  }

  return directProvider === DIRECT_PROVIDER_OPENAI_COMPATIBLE
    ? "Add an OpenAI-compatible model name."
    : "Add a Gemini model name such as gemini-2.5-flash.";
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

  return DEFAULT_SETTINGS.connectionMode;
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
  const directBaseUrl = normalizeDirectBaseUrl(baseUrl);

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

  return directProvider || DEFAULT_SETTINGS.directProvider;
}

function normalizeBackendBaseUrl(value) {
  const normalizedValue = String(value || "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(normalizedValue) ? normalizedValue : "";
}

function normalizeDirectBaseUrl(value) {
  return normalizeBackendBaseUrl(value);
}

function normalizeDirectModel(value) {
  const normalizedValue = String(value || "").trim();
  return /^[^\s]{1,120}$/i.test(normalizedValue) ? normalizedValue : "";
}

function normalizeApiKey(value) {
  return String(value || "").trim();
}

function sanitizeShortcutKeyInput(value) {
  return String(value || "")
    .replace(/[^a-z0-9]/gi, "")
    .slice(-1)
    .toLowerCase();
}

function normalizeShortcutKey(value) {
  const normalizedValue = String(value || "").trim().toLowerCase();
  return /^[a-z0-9]$/.test(normalizedValue) ? normalizedValue : "";
}

function normalizeShortcutModifier(value) {
  const normalizedValue = String(value || "").trim().toLowerCase();
  return VALID_SHORTCUT_MODIFIERS.has(normalizedValue) ? normalizedValue : DEFAULT_SETTINGS.modifier;
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

function setSyncStorageValues(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set(values, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve();
    });
  });
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

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!response) {
        reject(new Error("Clarity.AI did not return a response."));
        return;
      }

      if (!response.ok) {
        reject(new Error(response.error || "Clarity.AI request failed."));
        return;
      }

      resolve(response);
    });
  });
}

function setStatus(message, state = "") {
  statusText.textContent = message;

  if (state) {
    statusText.dataset.state = state;
    return;
  }

  delete statusText.dataset.state;
}
