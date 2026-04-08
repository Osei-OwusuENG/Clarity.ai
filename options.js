const STORAGE_KEYS = {
  backendBaseUrl: "backendBaseUrl",
  triggerKey: "triggerShortcutKey",
  triggerModifier: "triggerShortcutModifier",
};

const DEFAULT_SETTINGS = {
  backendBaseUrl: "http://localhost:3000",
  key: "z",
  modifier: "none",
};

const VALID_SHORTCUT_MODIFIERS = new Set(["none", "alt", "ctrl", "meta", "shift"]);

const form = document.getElementById("settings-form");
const backendBaseUrlInput = document.getElementById("backend-base-url");
const triggerKeyInput = document.getElementById("trigger-key");
const triggerModifierSelect = document.getElementById("trigger-modifier");
const testBackendButton = document.getElementById("test-backend-button");
const useLocalBackendButton = document.getElementById("use-local-backend-button");
const resetShortcutButton = document.getElementById("reset-shortcut-button");
const statusText = document.getElementById("status");
const shortcutPreview = document.getElementById("shortcut-preview");

void initialize();

triggerKeyInput.addEventListener("input", () => {
  triggerKeyInput.value = sanitizeShortcutKeyInput(triggerKeyInput.value).toUpperCase();
  updateShortcutPreview();
});

triggerModifierSelect.addEventListener("change", updateShortcutPreview);

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const settings = getSettingsFromForm();

  if (!settings.key) {
    setStatus("Choose a shortcut key using one letter or number.");
    triggerKeyInput.focus();
    return;
  }

  if (!settings.backendBaseUrl) {
    setStatus("Enter a backend URL such as http://localhost:3000.", "error");
    backendBaseUrlInput.focus();
    return;
  }

  try {
    await setStorageValues({
      [STORAGE_KEYS.backendBaseUrl]: settings.backendBaseUrl,
      [STORAGE_KEYS.triggerKey]: settings.key,
      [STORAGE_KEYS.triggerModifier]: settings.modifier,
    });

    setStatus(
      `Saved. Backend: ${settings.backendBaseUrl}. Shortcut: ${formatShortcutLabel(settings)}. Reload the page you are testing on.`,
      "success"
    );
  } catch (error) {
    setStatus(error.message, "error");
  }
});

testBackendButton.addEventListener("click", async () => {
  const backendBaseUrl = normalizeBackendBaseUrl(backendBaseUrlInput.value);

  if (!backendBaseUrl) {
    setStatus("Enter a valid backend URL first.", "error");
    backendBaseUrlInput.focus();
    return;
  }

  testBackendButton.disabled = true;

  try {
    const response = await fetch(`${backendBaseUrl}/api/health`);
    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.ok) {
      throw new Error("Health check failed.");
    }

    const summary = data.hasGeminiKey
      ? `Backend is reachable. Model: ${data.model}.`
      : "Backend is reachable, but GEMINI_API_KEY is missing in .env.";

    setStatus(summary, data.hasGeminiKey ? "success" : "error");
  } catch (error) {
    setStatus("Could not reach /api/health at that backend URL.", "error");
  } finally {
    testBackendButton.disabled = false;
  }
});

useLocalBackendButton.addEventListener("click", () => {
  backendBaseUrlInput.value = DEFAULT_SETTINGS.backendBaseUrl;
  setStatus("Backend URL set to localhost. Save settings to keep it.", "success");
});

resetShortcutButton.addEventListener("click", async () => {
  applyShortcutToForm(DEFAULT_SETTINGS);
  updateShortcutPreview();

  try {
    await setStorageValues({
      [STORAGE_KEYS.triggerKey]: DEFAULT_SETTINGS.key,
      [STORAGE_KEYS.triggerModifier]: DEFAULT_SETTINGS.modifier,
    });
    setStatus("Shortcut reset to Z. Reload the page you are testing on.");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

async function initialize() {
  try {
    const storedValues = await getStorageValues([
      STORAGE_KEYS.backendBaseUrl,
      STORAGE_KEYS.triggerKey,
      STORAGE_KEYS.triggerModifier,
    ]);

    const settings = {
      backendBaseUrl:
        normalizeBackendBaseUrl(storedValues[STORAGE_KEYS.backendBaseUrl]) || DEFAULT_SETTINGS.backendBaseUrl,
      key: normalizeShortcutKey(storedValues[STORAGE_KEYS.triggerKey]) || DEFAULT_SETTINGS.key,
      modifier: normalizeShortcutModifier(storedValues[STORAGE_KEYS.triggerModifier]),
    };

    applySettingsToForm(settings);
    updateShortcutPreview();
    setStatus("", "");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function getSettingsFromForm() {
  return {
    backendBaseUrl: normalizeBackendBaseUrl(backendBaseUrlInput.value),
    key: sanitizeShortcutKeyInput(triggerKeyInput.value),
    modifier: normalizeShortcutModifier(triggerModifierSelect.value),
  };
}

function applySettingsToForm(settings) {
  backendBaseUrlInput.value = settings.backendBaseUrl;
  applyShortcutToForm(settings);
}

function applyShortcutToForm(shortcut) {
  triggerKeyInput.value = shortcut.key.toUpperCase();
  triggerModifierSelect.value = shortcut.modifier;
}

function updateShortcutPreview() {
  const shortcut = getSettingsFromForm();
  shortcutPreview.textContent = `Current shortcut: ${formatShortcutLabel(shortcut)}`;
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

function normalizeBackendBaseUrl(value) {
  const normalizedValue = String(value || "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(normalizedValue) ? normalizedValue : "";
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

function getStorageValues(keys) {
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

function setStorageValues(values) {
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

function setStatus(message, state = "") {
  statusText.textContent = message;
  if (state) {
    statusText.dataset.state = state;
    return;
  }

  delete statusText.dataset.state;
}
