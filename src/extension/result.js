const RESULT_STORAGE_PREFIX = "clarity-result:";
const DEFAULT_EXPLANATION_MODE = "default";
const ELI12_EXPLANATION_MODE = "eli12";

const selectedTextElement = document.getElementById("selected-text");
const errorSection = document.getElementById("error-section");
const errorTextElement = document.getElementById("error-text");
const definitionSection = document.getElementById("definition-section");
const definitionLabelElement = document.getElementById("definition-label");
const definitionTextElement = document.getElementById("definition-text");
const usageSection = document.getElementById("usage-section");
const usageLabelElement = document.getElementById("usage-label");
const usageTextElement = document.getElementById("usage-text");
const copyButton = document.getElementById("copy-button");
const simplifyButton = document.getElementById("simplify-button");

const viewState = {
  selection: null,
  regularExplanation: null,
  simpleExplanation: null,
  currentMode: DEFAULT_EXPLANATION_MODE,
  error: "",
};

void initialize();

async function initialize() {
  const resultId = new URLSearchParams(window.location.search).get("id");

  if (!resultId) {
    renderError("No result was provided.");
    return;
  }

  try {
    const storageKey = `${RESULT_STORAGE_PREFIX}${resultId}`;
    const storedValues = await getStorageValues([storageKey]);
    const payload = storedValues[storageKey];

    if (!payload) {
      renderError("This result is no longer available.");
      return;
    }

    viewState.selection = normalizeSelection(payload.selection || { text: payload.selectedText, contextText: "" });
    selectedTextElement.textContent = viewState.selection.text || "No selected text provided.";

    if (payload.error) {
      viewState.error = payload.error;
      renderError(payload.error);
      simplifyButton.hidden = true;
    } else {
      viewState.regularExplanation = normalizeExplanation(payload.explanation, DEFAULT_EXPLANATION_MODE);
      renderExplanation(viewState.regularExplanation);
      updateSimplifyButton();
    }

    copyButton.addEventListener("click", async () => {
      try {
        await copyTextToClipboard(buildCopyText());
        copyButton.textContent = "Copied";

        window.setTimeout(() => {
          copyButton.textContent = "Copy";
        }, 1400);
      } catch (error) {
        copyButton.textContent = "Failed";

        window.setTimeout(() => {
          copyButton.textContent = "Copy";
        }, 1400);
      }
    });

    simplifyButton.addEventListener("click", () => {
      void handleSimplifyToggle();
    });

    await removeStorageValue(storageKey);
  } catch (error) {
    renderError(error.message);
  }
}

async function handleSimplifyToggle() {
  if (!viewState.regularExplanation) {
    return;
  }

  if (viewState.currentMode === ELI12_EXPLANATION_MODE) {
    renderExplanation(viewState.regularExplanation);
    return;
  }

  if (viewState.simpleExplanation) {
    renderExplanation(viewState.simpleExplanation);
    return;
  }

  simplifyButton.disabled = true;
  simplifyButton.textContent = "Simplifying...";

  try {
    const response = await sendRuntimeMessage({
      action: "GET_EXPLANATION",
      selection: viewState.selection,
      mode: ELI12_EXPLANATION_MODE,
      sourceExplanation: viewState.regularExplanation,
    });

    viewState.simpleExplanation = normalizeExplanation(response.explanation, ELI12_EXPLANATION_MODE);
    renderExplanation(viewState.simpleExplanation);
  } catch (error) {
    errorTextElement.textContent = error.message || "Something went wrong.";
    errorSection.hidden = false;
  } finally {
    simplifyButton.disabled = false;
    updateSimplifyButton();
  }
}

function renderExplanation(explanation) {
  const labels = getExplanationLabels();
  const normalizedExplanation = normalizeExplanation(explanation, DEFAULT_EXPLANATION_MODE);

  viewState.error = "";
  errorSection.hidden = true;
  definitionLabelElement.textContent = labels.definition;
  usageLabelElement.textContent = labels.usage;
  definitionTextElement.textContent = normalizedExplanation?.definition || "No explanation returned.";
  usageTextElement.textContent = normalizedExplanation?.usage || "No extra detail returned.";
  definitionSection.hidden = false;
  usageSection.hidden = false;
  viewState.currentMode = normalizedExplanation?.mode || DEFAULT_EXPLANATION_MODE;
  updateSimplifyButton();
}

function renderError(message) {
  viewState.error = message || "Something went wrong.";
  errorTextElement.textContent = message || "Something went wrong.";
  errorSection.hidden = false;
  definitionSection.hidden = true;
  usageSection.hidden = true;
}

function updateSimplifyButton() {
  if (!viewState.regularExplanation || viewState.error) {
    simplifyButton.hidden = true;
    return;
  }

  simplifyButton.hidden = false;
  simplifyButton.textContent =
    viewState.currentMode === ELI12_EXPLANATION_MODE
      ? "Back to regular"
      : "Explain like I'm 12";
}

function buildCopyText() {
  if (viewState.error) {
    return [`Selected text`, viewState.selection?.text || "", "", `Error`, viewState.error].join("\n");
  }

  const explanation =
    viewState.currentMode === ELI12_EXPLANATION_MODE && viewState.simpleExplanation
      ? viewState.simpleExplanation
      : viewState.regularExplanation;

  const labels = getExplanationLabels();

  return [
    `Selected text`,
    viewState.selection?.text || "",
    "",
    labels.definition,
    explanation?.definition || "",
    "",
    labels.usage,
    explanation?.usage || "",
  ].join("\n");
}

function getExplanationLabels() {
  return {
    definition: "Meaning",
    usage: "In context",
  };
}

function normalizeSelection(selection) {
  return {
    text: normalizeText(selection?.text),
    contextText: normalizeText(selection?.contextText),
  };
}

function normalizeExplanation(explanation, fallbackMode) {
  return {
    definition: normalizeText(explanation?.definition),
    usage: normalizeText(explanation?.usage),
    mode: normalizeMode(explanation?.mode || fallbackMode),
  };
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeMode(mode) {
  return String(mode || DEFAULT_EXPLANATION_MODE).trim().toLowerCase() === ELI12_EXPLANATION_MODE
    ? ELI12_EXPLANATION_MODE
    : DEFAULT_EXPLANATION_MODE;
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();

  const copied = document.execCommand("copy");
  textarea.remove();

  if (!copied) {
    throw new Error("Copy failed.");
  }
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

function getStorageValues(keys) {
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

function removeStorageValue(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(key, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve();
    });
  });
}
