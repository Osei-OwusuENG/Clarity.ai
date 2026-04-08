const popupState = {
  popup: null,
  requestId: 0,
  activeText: "",
  activeCacheKey: "",
  activeMode: "default",
  isManuallyPositioned: false,
  dragPointerId: null,
  dragOffsetX: 0,
  dragOffsetY: 0,
  anchorPoint: { x: 24, y: 24 },
  cache: new Map(),
  pendingSelection: null,
  pendingAnchorPoint: { x: 24, y: 24 },
  lastSelection: null,
  lastAnchorPoint: { x: 24, y: 24 },
};

const CACHE_LIMIT = 25;
const MAX_CONTEXT_LENGTH = 420;
const CONTEXT_SIDE_WINDOW = 160;
const SELECTION_UPDATE_KEYS = new Set(["Shift", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
const SHORTCUT_KEY_STORAGE = "triggerShortcutKey";
const SHORTCUT_MODIFIER_STORAGE = "triggerShortcutModifier";
const VALID_SHORTCUT_MODIFIERS = new Set(["none", "alt", "ctrl", "meta", "shift"]);
const DEFAULT_EXPLANATION_MODE = "default";
const ELI12_EXPLANATION_MODE = "eli12";
const DEEP_EXPLANATION_MODE = "deep";
const DEFAULT_SHORTCUT = {
  key: "z",
  modifier: "none",
};

let shortcutConfig = { ...DEFAULT_SHORTCUT };

void loadShortcutConfig();

if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") {
      return;
    }

    if (changes[SHORTCUT_KEY_STORAGE] || changes[SHORTCUT_MODIFIER_STORAGE]) {
      void loadShortcutConfig();
    }
  });
}

if (chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.action !== "GET_SELECTION_CONTEXT") {
      return false;
    }

    sendResponse({
      ok: true,
      selection: getCurrentSelectionPayload() || popupState.pendingSelection,
    });
    return false;
  });
}

document.addEventListener("mouseup", (event) => {
  if (event.button !== 0 || isInsidePopup(event.target)) {
    return;
  }

  updatePendingSelection(getCurrentSelectionPayload(), {
    x: event.clientX,
    y: event.clientY,
  });
});

document.addEventListener("keyup", (event) => {
  if (!SELECTION_UPDATE_KEYS.has(event.key) || isInsidePopup(event.target)) {
    return;
  }

  const selection = getCurrentSelectionPayload();
  const selectionRect = getSelectionRect();
  updatePendingSelection(
    selection,
    {
      x: selectionRect?.right ?? popupState.pendingAnchorPoint.x,
      y: selectionRect?.bottom ?? popupState.pendingAnchorPoint.y,
    },
    { keepPopupOpen: true }
  );
});

document.addEventListener("selectionchange", () => {
  if (isActiveSelectionInsidePopup()) {
    return;
  }

  const selection = getCurrentSelectionPayload();

  if (!selection?.text) {
    clearPendingSelection();
    closePopup();
    return;
  }

  const selectionRect = getSelectionRect();
  updatePendingSelection(
    selection,
    {
      x: selectionRect?.right ?? popupState.pendingAnchorPoint.x,
      y: selectionRect?.bottom ?? popupState.pendingAnchorPoint.y,
    },
    { keepPopupOpen: true }
  );

  if (
    popupState.popup &&
    popupState.activeCacheKey &&
    getSelectionCacheKey(selection, popupState.activeMode) !== popupState.activeCacheKey
  ) {
    closePopup();
  }
});

document.addEventListener(
  "mousedown",
  (event) => {
    if (popupState.popup && !popupState.popup.contains(event.target)) {
      closePopup();
    }
  },
  true
);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closePopup();
    clearPendingSelection();
    return;
  }

  if (!shouldTriggerExplanation(event)) {
    return;
  }

  const selection = getCurrentSelectionPayload() || popupState.pendingSelection || popupState.lastSelection;

  if (!selection?.text) {
    return;
  }

  const selectionRect = getSelectionRect();
  const anchorPoint = selectionRect
    ? { x: selectionRect.right, y: selectionRect.bottom }
    : popupState.pendingSelection?.text
      ? popupState.pendingAnchorPoint
      : popupState.lastAnchorPoint;

  updatePendingSelection(selection, anchorPoint, { keepPopupOpen: true });

  event.preventDefault();
  void showExplanation(selection, anchorPoint);
});

async function showExplanation(selectionPayload, anchorPoint, options = {}) {
  const { force = false, mode = DEFAULT_EXPLANATION_MODE, sourceExplanation = null } = options;
  const selection = normalizeSelectionPayload(selectionPayload);

  if (!selection) {
    return;
  }

  const selectedText = selection.text;
  const normalizedMode = normalizeExplanationMode(mode);
  const cacheKey = getSelectionCacheKey(selection, normalizedMode, sourceExplanation);

  if (!force && popupState.popup && popupState.activeCacheKey === cacheKey) {
    popupState.anchorPoint = anchorPoint;
    positionPopup(popupState.popup, anchorPoint);
    return;
  }

  popupState.activeText = selectedText;
  popupState.activeCacheKey = cacheKey;
  popupState.activeMode = normalizedMode;
  popupState.isManuallyPositioned = false;
  popupState.anchorPoint = anchorPoint;

  const popup = ensurePopup();
  const requestId = ++popupState.requestId;

  renderLoadingState(popup, selectedText, normalizedMode);
  positionPopup(popup, anchorPoint);

  if (popupState.cache.has(cacheKey)) {
    renderExplanationState(popup, selection, popupState.cache.get(cacheKey));
    positionPopup(popup, anchorPoint);
    return;
  }

  try {
    const response = await sendRuntimeMessage({
      action: "GET_EXPLANATION",
      selection,
      mode: normalizedMode,
      sourceExplanation,
    });

    if (requestId !== popupState.requestId) {
      return;
    }

    popupState.cache.set(cacheKey, response.explanation);
    trimCache(popupState.cache, CACHE_LIMIT);
    renderExplanationState(popup, selection, response.explanation);
    positionPopup(popup, anchorPoint);
  } catch (error) {
    if (requestId !== popupState.requestId) {
      return;
    }

    renderErrorState(popup, selectedText, error.message);
    positionPopup(popup, anchorPoint);
  }
}

function ensurePopup() {
  if (popupState.popup) {
    return popupState.popup;
  }

  const popup = document.createElement("div");
  popup.id = "clarity-popup";
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-live", "polite");

  popupState.popup = popup;
  (document.body || document.documentElement).appendChild(popup);
  return popup;
}

function closePopup() {
  popupState.requestId += 1;
  popupState.activeText = "";
  popupState.activeCacheKey = "";
  popupState.activeMode = DEFAULT_EXPLANATION_MODE;
  popupState.isManuallyPositioned = false;
  popupState.dragPointerId = null;

  if (popupState.popup) {
    popupState.popup.remove();
    popupState.popup = null;
  }

  if (!getCurrentSelectionPayload()) {
    clearPendingSelection();
  }
}

function updatePendingSelection(selectionPayload, anchorPoint, options = {}) {
  const { keepPopupOpen = false } = options;
  const selection = normalizeSelectionPayload(selectionPayload);
  const nextAnchorPoint = {
    x: Number.isFinite(anchorPoint?.x) ? anchorPoint.x : popupState.pendingAnchorPoint.x,
    y: Number.isFinite(anchorPoint?.y) ? anchorPoint.y : popupState.pendingAnchorPoint.y,
  };

  popupState.pendingSelection = selection;
  popupState.pendingAnchorPoint = nextAnchorPoint;

  if (selection?.text) {
    popupState.lastSelection = selection;
    popupState.lastAnchorPoint = nextAnchorPoint;
  }

  if (!selection?.text && !keepPopupOpen) {
    closePopup();
  }
}

function clearPendingSelection() {
  popupState.pendingSelection = null;
}

function renderLoadingState(popup, selectedText, mode) {
  popup.dataset.state = "loading";
  const { body } = renderScaffold(popup, selectedText);
  const labels = getExplanationLabels(selectedText, mode);

  const statusRow = document.createElement("div");
  statusRow.className = "clarity-status";

  const text = document.createElement("p");
  text.className = "clarity-message";
  text.textContent =
    mode === ELI12_EXPLANATION_MODE
      ? "Simplifying this for a 12-year-old..."
      : mode === DEEP_EXPLANATION_MODE
        ? "Building a deeper explanation..."
        : "Generating an explanation...";

  statusRow.append(text);
  body.append(
    statusRow,
    createLoadingSection(labels.definition),
    createLoadingSection(labels.usage, "clarity-section clarity-section--usage")
  );
}

function renderExplanationState(popup, selection, explanation) {
  popup.dataset.state = "ready";
  const selectedText = selection.text;
  const copyText = buildCopyText(selectedText, explanation);
  const { body, actions } = renderScaffold(popup, selectedText);
  const labels = getExplanationLabels(selectedText, explanation.mode);

  body.appendChild(createSection(labels.definition, explanation.definition));
  body.appendChild(createSection(labels.usage, explanation.usage, "clarity-section clarity-section--usage"));
  appendExplanationActions(actions, selection, explanation, copyText);
}

function renderErrorState(popup, selectedText, message) {
  popup.dataset.state = "error";
  const { body, actions } = renderScaffold(popup, selectedText);
  const isExtensionReloadError = isExtensionReloadMessage(message);
  const isBackendSetupError = isBackendSetupMessage(message);

  const errorMessage = document.createElement("p");
  errorMessage.className = "clarity-message clarity-message--error";
  errorMessage.textContent = isExtensionReloadError
    ? "The extension was reloaded. Refresh this page, then try again."
    : normalizePopupErrorMessage(message);

  if (isExtensionReloadError) {
    const refreshButton = createButton("Refresh page", "clarity-button clarity-button--accent");
    refreshButton.addEventListener("click", () => {
      window.location.reload();
    });
    actions.appendChild(refreshButton);
  } else {
    const retryButton = createButton("Retry", "clarity-button clarity-button--accent");
    retryButton.addEventListener("click", () => {
      const retrySelection =
        popupState.pendingSelection || {
          text: selectedText,
          contextText: "",
        };

      void showExplanation(
        retrySelection,
        popupState.anchorPoint,
        {
          force: true,
          mode: popupState.activeMode,
          sourceExplanation: getCachedExplanation(retrySelection, DEFAULT_EXPLANATION_MODE),
        }
      );
    });
    actions.appendChild(retryButton);

    if (isBackendSetupError) {
      const settingsButton = createButton("Open settings", "clarity-button clarity-button--outline");
      settingsButton.addEventListener("click", () => {
        void openOptionsPage();
      });
      actions.appendChild(settingsButton);
    }
  }
  body.appendChild(errorMessage);
}

function renderScaffold(popup, selectedText) {
  popup.replaceChildren();

  const header = document.createElement("div");
  header.className = "clarity-header";
  enablePopupDrag(popup, header);

  const brand = document.createElement("div");
  brand.className = "clarity-brand";

  const title = document.createElement("p");
  title.className = "clarity-title";
  title.textContent = "Clarity";

  const subtitle = document.createElement("p");
  subtitle.className = "clarity-subtitle";
  subtitle.textContent = "Explain what you're reading in place.";

  brand.append(title, subtitle);
  header.appendChild(brand);

  const preview = document.createElement("div");
  preview.className = "clarity-preview";
  preview.textContent = truncateText(selectedText, 180);

  const body = document.createElement("div");
  body.className = "clarity-body";

  const actions = document.createElement("div");
  actions.className = "clarity-actions";

  popup.append(header, preview, body, actions);
  return { body, actions };
}

function createSection(label, text, className = "clarity-section") {
  const section = document.createElement("section");
  section.className = className;

  const heading = document.createElement("p");
  heading.className = "clarity-section-label";
  heading.textContent = label;

  const content = document.createElement("p");
  content.className = "clarity-section-text";
  content.textContent = text || "No extra detail returned.";

  section.append(heading, content);
  return section;
}

function createLoadingSection(label, className = "clarity-section") {
  const section = document.createElement("section");
  section.className = `${className} clarity-section--loading`;

  const heading = document.createElement("p");
  heading.className = "clarity-section-label";
  heading.textContent = label;

  const skeleton = document.createElement("div");
  skeleton.className = "clarity-skeleton";

  ["100%", "88%", "62%"].forEach((width) => {
    const line = document.createElement("span");
    line.className = "clarity-skeleton-line";
    line.style.width = width;
    skeleton.appendChild(line);
  });

  section.append(heading, skeleton);
  return section;
}

function createButton(label, className) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  return button;
}

function createCopyButton(copyText) {
  const button = createButton("Copy", "clarity-button clarity-button--outline clarity-copy");

  button.addEventListener("click", async () => {
    try {
      await copyTextToClipboard(copyText);
      button.textContent = "Copied";

      window.setTimeout(() => {
        if (button.isConnected) {
          button.textContent = "Copy";
        }
      }, 1400);
    } catch (error) {
      button.textContent = "Failed";

      window.setTimeout(() => {
        if (button.isConnected) {
          button.textContent = "Copy";
        }
      }, 1400);
    }
  });

  return button;
}

function appendExplanationActions(actions, selection, explanation, copyText) {
  if (explanation.mode !== DEFAULT_EXPLANATION_MODE) {
    const backButton = createButton("Back to regular", "clarity-button clarity-button--outline clarity-button--secondary");
    backButton.addEventListener("click", () => {
      void showExplanation(selection, popupState.anchorPoint, {
        mode: DEFAULT_EXPLANATION_MODE,
      });
    });
    actions.appendChild(backButton);
  }

  if (explanation.mode !== ELI12_EXPLANATION_MODE) {
    const simplifyButton = createButton(
      "Explain like I'm 12",
      "clarity-button clarity-button--accent"
    );
    simplifyButton.addEventListener("click", () => {
      void showExplanation(selection, popupState.anchorPoint, {
        mode: ELI12_EXPLANATION_MODE,
        sourceExplanation: explanation,
      });
    });
    actions.appendChild(simplifyButton);
  }

  if (explanation.mode !== DEEP_EXPLANATION_MODE) {
    const deepButton = createButton("Explain deeply", "clarity-button clarity-button--accent");
    deepButton.addEventListener("click", () => {
      void showExplanation(selection, popupState.anchorPoint, {
        mode: DEEP_EXPLANATION_MODE,
        sourceExplanation: explanation,
      });
    });
    actions.appendChild(deepButton);
  }

  if (copyText) {
    actions.appendChild(createCopyButton(copyText));
  }
}

function positionPopup(popup, anchorPoint) {
  requestAnimationFrame(() => {
    if (!popup.isConnected) {
      return;
    }

    if (popupState.isManuallyPositioned) {
      return;
    }

    const margin = 20;
    const rect = popup.getBoundingClientRect();
    const desiredLeft = anchorPoint.x + 12;
    const desiredTop = anchorPoint.y + 12;
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);

    popup.style.left = `${Math.max(margin, Math.min(desiredLeft, maxLeft))}px`;
    popup.style.top = `${Math.max(margin, Math.min(desiredTop, maxTop))}px`;
  });
}

function enablePopupDrag(popup, header) {
  header.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target instanceof Element && event.target.closest("button")) {
      return;
    }

    const rect = popup.getBoundingClientRect();
    popupState.dragPointerId = event.pointerId;
    popupState.dragOffsetX = event.clientX - rect.left;
    popupState.dragOffsetY = event.clientY - rect.top;
    popupState.isManuallyPositioned = true;
    header.setPointerCapture(event.pointerId);
    popup.dataset.dragging = "true";
    event.preventDefault();
  });

  header.addEventListener("pointermove", (event) => {
    if (popupState.dragPointerId !== event.pointerId) {
      return;
    }

    movePopupToPosition(
      event.clientX - popupState.dragOffsetX,
      event.clientY - popupState.dragOffsetY
    );
  });

  header.addEventListener("pointerup", (event) => {
    if (popupState.dragPointerId !== event.pointerId) {
      return;
    }

    if (header.hasPointerCapture(event.pointerId)) {
      header.releasePointerCapture(event.pointerId);
    }

    popupState.dragPointerId = null;
    popup.dataset.dragging = "false";
  });

  header.addEventListener("pointercancel", (event) => {
    if (popupState.dragPointerId !== event.pointerId) {
      return;
    }

    if (header.hasPointerCapture(event.pointerId)) {
      header.releasePointerCapture(event.pointerId);
    }

    popupState.dragPointerId = null;
    popup.dataset.dragging = "false";
  });
}

function movePopupToPosition(left, top) {
  if (!popupState.popup) {
    return;
  }

  const margin = 20;
  const rect = popupState.popup.getBoundingClientRect();
  const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
  const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);

  popupState.popup.style.left = `${Math.max(margin, Math.min(left, maxLeft))}px`;
  popupState.popup.style.top = `${Math.max(margin, Math.min(top, maxTop))}px`;
}

function getCurrentSelectionPayload() {
  const activeElement = document.activeElement;

  if (isTextField(activeElement)) {
    const selectedValue = getTextFieldSelection(activeElement);

    if (selectedValue) {
      return {
        text: selectedValue,
        contextText: getTextFieldContext(activeElement),
        pageTitle: getPageTitle(),
        hostname: getPageHostname(),
      };
    }
  }

  const selection = getBrowserSelection();

  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || isSelectionInsidePopup(selection)) {
    return null;
  }

  const selectedText = normalizeSelection(selection.toString());

  if (!selectedText) {
    return null;
  }

  return {
    text: selectedText,
    contextText: getRangeContextText(selection.getRangeAt(0), selectedText),
    pageTitle: getPageTitle(),
    hostname: getPageHostname(),
  };
}

function getSelectionRect() {
  const selection = getBrowserSelection();

  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  return selection.getRangeAt(0).getBoundingClientRect();
}

function isSelectionInsidePopup(selection) {
  return isInsidePopup(selection.anchorNode) || isInsidePopup(selection.focusNode);
}

function isActiveSelectionInsidePopup() {
  const selection = getBrowserSelection();

  if (!selection) {
    return false;
  }

  return isSelectionInsidePopup(selection);
}

function getBrowserSelection() {
  try {
    return typeof window.getSelection === "function" ? window.getSelection() : null;
  } catch (error) {
    return null;
  }
}

function isInsidePopup(target) {
  if (!popupState.popup || !target) {
    return false;
  }

  const element =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;

  return Boolean(element && popupState.popup.contains(element));
}

function isTextField(element) {
  if (element instanceof HTMLTextAreaElement) {
    return true;
  }

  return (
    element instanceof HTMLInputElement &&
    /^(?:email|password|search|tel|text|url)$/i.test(element.type)
  );
}

function isEditableTarget(target) {
  const element =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;

  if (!element) {
    return false;
  }

  return Boolean(element.closest("input, textarea, [contenteditable=''], [contenteditable='true']"));
}

function getTextFieldSelection(element) {
  const start = element.selectionStart;
  const end = element.selectionEnd;

  if (typeof start !== "number" || typeof end !== "number" || end <= start) {
    return "";
  }

  return normalizeSelection(element.value.slice(start, end));
}

function getTextFieldContext(element) {
  const value = String(element?.value || "");
  const start = element.selectionStart;
  const end = element.selectionEnd;

  if (typeof start !== "number" || typeof end !== "number" || end <= start) {
    return "";
  }

  return normalizeSelection([
    value.slice(Math.max(0, start - CONTEXT_SIDE_WINDOW), start),
    value.slice(start, end),
    value.slice(end, Math.min(value.length, end + CONTEXT_SIDE_WINDOW)),
  ].join(" "));
}

function getRangeContextText(range, selectedText) {
  const contextContainer = getContextContainer(range.commonAncestorContainer);
  const containerText = normalizeSelection(contextContainer?.textContent || "");

  if (!containerText) {
    return selectedText;
  }

  return buildContextSnippet(containerText, selectedText);
}

function getContextContainer(node) {
  let element = node instanceof Element ? node : node?.parentElement;

  while (element) {
    if (isContextBlockElement(element)) {
      return element;
    }

    element = element.parentElement;
  }

  return document.body || document.documentElement;
}

function isContextBlockElement(element) {
  if (!(element instanceof Element)) {
    return false;
  }

  if (/^(?:P|LI|BLOCKQUOTE|PRE|TD|TH|ARTICLE|SECTION|MAIN|ASIDE|DIV)$/i.test(element.tagName)) {
    return normalizeSelection(element.textContent || "").length >= 40;
  }

  return false;
}

function buildContextSnippet(containerText, selectedText) {
  const normalizedContainer = normalizeSelection(containerText);
  const normalizedSelected = normalizeSelection(selectedText);

  if (!normalizedContainer || !normalizedSelected) {
    return normalizedSelected;
  }

  const containerLower = normalizedContainer.toLowerCase();
  const selectedLower = normalizedSelected.toLowerCase();
  const matchIndex = containerLower.indexOf(selectedLower);

  if (matchIndex === -1) {
    return normalizedSelected;
  }

  const windowStart = Math.max(0, matchIndex - CONTEXT_SIDE_WINDOW);
  const windowEnd = Math.min(
    normalizedContainer.length,
    matchIndex + normalizedSelected.length + CONTEXT_SIDE_WINDOW
  );

  return truncateText(normalizeSelection(normalizedContainer.slice(windowStart, windowEnd)), MAX_CONTEXT_LENGTH);
}

function normalizeSelection(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizeSelectionPayload(selection) {
  const text = normalizeSelection(selection?.text);

  if (!text) {
    return null;
  }

  return {
    text,
    contextText: normalizeSelection(selection?.contextText).slice(0, MAX_CONTEXT_LENGTH),
    pageTitle: normalizeSelection(selection?.pageTitle).slice(0, 140),
    hostname: normalizeSelection(selection?.hostname).slice(0, 120),
  };
}

function getSelectionCacheKey(selection, mode = DEFAULT_EXPLANATION_MODE, sourceExplanation = null) {
  const normalizedSelection = normalizeSelectionPayload(selection);
  const normalizedSourceExplanation = sourceExplanation
    ? {
        definition: normalizeSelection(sourceExplanation.definition),
        usage: normalizeSelection(sourceExplanation.usage),
      }
    : null;

  if (!normalizedSelection) {
    return "";
  }

  return [
    normalizeExplanationMode(mode),
    normalizedSelection.text,
    normalizedSelection.contextText,
    normalizedSelection.pageTitle,
    normalizedSelection.hostname,
    normalizeExplanationMode(mode) === DEFAULT_EXPLANATION_MODE
      ? ""
      : normalizedSourceExplanation?.definition || "",
    normalizeExplanationMode(mode) === DEFAULT_EXPLANATION_MODE
      ? ""
      : normalizedSourceExplanation?.usage || "",
  ].join("\n<context>\n");
}

function getPageTitle() {
  return document.title || "";
}

function getPageHostname() {
  return window.location?.hostname || "";
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function trimCache(cache, maxEntries) {
  while (cache.size > maxEntries) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
}

function shouldTriggerExplanation(event) {
  const eventKey = normalizeShortcutKey(event.key);

  if (!eventKey || event.repeat || isInsidePopup(event.target) || isEditableTarget(event.target)) {
    return false;
  }

  return (
    eventKey === shortcutConfig.key &&
    matchesShortcutModifier(event, shortcutConfig.modifier)
  );
}

function matchesShortcutModifier(event, modifier) {
  switch (modifier) {
    case "alt":
      return event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    case "ctrl":
      return event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
    case "meta":
      return event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey;
    case "shift":
      return event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
    case "none":
    default:
      return !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
  }
}

async function loadShortcutConfig() {
  try {
    const storedValues = await getStorageValues([SHORTCUT_KEY_STORAGE, SHORTCUT_MODIFIER_STORAGE]);
    shortcutConfig = {
      key: normalizeShortcutKey(storedValues[SHORTCUT_KEY_STORAGE]) || DEFAULT_SHORTCUT.key,
      modifier: normalizeShortcutModifier(storedValues[SHORTCUT_MODIFIER_STORAGE]),
    };
  } catch (error) {
    shortcutConfig = { ...DEFAULT_SHORTCUT };
  }
}

function normalizeShortcutKey(value) {
  const normalizedValue = String(value || "").trim().toLowerCase();
  return /^[a-z0-9]$/.test(normalizedValue) ? normalizedValue : "";
}

function normalizeShortcutModifier(value) {
  const normalizedValue = String(value || "").trim().toLowerCase();
  return VALID_SHORTCUT_MODIFIERS.has(normalizedValue) ? normalizedValue : DEFAULT_SHORTCUT.modifier;
}

function isExtensionReloadMessage(message) {
  return /extension context invalidated|message port closed/i.test(String(message || ""));
}

function getExplanationLabels(selectedText, mode = DEFAULT_EXPLANATION_MODE) {
  return {
    definition: "Meaning",
    usage: mode === DEEP_EXPLANATION_MODE ? "In context + examples" : "In context",
  };
}

function normalizeExplanationMode(mode) {
  const normalizedMode = String(mode || DEFAULT_EXPLANATION_MODE).trim().toLowerCase();

  if (normalizedMode === ELI12_EXPLANATION_MODE) {
    return ELI12_EXPLANATION_MODE;
  }

  if (normalizedMode === DEEP_EXPLANATION_MODE) {
    return DEEP_EXPLANATION_MODE;
  }

  return DEFAULT_EXPLANATION_MODE;
}

function getCachedExplanation(selection, mode, sourceExplanation = null) {
  return popupState.cache.get(getSelectionCacheKey(selection, mode, sourceExplanation)) || null;
}

function buildCopyText(selectedText, explanation) {
  const labels = getExplanationLabels(selectedText, explanation?.mode);

  return [labels.definition, explanation.definition, "", labels.usage, explanation.usage]
    .filter((line) => line !== undefined)
    .join("\n");
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
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();

  const copied = document.execCommand("copy");
  textarea.remove();

  if (!copied) {
    throw new Error("Copy failed.");
  }
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

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(normalizeRuntimeErrorMessage(chrome.runtime.lastError.message)));
        return;
      }

      if (!response) {
        reject(new Error("Clarity did not return a response."));
        return;
      }

      if (!response.ok) {
        reject(new Error(response.error || "Clarity request failed."));
        return;
      }

      resolve(response);
    });
  });
}

function normalizeRuntimeErrorMessage(message) {
  if (isExtensionReloadMessage(message)) {
    return "Extension context invalidated.";
  }

  return message;
}

function normalizePopupErrorMessage(message) {
  const normalizedMessage = String(message || "").trim();

  if (!normalizedMessage) {
    return "Clarity could not generate an explanation right now. Please try again.";
  }

  if (
    /select some text first|shorter highlight|shorter selection|busy right now|try again later|could not connect|could not generate an explanation|backend url|gemini_api_key|rejected the extension origin|health check|server is running|backend is missing/i.test(
      normalizedMessage
    )
  ) {
    return normalizedMessage;
  }

  return "Clarity could not generate an explanation right now. Please try again.";
}

function isBackendSetupMessage(message) {
  return /backend url|gemini_api_key|rejected the extension origin|server is running|backend is missing/i.test(
    String(message || "")
  );
}

async function openOptionsPage() {
  try {
    await sendRuntimeMessage({ action: "OPEN_OPTIONS" });
  } catch (error) {
    console.error("Unable to open Clarity settings:", error);
  }
}

