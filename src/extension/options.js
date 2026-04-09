const CONNECTION_MODE_DIRECT = "direct";
const CONNECTION_MODE_BACKEND = "backend";
const VALID_CONNECTION_MODES = new Set([CONNECTION_MODE_DIRECT, CONNECTION_MODE_BACKEND]);
const VALID_SHORTCUT_MODIFIERS = new Set(["none", "alt", "ctrl", "meta", "shift"]);

const SYNC_STORAGE_KEYS = {
  connectionMode: "connectionMode",
  backendBaseUrl: "backendBaseUrl",
  directGeminiModel: "directGeminiModel",
  triggerKey: "triggerShortcutKey",
  triggerModifier: "triggerShortcutModifier",
};

const LOCAL_STORAGE_KEYS = {
  directGeminiApiKey: "directGeminiApiKey",
};

const DEFAULT_SETTINGS = {
  connectionMode: CONNECTION_MODE_DIRECT,
  directGeminiApiKey: "",
  directGeminiModel: "gemini-2.5-flash",
  backendBaseUrl: "http://localhost:3000",
  key: "z",
  modifier: "none",
};

const form = document.getElementById("settings-form");
const connectionModeSelect = document.getElementById("connection-mode");
const directSettingsPanel = document.getElementById("direct-settings");
const backendSettingsPanel = document.getElementById("backend-settings");
const directGeminiApiKeyInput = document.getElementById("direct-gemini-api-key");
const directGeminiModelInput = document.getElementById("direct-gemini-model");
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

toggleApiKeyVisibilityButton.addEventListener("click", () => {
  const nextType = directGeminiApiKeyInput.type === "password" ? "text" : "password";
  directGeminiApiKeyInput.type = nextType;
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
        [SYNC_STORAGE_KEYS.directGeminiModel]: settings.directGeminiModel,
        [SYNC_STORAGE_KEYS.triggerKey]: settings.key,
        [SYNC_STORAGE_KEYS.triggerModifier]: settings.modifier,
      }),
      setLocalStorageValues({
        [LOCAL_STORAGE_KEYS.directGeminiApiKey]: settings.directGeminiApiKey,
      }),
    ]);

    setStatus(
      `Saved. Mode: ${formatConnectionModeLabel(settings.connectionMode)}. Shortcut: ${formatShortcutLabel(settings)}. Reload the page you are testing on.`,
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

    const directGeminiApiKey = normalizeApiKey(localValues[LOCAL_STORAGE_KEYS.directGeminiApiKey]);
    const backendBaseUrl = normalizeBackendBaseUrl(syncValues[SYNC_STORAGE_KEYS.backendBaseUrl]);
    const explicitMode = normalizeConnectionMode(syncValues[SYNC_STORAGE_KEYS.connectionMode]);

    const settings = {
      connectionMode: resolveConnectionMode(explicitMode, directGeminiApiKey, backendBaseUrl),
      directGeminiApiKey,
      directGeminiModel:
        normalizeGeminiModel(syncValues[SYNC_STORAGE_KEYS.directGeminiModel]) || DEFAULT_SETTINGS.directGeminiModel,
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

function getSettingsFromForm() {
  const directGeminiApiKey = normalizeApiKey(directGeminiApiKeyInput.value);
  const backendBaseUrl = normalizeBackendBaseUrl(backendBaseUrlInput.value);
  const explicitMode = normalizeConnectionMode(connectionModeSelect.value);

  return {
    connectionMode: resolveConnectionMode(explicitMode, directGeminiApiKey, backendBaseUrl),
    directGeminiApiKey,
    directGeminiModel: normalizeGeminiModel(directGeminiModelInput.value) || DEFAULT_SETTINGS.directGeminiModel,
    backendBaseUrl,
    key: sanitizeShortcutKeyInput(triggerKeyInput.value),
    modifier: normalizeShortcutModifier(triggerModifierSelect.value),
  };
}

function applySettingsToForm(settings) {
  connectionModeSelect.value = settings.connectionMode;
  directGeminiApiKeyInput.value = settings.directGeminiApiKey;
  directGeminiModelInput.value = settings.directGeminiModel;
  backendBaseUrlInput.value = settings.backendBaseUrl;
  applyShortcutToForm(settings);
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
  testConnectionButton.textContent = isDirectMode ? "Test direct mode" : "Test backend";
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
    if (!settings.directGeminiApiKey) {
      return {
        message: "Add your API key for direct mode.",
        focusTarget: directGeminiApiKeyInput,
      };
    }

    if (!settings.directGeminiModel) {
      return {
        message: "Add a Gemini model name such as gemini-2.5-flash.",
        focusTarget: directGeminiModelInput,
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

  return DEFAULT_SETTINGS.connectionMode;
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
