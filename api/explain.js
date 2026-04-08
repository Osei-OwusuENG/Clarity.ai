const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const API_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_MODE = "default";
const ELI12_MODE = "eli12";
const DEEP_MODE = "deep";
const VALID_MODES = new Set([DEFAULT_MODE, ELI12_MODE, DEEP_MODE]);
const MAX_SELECTION_LENGTH = 1500;
const MAX_CONTEXT_LENGTH = 420;
const CACHE_TTL_MS = 1000 * 60 * 60 * 12;
const CACHE_LIMIT = 500;
const EXPLANATION_PIPELINE_VERSION = "v21";
const SHOULD_LOG_PROMPT_METRICS = /^(?:1|true|yes)$/i.test(
  String(process.env.CLARITY_LOG_PROMPT_METRICS || "")
);
const SYSTEM_INSTRUCTION = [
  "You are Clarity, a helpful learning assistant.",
  "Explain highlighted text clearly, naturally, and in plain English.",
  "Focus on what the text means and what it means in the context provided.",
  "Be specific and thorough without sounding robotic.",
  "Never mention prompts, JSON, field names, or formatting instructions.",
].join("\n");

function createRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sendErrorResponse(res, status, code, message, requestId) {
  res.status(status).json({
    error: {
      code,
      message,
      requestId,
    },
  });
}

function logPromptMetrics(requestId, request, metrics) {
  if (!SHOULD_LOG_PROMPT_METRICS) {
    return;
  }

  console.info("Clarity prompt metrics:", {
    requestId,
    mode: request?.mode || DEFAULT_MODE,
    cached: Boolean(metrics?.cached),
    usedFallback: Boolean(metrics?.usedFallback),
    actualUsage: metrics?.actualUsage || createEmptyTokenUsage(),
    steps: metrics?.steps || [],
    promptEstimates: metrics?.promptEstimates || {},
  });
}

function normalizeServerError(error) {
  const message = String(error?.message || "");

  if (
    error instanceof SyntaxError ||
    /unexpected token|unexpected end of json input|json\.parse|invalid json/i.test(message)
  ) {
    return {
      status: 400,
      code: "invalid_request",
      message: "Clarity received an invalid request payload.",
    };
  }

  if (/Missing selected text/i.test(message)) {
    return {
      status: 400,
      code: "missing_selection",
      message: "Select some text first.",
    };
  }

  if (/Select a shorter passage/i.test(message)) {
    return {
      status: 400,
      code: "selection_too_long",
      message: "That highlight is too long. Try a shorter selection.",
    };
  }

  if (/blocked this request/i.test(message)) {
    return {
      status: 400,
      code: "blocked_selection",
      message: "Clarity could not explain that selection clearly. Try a smaller or clearer highlight.",
    };
  }

  if (/aborted|timeout/i.test(message)) {
    return {
      status: 503,
      code: "timeout",
      message: "Clarity took too long to respond. Please try again.",
    };
  }

  return {
    status: 503,
    code: "service_unavailable",
    message: "Clarity could not generate an explanation right now. Please try again.",
  };
}

const responseCache = globalThis.__clarityResponseCache || new Map();
globalThis.__clarityResponseCache = responseCache;

module.exports = async function handler(req, res) {
  const requestId = createRequestId();
  applyCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    sendErrorResponse(res, 405, "method_not_allowed", "This request method is not supported.", requestId);
    return;
  }

  if (!GEMINI_API_KEY) {
    console.error("Clarity API misconfiguration:", { requestId, reason: "missing_gemini_api_key" });
    sendErrorResponse(
      res,
      503,
      "service_unavailable",
      "The backend is missing GEMINI_API_KEY. Add it to .env and restart the server.",
      requestId
    );
    return;
  }

  if (!isAllowedOrigin(req)) {
    sendErrorResponse(
      res,
      403,
      "origin_not_allowed",
      "This backend rejected the extension origin. Check ALLOWED_EXTENSION_ORIGINS in .env.",
      requestId
    );
    return;
  }

  try {
    const body = parseRequestBody(req.body);
    const request = normalizeRequest(body);

    if (!request.selection.text) {
      sendErrorResponse(res, 400, "missing_selection", "Select some text first.", requestId);
      return;
    }

    if (request.selection.text.length > MAX_SELECTION_LENGTH) {
      sendErrorResponse(res, 400, "selection_too_long", "That highlight is too long. Try a shorter selection.", requestId);
      return;
    }

    const cacheKey = getCacheKey(request);
    const cached = getCachedResponse(cacheKey);

    if (cached) {
      const metrics = buildRequestMetrics(request, {
        explanation: cached,
        cached: true,
      });
      logPromptMetrics(requestId, request, metrics);
      res.status(200).json({
        explanation: cached,
        cached: true,
        metrics,
      });
      return;
    }

    const generationResult = await generateExplanation(request);
    const explanation = generationResult.explanation;
    storeCachedResponse(cacheKey, explanation);
    logPromptMetrics(requestId, request, generationResult.metrics);
    res.status(200).json({
      explanation,
      cached: false,
      metrics: generationResult.metrics,
    });
  } catch (error) {
    const normalizedError = normalizeServerError(error);
    console.error("Clarity API error:", {
      requestId,
      code: normalizedError.code,
      message: error?.message || "Unknown error",
      stack: error?.stack || null,
    });
    sendErrorResponse(res, normalizedError.status, normalizedError.code, normalizedError.message, requestId);
  }
};

function applyCorsHeaders(req, res) {
  const origin = req.headers.origin;
  const allowedOrigins = getAllowedOrigins();

  if (allowedOrigins.length > 0 && origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function getAllowedOrigins() {
  return String(process.env.ALLOWED_EXTENSION_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function isAllowedOrigin(req) {
  const allowedOrigins = getAllowedOrigins();

  if (allowedOrigins.length === 0) {
    return true;
  }

  const origin = req.headers.origin;
  return Boolean(origin && allowedOrigins.includes(origin));
}

function parseRequestBody(body) {
  if (!body) {
    return {};
  }

  if (typeof body === "string") {
    return JSON.parse(body);
  }

  return body;
}

function normalizeRequest(input) {
  return {
    selection: normalizeSelection(input?.selection),
    mode: normalizeMode(input?.mode),
    sourceExplanation: normalizeExplanation(input?.sourceExplanation, DEFAULT_MODE),
  };
}

function normalizeSelection(selection) {
  if (typeof selection === "string") {
    return {
      text: normalizeText(selection),
      contextText: "",
      pageTitle: "",
      hostname: "",
    };
  }

  return {
    text: normalizeText(selection?.text).slice(0, MAX_SELECTION_LENGTH),
    contextText: normalizeText(selection?.contextText).slice(0, MAX_CONTEXT_LENGTH),
    pageTitle: normalizeText(selection?.pageTitle).slice(0, 140),
    hostname: normalizeText(selection?.hostname).slice(0, 120),
  };
}

function normalizeMode(mode) {
  const normalizedMode = normalizeText(mode).toLowerCase() || DEFAULT_MODE;
  return VALID_MODES.has(normalizedMode) ? normalizedMode : DEFAULT_MODE;
}

function normalizeExplanation(explanation, fallbackMode) {
  if (!explanation || typeof explanation !== "object") {
    return null;
  }

  return {
    definition: normalizeText(explanation.definition),
    usage: normalizeText(explanation.usage),
    mode: normalizeMode(explanation.mode || fallbackMode),
  };
}

function normalizeText(value) {
  return decodeCommonEscapes(String(value || ""))
    .replace(/\s+/g, " ")
    .trim();
}

function hashText(text) {
  let hash = 2166136261;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function getCacheKey(request) {
  return JSON.stringify({
    version: EXPLANATION_PIPELINE_VERSION,
    mode: request.mode,
    selection: request.selection,
    sourceExplanation: request.mode === DEFAULT_MODE ? null : request.sourceExplanation,
  });
}

function getCachedResponse(cacheKey) {
  const entry = responseCache.get(cacheKey);

  if (!entry) {
    return null;
  }

  if (Date.now() - entry.updatedAt > CACHE_TTL_MS) {
    responseCache.delete(cacheKey);
    return null;
  }

  responseCache.delete(cacheKey);
  responseCache.set(cacheKey, entry);
  return entry.explanation;
}

function storeCachedResponse(cacheKey, explanation) {
  responseCache.set(cacheKey, {
    explanation,
    updatedAt: Date.now(),
  });

  while (responseCache.size > CACHE_LIMIT) {
    const firstKey = responseCache.keys().next().value;
    responseCache.delete(firstKey);
  }
}

async function generateExplanation(request) {
  const steps = [];
  let tokenUsage = createEmptyTokenUsage();

  try {
    const primaryPrompt = buildPrompt(request);
    const primaryResult = await requestGeminiExplanation(request, primaryPrompt);
    steps.push(
      createPromptStep("primary", request.mode, primaryPrompt, primaryResult.tokenUsage, {
        explanation: primaryResult.explanation,
      })
    );
    tokenUsage = addTokenUsage(tokenUsage, primaryResult.tokenUsage);
    let explanation = primaryResult.explanation;

    if (shouldRepairExplanation(request, explanation)) {
      try {
        const repairPrompt = buildRepairPrompt(request, explanation);
        const repairResult = await requestGeminiExplanation(request, repairPrompt);
        steps.push(
          createPromptStep("repair", request.mode, repairPrompt, repairResult.tokenUsage, {
            explanation: repairResult.explanation,
          })
        );
        tokenUsage = addTokenUsage(tokenUsage, repairResult.tokenUsage);
        explanation = chooseBetterExplanation(request, explanation, repairResult.explanation);
      } catch (error) {
        console.warn("Clarity repair generation failed:", error);
        steps.push(
          createPromptStep("repair", request.mode, buildRepairPrompt(request, explanation), createEmptyTokenUsage(), {
            ok: false,
            error: error?.message || "unknown_repair_error",
          })
        );
      }
    }

    if (isUnusableExplanation(request, explanation)) {
      try {
        const rescuePrompt = buildRescuePrompt(request, explanation);
        const rescueResult = await requestGeminiExplanation(request, rescuePrompt);
        steps.push(
          createPromptStep("rescue", request.mode, rescuePrompt, rescueResult.tokenUsage, {
            explanation: rescueResult.explanation,
          })
        );
        tokenUsage = addTokenUsage(tokenUsage, rescueResult.tokenUsage);
        explanation = chooseBetterExplanation(request, explanation, rescueResult.explanation);
      } catch (error) {
        console.warn("Clarity rescue generation failed:", error);
        steps.push(
          createPromptStep("rescue", request.mode, buildRescuePrompt(request, explanation), createEmptyTokenUsage(), {
            ok: false,
            error: error?.message || "unknown_rescue_error",
          })
        );
      }
    }

    const usedFallback = isUnusableExplanation(request, explanation);
    const finalExplanation = usedFallback ? buildLastResortExplanation(request) : explanation;

    return {
      explanation: finalExplanation,
      tokenUsage,
      metrics: buildRequestMetrics(request, {
        explanation: finalExplanation,
        actualUsage: tokenUsage,
        steps,
        usedFallback,
        cached: false,
      }),
    };
  } catch (error) {
    console.warn("Clarity primary generation failed:", error);
    const fallbackExplanation = buildLastResortExplanation(request);
    return {
      explanation: fallbackExplanation,
      tokenUsage,
      metrics: buildRequestMetrics(request, {
        explanation: fallbackExplanation,
        actualUsage: tokenUsage,
        steps,
        usedFallback: true,
        cached: false,
        error: error?.message || "primary_generation_failed",
      }),
    };
  }
}

async function requestGeminiExplanation(request, promptText) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(API_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: SYSTEM_INSTRUCTION,
            },
          ],
        },
        contents: [
          {
            parts: [
              {
                text: promptText,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: getTemperatureForMode(request.mode),
          maxOutputTokens: getMaxOutputTokensForMode(request.mode),
          responseMimeType: "application/json",
          responseSchema: {
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
          },
        },
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data?.error?.message || `Gemini request failed with status ${response.status}.`);
    }

    return {
      explanation: extractExplanationFromGemini(data, request),
      tokenUsage: extractTokenUsage(data),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function createEmptyTokenUsage() {
  return {
    promptTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

function extractTokenUsage(data) {
  const promptTokens = toTokenCount(data?.usageMetadata?.promptTokenCount);
  const outputTokens = toTokenCount(
    data?.usageMetadata?.candidatesTokenCount ?? data?.usageMetadata?.outputTokenCount
  );
  const totalTokens = toTokenCount(data?.usageMetadata?.totalTokenCount) || promptTokens + outputTokens;

  return {
    promptTokens,
    outputTokens,
    totalTokens,
  };
}

function addTokenUsage(baseUsage, nextUsage) {
  return {
    promptTokens: toTokenCount(baseUsage?.promptTokens) + toTokenCount(nextUsage?.promptTokens),
    outputTokens: toTokenCount(baseUsage?.outputTokens) + toTokenCount(nextUsage?.outputTokens),
    totalTokens:
      toTokenCount(baseUsage?.totalTokens) + toTokenCount(nextUsage?.totalTokens) ||
      toTokenCount(baseUsage?.promptTokens) +
        toTokenCount(baseUsage?.outputTokens) +
        toTokenCount(nextUsage?.promptTokens) +
        toTokenCount(nextUsage?.outputTokens),
  };
}

function createPromptStep(step, mode, promptText, tokenUsage, options = {}) {
  const promptEstimate = estimateTextTokens(promptText);
  const explanation = options.explanation || null;

  return {
    step,
    mode,
    ok: options.ok !== false,
    error: options.error || "",
    promptCharacters: String(promptText || "").length,
    estimatedPromptTokens: promptEstimate,
    actualPromptTokens: toTokenCount(tokenUsage?.promptTokens),
    actualOutputTokens: toTokenCount(tokenUsage?.outputTokens),
    actualTotalTokens: toTokenCount(tokenUsage?.totalTokens),
    definitionLength: String(explanation?.definition || "").length,
    usageLength: String(explanation?.usage || "").length,
  };
}

function toTokenCount(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? Math.round(numericValue) : 0;
}

function getTemperatureForMode(mode) {
  if (mode === ELI12_MODE) {
    return 0.15;
  }

  if (mode === DEEP_MODE) {
    return 0.18;
  }

  return 0.1;
}

function getMaxOutputTokensForMode(mode) {
  if (mode === ELI12_MODE) {
    return 180;
  }

  if (mode === DEEP_MODE) {
    return 560;
  }

  return 280;
}

function estimateTextTokens(text) {
  const normalizedText = String(text || "");

  if (!normalizedText) {
    return 0;
  }

  const wordCount = normalizedText.trim().split(/\s+/).filter(Boolean).length;
  const charBasedEstimate = normalizedText.length / 4;
  const wordBasedEstimate = wordCount * 1.25;

  return Math.max(1, Math.round(Math.max(charBasedEstimate, wordBasedEstimate)));
}

function buildPromptVariantEstimate(mode, promptText) {
  const estimatedPromptTokens = estimateTextTokens(promptText);
  const maxOutputTokens = getMaxOutputTokensForMode(mode);

  return {
    mode,
    promptCharacters: String(promptText || "").length,
    estimatedPromptTokens,
    maxOutputTokens,
  };
}

function buildRequestMetrics(request, options = {}) {
  const {
    explanation = null,
    actualUsage = createEmptyTokenUsage(),
    steps = [],
    usedFallback = false,
    cached = false,
    error = "",
  } = options;
  const sourceExplanation =
    request.sourceExplanation ||
    (explanation
      ? {
          definition: explanation.definition,
          usage: explanation.usage,
          mode: request.mode,
        }
      : null);

  const defaultRequest = {
    ...request,
    mode: DEFAULT_MODE,
    sourceExplanation: null,
  };
  const eli12Request = {
    ...request,
    mode: ELI12_MODE,
    sourceExplanation,
  };
  const deepRequest = {
    ...request,
    mode: DEEP_MODE,
    sourceExplanation,
  };
  const repairPrompt = explanation ? buildRepairPrompt(defaultRequest, explanation) : "";
  const rescuePrompt = explanation ? buildRescuePrompt(defaultRequest, explanation) : "";

  return {
    model: GEMINI_MODEL,
    cached,
    usedFallback,
    error,
    actualUsage: {
      promptTokens: toTokenCount(actualUsage.promptTokens),
      outputTokens: toTokenCount(actualUsage.outputTokens),
      totalTokens: toTokenCount(actualUsage.totalTokens),
    },
    promptEstimates: {
      default: buildPromptVariantEstimate(DEFAULT_MODE, buildPrompt(defaultRequest)),
      eli12: buildPromptVariantEstimate(ELI12_MODE, buildPrompt(eli12Request)),
      deep: buildPromptVariantEstimate(DEEP_MODE, buildPrompt(deepRequest)),
      repair: repairPrompt
        ? buildPromptVariantEstimate(DEFAULT_MODE, repairPrompt)
        : null,
      rescue: rescuePrompt
        ? buildPromptVariantEstimate(DEFAULT_MODE, rescuePrompt)
        : null,
    },
    steps,
  };
}

function buildPrompt(request) {
  if (request.mode === ELI12_MODE) {
    return buildEli12Prompt(request);
  }

  if (request.mode === DEEP_MODE) {
    return buildDeepPrompt(request);
  }

  const contextText = normalizeText(request.selection.contextText);
  const pageTitle = normalizeText(request.selection.pageTitle);
  const contextSignals = getSelectionContextSignals(request.selection.text, contextText);

  return [
    "Return JSON with definition and usage.",
    "Definition: explain what the highlighted text means clearly.",
    "Usage: explain what the highlighted text means in this exact context.",
    "Be natural, specific, and easy to follow.",
    pageTitle ? `Page title: ${pageTitle}` : "",
    contextSignals.compoundPhrase ? `Nearby phrase: ${contextSignals.compoundPhrase}` : "",
    contextText ? `Context: ${contextText}` : "",
    `Highlighted text: ${request.selection.text}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildPhraseDecompositionHint(selectionText) {
  const wordCount = countWords(selectionText);

  if (wordCount < 2 || classifySelectionKind(selectionText) === "sentence-or-passage") {
    return "";
  }

  return "If the highlight is a multi-word phrase, explain the core concept and how the modifiers narrow or qualify it.";
}


function buildRepairPrompt(request, explanation) {
  const contextSignals = getSelectionContextSignals(request.selection.text, request.selection.contextText || "");

  return [
    request.mode === DEEP_MODE
      ? "Rewrite the explanation so it is clearer, more specific, more detailed, and noticeably deeper than the regular version."
      : "Rewrite the explanation so it is clearer, more specific, and more useful.",
    request.mode === DEEP_MODE
      ? "Definition should explain the meaning clearly and briefly unpack the important parts if the highlight is a technical phrase."
      : "Definition should explain the meaning of the highlighted text clearly.",
    request.mode === DEEP_MODE
      ? "Usage should explain what it means in this exact context and include one short concrete example or illustration."
      : "Usage should explain what it means in this exact context.",
    request.mode === DEEP_MODE
      ? "Avoid vague filler, avoid just repeating the regular explanation, and make the extra detail genuinely useful."
      : "Avoid vague filler and avoid repeating the highlighted text without explaining it.",
    buildPhraseDecompositionHint(request.selection.text),
    "",
    `Current definition: ${normalizeText(explanation?.definition)}`,
    `Current usage: ${normalizeText(explanation?.usage)}`,
    contextSignals.compoundPhrase ? `Nearby phrase: ${contextSignals.compoundPhrase}` : "",
    `Context: ${request.selection.contextText || "not available"}`,
    `Highlighted text: ${request.selection.text}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildEli12Prompt(request) {
  const sourceDefinition = normalizeText(request.sourceExplanation?.definition);
  const sourceUsage = normalizeText(request.sourceExplanation?.usage);
  const hasSourceExplanation = Boolean(sourceDefinition || sourceUsage);
  const contextText = normalizeText(request.selection.contextText);
  const pageTitle = normalizeText(request.selection.pageTitle);
  const contextSignals = getSelectionContextSignals(request.selection.text, contextText);

  return [
    "Explain this for a 12-year-old.",
    "Use short everyday words.",
    "Definition: explain what the highlighted text means simply.",
    "Usage: explain what it means in the context where it appears.",
    `Highlighted text: ${request.selection.text}`,
    pageTitle ? `Page title: ${pageTitle}` : "",
    contextSignals.compoundPhrase ? `Nearby phrase: ${contextSignals.compoundPhrase}` : "",
    hasSourceExplanation ? `Current definition: ${sourceDefinition}` : "",
    hasSourceExplanation ? `Current in-context explanation: ${sourceUsage}` : "",
    !hasSourceExplanation && contextText ? `Context: ${contextText}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildDeepPrompt(request) {
  const sourceDefinition = normalizeText(request.sourceExplanation?.definition);
  const sourceUsage = normalizeText(request.sourceExplanation?.usage);
  const hasSourceExplanation = Boolean(sourceDefinition || sourceUsage);
  const contextText = normalizeText(request.selection.contextText);
  const pageTitle = normalizeText(request.selection.pageTitle);
  const contextSignals = getSelectionContextSignals(request.selection.text, contextText);

  return [
    "Give a more detailed explanation than the regular version.",
    "Keep it natural, clear, and easy to read.",
    "Make the deep version noticeably more informative than the regular one.",
    "Definition: explain the core meaning in fuller detail and briefly unpack the important parts if it is a multi-word technical phrase.",
    "Usage: explain how it is being used here, why the modifiers matter, and include a short concrete example or illustration.",
    `Highlighted text: ${request.selection.text}`,
    pageTitle ? `Page title: ${pageTitle}` : "",
    contextSignals.compoundPhrase ? `Nearby phrase: ${contextSignals.compoundPhrase}` : "",
    hasSourceExplanation ? `Current definition: ${sourceDefinition}` : "",
    hasSourceExplanation ? `Current in-context explanation: ${sourceUsage}` : "",
    contextText ? `Context: ${contextText}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildRescuePrompt(request, explanation) {
  const contextSignals = getSelectionContextSignals(request.selection.text, request.selection.contextText || "");

  return [
    request.mode === DEEP_MODE
      ? "The previous deep explanation was not usable. Write a clean replacement that is clearly deeper than the regular version."
      : "The previous answer was not usable. Write a clean replacement.",
    request.mode === DEEP_MODE
      ? "Definition: explain the meaning clearly and unpack the key parts of the phrase when relevant."
      : "Definition: explain the meaning clearly.",
    request.mode === DEEP_MODE
      ? "Usage: explain what it means in this context and include one short concrete example or illustration."
      : "Usage: explain what it means in this context.",
    "Do not include meta commentary or formatting language.",
    buildPhraseDecompositionHint(request.selection.text),
    "",
    `Page title: ${request.selection.pageTitle || "not available"}`,
    contextSignals.compoundPhrase ? `Nearby phrase: ${contextSignals.compoundPhrase}` : "",
    `Context: ${request.selection.contextText || "not available"}`,
    `Highlighted text: ${request.selection.text}`,
    `Bad definition: ${normalizeText(explanation?.definition)}`,
    `Bad usage: ${normalizeText(explanation?.usage)}`,
  ].join("\n");
}

function buildLastResortExplanation(request) {
  const selectionText = normalizeText(request.selection?.text);
  const selectionLower = selectionText.toLowerCase();
  const contextText = normalizeText(request.selection?.contextText);
  const contextLower = contextText.toLowerCase();
  const selectionKind = classifySelectionKind(selectionText);
  const isEli12 = request.mode === "eli12";
  const contextSignals = getSelectionContextSignals(selectionText, request.selection?.contextText || "");
  const compoundFallback = buildCompoundAwareFallback(selectionText, contextSignals, isEli12);
  const multiWordPhraseFallback = buildMultiWordPhraseFallback(
    selectionText,
    contextText,
    normalizeText(request.selection?.pageTitle),
    isEli12
  );
  const namedEntityFallback = buildNamedEntityFallback(
    selectionText,
    contextText,
    normalizeText(request.selection?.pageTitle),
    isEli12
  );

  if (compoundFallback) {
    return {
      ...compoundFallback,
      mode: request.mode,
    };
  }

  if (request.mode === DEEP_MODE) {
    return buildDeepFallbackExplanation(request, {
      selectionText,
      contextText,
      selectionKind,
      compoundFallback,
      multiWordPhraseFallback,
      namedEntityFallback,
    });
  }

  if (multiWordPhraseFallback) {
    return {
      ...multiWordPhraseFallback,
      mode: request.mode,
    };
  }

  if (/\bbpe\b/.test(selectionLower) && /\bimplementation\b/.test(selectionLower)) {
    return {
      definition: isEli12
        ? "A BPE implementation is the actual code that breaks text into reusable pieces called tokens."
        : "A BPE implementation is the actual code or system that performs Byte Pair Encoding, a tokenization method that breaks text into reusable pieces.",
      usage: isEli12
        ? "Here, it means the specific BPE tokenizer setup or code being talked about."
        : "Here, it means the particular BPE tokenizer or code setup being discussed, tested, or evaluated.",
      mode: request.mode,
    };
  }

  if (/\bencoded?\b/.test(selectionLower) && looksLikeComputingContext(contextLower)) {
    return {
      definition: isEli12
        ? "Encoded means changed into a form a computer can work with."
        : "Encoded means converted into a representation that a computer, model, or system can store, transmit, or process.",
      usage: isEli12
        ? "Here, it means the text or data was turned into tokens, bytes, or another machine-readable form."
        : "Here, it means the text or data has been turned into tokens, bytes, or another machine-readable form for the system being discussed.",
      mode: request.mode,
    };
  }

  if (/\bwebsockets?\b/.test(selectionLower) && /\bcommunication\b/.test(selectionLower)) {
    return {
      definition: isEli12
        ? "WebSockets let two sides stay connected and send messages back and forth right away."
        : "WebSockets let a client and server keep one connection open and exchange messages both ways in real time.",
      usage: isEli12
        ? "Here, the writer is saying WebSockets allow instant back-and-forth communication."
        : "Here, the writer is making the point that WebSockets support instant two-way communication without opening a new request each time.",
      mode: request.mode,
    };
  }

  if (/\bimplementation\b/.test(selectionLower)) {
    const modifier = selectionText.replace(/\bimplementation\b/i, "").trim();

    return {
      definition: isEli12
        ? "An implementation is the real built or coded version of an idea or method."
        : "An implementation is the actual built, coded, or working version of an idea, method, or algorithm.",
      usage: modifier
        ? `Here, it means the specific working version of ${modifier} being discussed.`
        : "Here, it means the specific working version being discussed.",
      mode: request.mode,
    };
  }

  if (selectionKind === "phrase") {
    return {
      definition: isEli12
        ? "This phrase is making a specific point in simpler words."
        : "This phrase is expressing a specific idea, relationship, or claim in the sentence.",
      usage: isEli12
        ? "Here, it is the point the writer is trying to make."
        : "Here, it states the particular point the writer is making in this context.",
      mode: request.mode,
    };
  }

  if (namedEntityFallback) {
    return {
      ...namedEntityFallback,
      mode: request.mode,
    };
  }

  return {
    definition: isEli12
      ? `${selectionText || "This term"} means something specific in this passage, but Clarity could not fully explain it right now.`
      : `${selectionText || "This term"} has a specific meaning in this passage, but Clarity could not fully resolve it from the model response.`,
    usage: contextSignals.compoundPhrase
      ? `Here, it is part of the phrase "${contextSignals.compoundPhrase}" in the sentence.`
      : isEli12
        ? "Here, it is being used in a specific way in this sentence."
        : "Here, it is being used with a specific meaning in this sentence.",
    mode: request.mode,
  };
}

function buildNamedEntityFallback(selectionText, contextText, pageTitle, isEli12) {
  if (!looksLikeNamedEntity(selectionText)) {
    return null;
  }

  if (getSelectionContextSignals(selectionText, contextText).compoundPhrase) {
    return null;
  }

  const inferredType = inferNamedEntityType(contextText, pageTitle);

  if (inferredType === "person" && !looksLikePersonNameSurface(selectionText)) {
    return null;
  }

  switch (inferredType) {
    case "product":
      return {
        definition: isEli12
          ? `${selectionText} looks like the name of a product, tool, or project in this passage.`
          : `${selectionText} appears to be a proper name here, most likely a product, tool, project, or branded concept rather than a general dictionary word.`,
        usage: isEli12
          ? `Here, the sentence is using "${selectionText}" as the name of the thing being talked about.`
          : `Here, "${selectionText}" is being used as the name of the product, tool, or concept the sentence is referring to.`,
      };
    case "company":
      return {
        definition: isEli12
          ? `${selectionText} looks like the name of a company, brand, or group in this passage.`
          : `${selectionText} appears to be the proper name of a company, brand, organization, or named entity in this passage.`,
        usage: isEli12
          ? `Here, it is being used as a name, not as an ordinary vocabulary word.`
          : `Here, it functions as a proper name identifying the company, brand, or organization being discussed.`,
      };
    case "person":
      return {
        definition: isEli12
          ? `${selectionText} looks like a person's name in this passage.`
          : `${selectionText} appears to be a person's name or a named identity in this passage rather than a general descriptive term.`,
        usage: isEli12
          ? `Here, it is being used to name the person being talked about.`
          : `Here, it is functioning as the person's name or named identity within the sentence.`,
      };
    default:
      return {
        definition: isEli12
          ? `${selectionText} looks like a special name in this passage, not a regular vocabulary word.`
          : `${selectionText} appears to be a named thing in this passage, such as a proper noun, title, label, or branded concept, rather than a normal dictionary word.`,
        usage: isEli12
          ? `Here, it is being used as the name of the thing the sentence is talking about.`
          : `Here, it is being used as the name or label of the thing the sentence is referring to.`,
      };
  }
}

function buildDeepFallbackExplanation(request, options = {}) {
  const selectionText = normalizeText(options.selectionText || request.selection?.text);
  const contextText = normalizeText(options.contextText || request.selection?.contextText);
  const pageTitle = normalizeText(request.selection?.pageTitle);
  const combinedContext = [selectionText, contextText, pageTitle].filter(Boolean).join(" ");
  const sourceDefinition = normalizeText(request.sourceExplanation?.definition);
  const sourceUsage = normalizeText(request.sourceExplanation?.usage);
  const modifierDetails = getTechnicalPhraseModifierDetails(selectionText, combinedContext);
  const modifierBreakdown = buildDeepModifierBreakdown(modifierDetails);
  const exampleText = buildDeepConcreteExample(selectionText, combinedContext, modifierDetails);
  const baseDefinition =
    sourceDefinition ||
    normalizeText(options.multiWordPhraseFallback?.definition) ||
    normalizeText(options.compoundFallback?.definition) ||
    normalizeText(options.namedEntityFallback?.definition) ||
    "This highlight refers to a specific concept in the passage.";
  const baseUsage =
    sourceUsage ||
    normalizeText(options.multiWordPhraseFallback?.usage) ||
    normalizeText(options.compoundFallback?.usage) ||
    normalizeText(options.namedEntityFallback?.usage) ||
    "Here, it is being used with a specific meaning in this sentence.";

  return {
    definition: joinExplanationSentences([baseDefinition, modifierBreakdown]),
    usage: joinExplanationSentences([baseUsage, exampleText]),
    mode: request.mode,
  };
}

function buildMultiWordPhraseFallback(selectionText, contextText, pageTitle, isEli12) {
  const normalizedSelection = normalizeText(selectionText);

  if (countWords(normalizedSelection) < 2) {
    return null;
  }

  const combinedContext = [normalizedSelection, normalizeText(contextText), normalizeText(pageTitle)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const headInfo = getTechnicalPhraseHeadInfo(normalizedSelection);
  const modifierDescriptions = getTechnicalPhraseModifierDescriptions(normalizedSelection, combinedContext);
  const looksTechnical = looksLikeTechnicalPhraseContext(combinedContext);

  if (!headInfo && !modifierDescriptions.length) {
    return null;
  }

  if (!looksTechnical && modifierDescriptions.length < 2 && !headInfo) {
    return null;
  }

  const definitionBase = headInfo
    ? isEli12
      ? headInfo.definitionEli12
      : headInfo.definition
    : isEli12
      ? "a specific kind of system or process"
      : "a specific kind of system, process, or approach";
  const usageBase = headInfo
    ? isEli12
      ? headInfo.usageEli12
      : headInfo.usage
    : isEli12
      ? "Here, the phrase is describing the system or process being talked about"
      : "Here, the phrase is describing the system or process being discussed";
  const modifierClause = joinNaturalLanguageList(modifierDescriptions);
  const definitionLead = isEli12 ? "It means" : "It refers to";
  const cleanUsageBase = usageBase.replace(/[.]+$/, "");

  return {
    definition: modifierClause
      ? `${definitionLead} ${definitionBase}, specifically in a form that ${modifierClause}.`
      : `${definitionLead} ${definitionBase}.`,
    usage: modifierClause
      ? `${cleanUsageBase}. In this case, it is described as something that ${modifierClause}.`
      : `${cleanUsageBase}.`,
  };
}

function getTechnicalPhraseHeadInfo(selectionText) {
  const normalizedSelection = normalizeText(selectionText).toLowerCase();
  const headEntries = [
    {
      pattern: /\bprocessor\b.*\bai inference$/,
      definitionEli12: "a processor designed to run AI inference, meaning it can run a trained AI model to get answers or predictions",
      definition: "a processor designed to run AI inference, meaning it executes trained AI models to produce outputs or predictions",
      usageEli12: "Here, the phrase refers to the processor hardware the paper is describing for running AI tasks",
      usage: "Here, the phrase refers to the processor hardware being described as the platform for running AI inference workloads",
    },
    {
      pattern: /\binference processors?$/,
      definitionEli12: "processors designed to run model inference, meaning they use trained AI models to produce answers or predictions",
      definition: "processors designed to run inference workloads, meaning they execute trained models to produce outputs or predictions",
      usageEli12: "Here, the phrase refers to processor hardware built for running inference tasks",
      usage: "Here, the phrase refers to processor hardware intended for running inference workloads rather than general-purpose computing",
    },
    {
      pattern: /\bai inference$/,
      definitionEli12: "the process of running an AI model to get an answer or prediction",
      definition: "the process of running a trained AI model to produce outputs or decisions",
      usageEli12: "Here, the phrase refers to the part where the AI model is used to give an answer",
      usage: "Here, the phrase refers to the stage where a trained AI model is run to generate results",
    },
    {
      pattern: /\binference$/,
      definitionEli12: "the process of using a trained model to get an answer or prediction",
      definition: "the process of using a trained model to generate outputs, predictions, or decisions",
      usageEli12: "Here, the phrase refers to the stage where the trained model is being used",
      usage: "Here, the phrase refers to the stage where the trained model is actually being run",
    },
    {
      pattern: /\bprocessors?$/,
      definitionEli12: "a processor or computing unit that does the main calculation work",
      definition: "a processor or computing unit that performs the main computational work",
      usageEli12: "Here, the phrase refers to the processor being described",
      usage: "Here, the phrase refers to the processor or compute unit being discussed",
    },
    {
      pattern: /\baccelerator$/,
      definitionEli12: "a hardware unit built to speed up a specific kind of work",
      definition: "a hardware unit designed to speed up a specific class of computations",
      usageEli12: "Here, the phrase refers to the accelerator being described",
      usage: "Here, the phrase refers to the accelerator hardware being discussed",
    },
    {
      pattern: /\bchip$/,
      definitionEli12: "a computer chip or integrated circuit",
      definition: "a computer chip or integrated circuit",
      usageEli12: "Here, the phrase refers to the chip being talked about",
      usage: "Here, the phrase refers to the chip or silicon component being discussed",
    },
    {
      pattern: /\barchitecture$/,
      definitionEli12: "the overall design of a system",
      definition: "the overall design or structure of a system",
      usageEli12: "Here, the phrase refers to the design of the system",
      usage: "Here, the phrase refers to the system design being proposed or described",
    },
    {
      pattern: /\bframework$/,
      definitionEli12: "a structured system for building or running something",
      definition: "a structured framework or system for building or running something",
      usageEli12: "Here, the phrase refers to the framework being described",
      usage: "Here, the phrase refers to the framework or structured system being discussed",
    },
    {
      pattern: /\bpipeline$/,
      definitionEli12: "a sequence of steps used to do the job",
      definition: "a sequence of processing steps used to carry out the task",
      usageEli12: "Here, the phrase refers to the set of steps being used",
      usage: "Here, the phrase refers to the processing flow or sequence of steps being discussed",
    },
    {
      pattern: /\bmodel$/,
      definitionEli12: "a trained AI system used to produce answers or predictions",
      definition: "a trained model or system used to produce outputs or predictions",
      usageEli12: "Here, the phrase refers to the model being talked about",
      usage: "Here, the phrase refers to the model or learned system being discussed",
    },
    {
      pattern: /\bmethod$/,
      definitionEli12: "a method or way of doing the task",
      definition: "a method or approach for carrying out the task",
      usageEli12: "Here, the phrase refers to the method being described",
      usage: "Here, the phrase refers to the method being proposed or described",
    },
    {
      pattern: /\bapproach$/,
      definitionEli12: "a way of solving the problem",
      definition: "an approach or strategy for solving the problem",
      usageEli12: "Here, the phrase refers to the approach being described",
      usage: "Here, the phrase refers to the approach or strategy being discussed",
    },
    {
      pattern: /\balgorithm$/,
      definitionEli12: "a set of steps or rules for solving the task",
      definition: "an algorithm or set of rules used to solve the task",
      usageEli12: "Here, the phrase refers to the algorithm being used",
      usage: "Here, the phrase refers to the algorithm being discussed or evaluated",
    },
    {
      pattern: /\bsystem$/,
      definitionEli12: "a system or setup that performs the task",
      definition: "a system or overall setup that performs the task",
      usageEli12: "Here, the phrase refers to the system being described",
      usage: "Here, the phrase refers to the system or setup being discussed",
    },
    {
      pattern: /\bnetwork$/,
      definitionEli12: "a connected model or network used for the task",
      definition: "a network, often a neural network or connected model structure, used for the task",
      usageEli12: "Here, the phrase refers to the network being described",
      usage: "Here, the phrase refers to the network or model structure being discussed",
    },
  ];

  return headEntries.find((entry) => entry.pattern.test(normalizedSelection)) || null;
}

function getTechnicalPhraseModifierDescriptions(selectionText, combinedContext) {
  return getTechnicalPhraseModifierDetails(selectionText, combinedContext).map((detail) => detail.description);
}

function getTechnicalPhraseModifierDetails(selectionText, combinedContext) {
  const normalizedSelection = normalizeText(selectionText).toLowerCase();
  const modifierEntries = [
    {
      pattern: /\bcim\b/,
      label: "CIM",
      description: "uses compute-in-memory hardware so computation stays closer to memory and reduces data movement",
    },
    {
      pattern: /\ball[-\s]?on[-\s]?chip\b/,
      label: "all-on-chip",
      description: "keeps the work on the chip itself instead of pushing it elsewhere",
    },
    {
      pattern: /\bon-chip\b/,
      label: "on-chip",
      description: "keeps the work on the chip itself",
    },
    {
      pattern: /\boverclocking-tolerant\b/,
      label: "overclocking-tolerant",
      description: "can keep working even when the hardware is run above its usual clock speed",
    },
    {
      pattern: /\benergy-efficient\b/,
      label: "energy-efficient",
      description: "uses relatively little power",
    },
    {
      pattern: /\blow-power\b/,
      label: "low-power",
      description: "uses very little power",
    },
    {
      pattern: /\blightweight\b/,
      label: "lightweight",
      description: "uses relatively few computing resources",
    },
    {
      pattern: /\bedge\b/,
      label: "edge",
      description: "runs on or near the device where the data is produced instead of relying on a remote cloud server",
      include: () => looksLikeTechnicalPhraseContext(combinedContext),
    },
    {
      pattern: /\bfault-tolerant\b/,
      label: "fault-tolerant",
      description: "can keep working despite some faults or variations",
    },
    {
      pattern: /\bmemory-efficient\b/,
      label: "memory-efficient",
      description: "uses less memory",
    },
    {
      pattern: /\bresource-efficient\b/,
      label: "resource-efficient",
      description: "uses resources carefully",
    },
    {
      pattern: /\breal-time\b/,
      label: "real-time",
      description: "responds quickly enough for live use",
    },
    {
      pattern: /\bhigh-throughput\b/,
      label: "high-throughput",
      description: "handles many operations quickly",
    },
    {
      pattern: /\bprivacy-preserving\b/,
      label: "privacy-preserving",
      description: "is designed to keep data more private",
    },
    {
      pattern: /\bquantized\b/,
      label: "quantized",
      description: "uses lower-precision values to reduce compute and memory cost",
    },
    {
      pattern: /\brobust\b/,
      label: "robust",
      description: "keeps working under varied conditions",
    },
  ];
  const details = [];

  for (const entry of modifierEntries) {
    if (!entry.pattern.test(normalizedSelection)) {
      continue;
    }

    if (entry.include && !entry.include(normalizedSelection, combinedContext)) {
      continue;
    }

    if (!details.some((detail) => detail.description === entry.description)) {
      details.push({
        label: entry.label || "",
        description: entry.description,
      });
    }
  }

  return details;
}

function looksLikeTechnicalPhraseContext(text) {
  return /\b(ai|artificial intelligence|machine learning|model|inference|processor|chip|hardware|algorithm|architecture|framework|pipeline|accelerator|neural|compute|computing|memory|edge|paper|research)\b/i.test(
    normalizeText(text)
  );
}

function joinNaturalLanguageList(items) {
  const normalizedItems = items.map((item) => normalizeText(item)).filter(Boolean);

  if (!normalizedItems.length) {
    return "";
  }

  if (normalizedItems.length === 1) {
    return normalizedItems[0];
  }

  if (normalizedItems.length === 2) {
    return `${normalizedItems[0]} and ${normalizedItems[1]}`;
  }

  return `${normalizedItems.slice(0, -1).join(", ")}, and ${normalizedItems[normalizedItems.length - 1]}`;
}

function buildDeepModifierBreakdown(modifierDetails) {
  if (!modifierDetails.length) {
    return "";
  }

  const parts = modifierDetails.map(
    (detail) => `"${detail.label}" signals that it ${detail.description}`
  );

  return `Broken down, ${joinNaturalLanguageList(parts)}.`;
}

function buildDeepConcreteExample(selectionText, combinedContext, modifierDetails) {
  const normalizedSelection = normalizeText(selectionText).toLowerCase();
  const modifierLabels = new Set(modifierDetails.map((detail) => detail.label.toLowerCase()));
  const hasEdge = modifierLabels.has("edge");
  const hasEnergy = modifierLabels.has("energy-efficient") || modifierLabels.has("low-power");
  const hasLightweight = modifierLabels.has("lightweight");
  const hasCim = modifierLabels.has("cim");
  const mentionsInference = /\bai inference\b|\binference\b/.test(normalizedSelection);
  const mentionsProcessor = /\bprocessor\b|\bchip\b|\baccelerator\b/.test(normalizedSelection);
  const looksTechnical = looksLikeTechnicalPhraseContext(combinedContext);

  if (hasEdge && mentionsInference) {
    return "For example, a smart camera, wearable, or sensor could run a small model on the device itself to detect an event without sending all raw data to the cloud.";
  }

  if ((hasEnergy || hasLightweight) && mentionsInference) {
    return "For example, this could describe hardware meant to run a smaller AI model with low power and limited compute, such as an on-device detector in a battery-powered gadget.";
  }

  if (hasCim && mentionsProcessor) {
    return "For example, the paper may be describing a chip that reduces data movement between memory and compute so inference can run faster or more efficiently.";
  }

  if (looksTechnical && mentionsProcessor) {
    return "For example, this could refer to a processor architecture built to handle a specific AI workload more efficiently than a general-purpose setup.";
  }

  if (looksTechnical) {
    return "For example, this could describe a system or component that is being tuned for a more specific technical job than a general-purpose alternative.";
  }

  return "For example, you can think of it as the more specific version of the general idea the sentence is talking about.";
}

function looksLikeNamedEntity(text) {
  const normalizedText = normalizeText(text);

  if (!normalizedText) {
    return false;
  }

  if (/\s/.test(normalizedText) && normalizedText.split(/\s+/).length > 4) {
    return false;
  }

  return /^[A-Z][A-Za-z0-9]*(?:[\s-][A-Z][A-Za-z0-9]*)*$/.test(normalizedText);
}

function looksLikePersonNameSurface(text) {
  const normalizedText = normalizeText(text);
  const normalizedLower = normalizedText.toLowerCase();
  const wordCount = countWords(normalizedText);

  if (!/^[A-Z][A-Za-z]+(?:\s[A-Z][A-Za-z]+){0,2}$/.test(normalizedText)) {
    return false;
  }

  if (wordCount === 1 && /(?:ing|tion|sion|ment|ness|ity|ance|ence|ship|graphy|ology)$/i.test(normalizedLower)) {
    return false;
  }

  if (/\b(?:overclocking|recruitment|compression|engineering|training|classification|inference|encoding|decoding|processing)\b/i.test(normalizedLower)) {
    return false;
  }

  return true;
}

function inferNamedEntityType(contextText, pageTitle) {
  const combinedContext = `${normalizeText(contextText)} ${normalizeText(pageTitle)}`.toLowerCase();

  if (/\b(founder|ceo|designer|writer|author|artist|director|developer|engineer|person|he|she)\b/.test(combinedContext)) {
    return "person";
  }

  if (/\b(company|startup|brand|business|organization|team|studio|agency)\b/.test(combinedContext)) {
    return "company";
  }

  if (/\b(product|tool|app|platform|service|project|method|framework|model|software|feature|engine)\b/.test(combinedContext)) {
    return "product";
  }

  return "named-thing";
}

function getSelectionContextSignals(selectionText, contextText) {
  const normalizedSelection = normalizeText(selectionText);
  const normalizedContext = normalizeText(contextText);
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
  const selectionLower = normalizeText(selectionText).toLowerCase();
  const compoundPhrase = contextSignals.compoundPhrase;

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
      usage: compoundPhrase
        ? `Here, in "${compoundPhrase}", it describes behavior connected to hardware being run beyond its usual clock-speed setting.`
        : "Here, it refers to running hardware at a higher clock speed than its normal specification.",
    };
  }

  return buildSingleWordFallback(selectionText, isEli12, compoundPhrase);
}

function buildSingleWordFallback(selectionText, isEli12, compoundPhrase = "") {
  const selectionLower = normalizeText(selectionText).toLowerCase();

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

function classifySelectionKind(text) {
  const normalizedText = normalizeText(text);
  const wordCount = normalizedText ? normalizedText.split(/\s+/).length : 0;
  const hasSentencePunctuation = /[.!?]/.test(normalizedText);
  const hasClausePunctuation = /[:;,]/.test(normalizedText);
  const hasVerbLikeSignal =
    /\b(?:is|are|was|were|can|could|will|would|should|may|might|must|enable|enables|allow|allows|let|lets|make|makes|made|support|supports|drive|drives|cause|causes|mean|means|show|shows|use|uses|provide|provides)\b/i.test(normalizedText);

  if (wordCount >= 4 && !hasSentencePunctuation && hasVerbLikeSignal) {
    return "phrase";
  }

  if (wordCount <= 8 && !hasSentencePunctuation && !hasClausePunctuation) {
    return "word-or-phrase";
  }

  if (wordCount <= 20 && !hasSentencePunctuation) {
    return "phrase";
  }

  return "sentence-or-passage";
}

function extractExplanationFromGemini(data, request) {
  const blockedReason = data?.promptFeedback?.blockReason;

  if (blockedReason) {
    console.warn("Clarity Gemini blocked response; using fallback.", {
      blockReason: blockedReason,
      selection: request?.selection?.text || "",
    });
    return {
      definition: "",
      usage: "",
      mode: request.mode,
    };
  }

  const rawText = data?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();

  if (!rawText) {
    console.warn("Clarity Gemini returned an empty response; using fallback.", {
      selection: request?.selection?.text || "",
    });
    return {
      definition: "",
      usage: "",
      mode: request.mode,
    };
  }

  const explanation = parseExplanationFromRawText(rawText);
  const sanitizedExplanation = sanitizeGeneratedExplanation(explanation, request);

  if (!sanitizedExplanation?.definition || !sanitizedExplanation?.usage) {
    console.warn("Clarity Gemini returned an incomplete explanation payload.", {
      selection: request?.selection?.text || "",
      rawText,
    });
  }

  return sanitizedExplanation;
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
      extractJsonStringField(cleanedText, "context"),
      extractJsonStringField(cleanedText, "whyItMatters"),
      extractJsonStringField(cleanedText, "why"),
      extractJsonStringField(cleanedText, "importance")
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
    /definition\s*[:\-]\s*([\s\S]*?)(?=\n\s*(?:usage|in context|context|why it matters|why)\s*[:\-]|$)/i
  );
  const usageMatch = normalizedText.match(
    /(?:usage|in context|context)\s*[:\-]\s*([\s\S]*?)(?=\n\s*(?:why it matters|why)\s*[:\-]|$)/i
  );
  const whyMatch = normalizedText.match(/(?:why it matters|why)\s*[:\-]\s*([\s\S]*)$/i);

  return {
    definition: definitionMatch?.[1]?.trim() || "",
    usage: combineExplanationText(usageMatch?.[1], whyMatch?.[1]),
  };
}

function combineExplanationText(...parts) {
  return parts
    .map((part) => normalizeText(part))
    .filter(Boolean)
    .join(" ");
}

function sanitizeGeneratedExplanation(explanation, request) {
  const normalizedExplanation = normalizeExplanation(explanation, request.mode);
  let definition = cleanGeneratedField(normalizeText(normalizedExplanation?.definition));
  let usage = cleanGeneratedField(normalizeText(normalizedExplanation?.usage));

  if (isPlaceholderFieldValue(definition)) {
    definition = "";
  }

  if (isPlaceholderUsageValue(usage)) {
    usage = "";
  }

  if (looksTruncatedField(definition)) {
    definition = "";
  }

  if (looksTruncatedField(usage)) {
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

function buildFallbackUsage(request, definitionText = "") {
  const selectionText = normalizeText(request.selection?.text);
  const definitionSummary = summarizeDefinitionForUsage(definitionText, selectionText);
  const selectionLower = selectionText.toLowerCase();
  const contextText = normalizeText(request.selection?.contextText);
  const contextLower = contextText.toLowerCase();
  const pageTitle = normalizeText(request.selection?.pageTitle).toLowerCase();
  const hostname = normalizeText(request.selection?.hostname).toLowerCase();
  const combinedContext = [selectionLower, contextLower, pageTitle, normalizeText(definitionText).toLowerCase()].join(" ");
  const selectionKind = classifySelectionKind(selectionText);
  const contextType = detectContextType(request.selection);
  const multiWordPhraseFallback = buildMultiWordPhraseFallback(
    selectionText,
    contextText,
    normalizeText(request.selection?.pageTitle),
    request.mode === ELI12_MODE
  );

  if (request.mode === "eli12") {
    switch (selectionKind) {
      case "sentence-or-passage":
        return "Here, this part is explaining the main idea in the passage in a simpler way.";
      case "phrase":
        if (contextType === "profile") {
          return "Here, this phrase is being used as the person's role or job title on the profile.";
        }

        if (definitionSummary) {
          return `Here, the writer is saying that ${toSentenceFragment(definitionSummary)}.`;
        }

        if (multiWordPhraseFallback?.usage) {
          return multiWordPhraseFallback.usage;
        }

        return "Here, the writer is making a specific point with this phrase.";
      case "word-or-phrase":
      default:
        if (contextType === "profile") {
          return "Here, this is the label showing what this person does or how they describe themselves on the profile.";
        }

        if (looksLikeReligiousCalendarTerm(combinedContext)) {
          return "Here, this term means the fixed church calendar date used when working out Easter.";
        }

        if (definitionSummary) {
          return `Here, this term refers to ${definitionSummary}.`;
        }

        if (multiWordPhraseFallback?.usage) {
          return multiWordPhraseFallback.usage;
        }

        return "Here, this is the word or label the sentence is using for that idea or role.";
    }
  }

  if (selectionKind === "word-or-phrase" || selectionKind === "phrase") {
    if (selectionKind === "phrase") {
      if (definitionSummary) {
        return `Here, the sentence is saying that ${toSentenceFragment(definitionSummary)}.`;
      }

      if (multiWordPhraseFallback?.usage) {
        return multiWordPhraseFallback.usage;
      }

      return "Here, the sentence is making a specific claim or point with this phrase.";
    }

    if (contextType === "profile") {
      return "Here, this is being used as the person's role, profession, or self-description on the page.";
    }

    if (looksLikeReligiousCalendarTerm(combinedContext)) {
      return "Here, the term refers to the fixed church calendar date used to calculate Easter, rather than the exact astronomical equinox.";
    }

    if (looksLikePersonRoleDefinition(definitionText)) {
      return "Here, this phrase identifies the type of person or role being talked about.";
    }

    if (definitionSummary) {
      return `Here, "${selectionText}" refers to ${toSentenceFragment(definitionSummary)} in this sentence.`;
    }

    if (multiWordPhraseFallback?.usage) {
      return multiWordPhraseFallback.usage;
    }

    return "Here, this term points to the specific idea the sentence is talking about.";
  }

  return "Here, this part explains the key relationship or mechanism in the surrounding passage.";
}

function looksLikeReligiousCalendarTerm(text) {
  const normalizedText = normalizeText(text).toLowerCase();

  return (
    /\b(easter|paschal|church|christian|ecclesiastical|calendar)\b/.test(normalizedText) &&
    /\b(date|march|equinox|full moon|solstice)\b/.test(normalizedText)
  );
}

function looksLikeComputingContext(text) {
  return /\b(token|tokens|model|byte|bytes|string|strings|character|characters|encoding|encode|encoded|decoder|data|protocol|http|websocket|api|json|binary|compress|compression)\b/i.test(
    normalizeText(text)
  );
}

function summarizeDefinitionForUsage(definitionText, selectionText) {
  let summary = normalizeText(definitionText)
    .split(/(?<=[.!?])\s+/)[0]
    ?.trim();

  if (!summary) {
    return "";
  }

  const escapedSelection = escapeRegExp(normalizeText(selectionText));

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
  const normalizedText = cleanGeneratedField(normalizeText(text))
    .replace(/^[{[]+/, "")
    .replace(/[}\]]+$/, "")
    .trim();

  if (!normalizedText) {
    return "";
  }

  return normalizedText.replace(/[.]+$/, "");
}

function countWords(text) {
  const normalizedText = normalizeText(text);
  return normalizedText ? normalizedText.split(/\s+/).length : 0;
}

function looksLikePersonRoleDefinition(definitionText) {
  const normalizedText = normalizeText(definitionText).toLowerCase();

  return (
    /\btype of person\b/i.test(normalizedText) ||
    /\b(job title|profession|occupation|self-description)\b/i.test(normalizedText) ||
    /\b(?:a|an|the)\s+(?:person|professional|engineer|developer|designer|teacher|student|doctor|manager|founder|consultant|specialist)\b/i.test(
      normalizedText
    )
  );
}

function isProcessToRoleMismatch(selectionText, definitionText, usageText) {
  const normalizedSelection = normalizeText(selectionText).toLowerCase();
  const normalizedDefinition = normalizeText(definitionText).toLowerCase();
  const normalizedUsage = normalizeText(usageText).toLowerCase();
  const looksProcessLike =
    /\b(process|practice|activity|workflow|method of|act of|finding|attracting|interviewing|selecting|hiring|onboarding)\b/.test(
      normalizedDefinition
    ) || /\b(?:ment|tion|ing|ship|ance|ence)\b/.test(normalizedSelection);
  const looksRoleLike =
    /\b(person|role|profession|self-description|job title|type of person)\b/.test(normalizedUsage);

  return Boolean(normalizedDefinition && normalizedUsage) && looksProcessLike && looksRoleLike;
}

function isNamedEntityStyleMisfire(request, definitionText, usageText) {
  const contextSignals = getSelectionContextSignals(request.selection?.text, request.selection?.contextText || "");
  const combined = normalizeText(`${definitionText} ${usageText}`).toLowerCase();

  if (!contextSignals.compoundPhrase) {
    return false;
  }

  return /\b(person'?s name|named identity|proper name|named thing|name or label|used as the name|used as a name|functioning as the person'?s name)\b/.test(
    combined
  );
}

function isPlaceholderFieldValue(text) {
  const normalizedText = normalizeText(text).toLowerCase();

  return (
    normalizedText === "definition" ||
    normalizedText === "usage" ||
    normalizedText === "in context" ||
    normalizedText === "context" ||
    normalizedText === "meaning"
  );
}

function isPlaceholderUsageValue(text) {
  const normalizedText = normalizeText(text).toLowerCase();

  return (
    isPlaceholderFieldValue(normalizedText) ||
    /\b(?:describe|describes|describing|point|points|pointing)\s+(?:to|at)\s+definition\b/i.test(normalizedText) ||
    /\bused to\s+(?:describe|point to)\s+definition\b/i.test(normalizedText) ||
    /\bused to\s+(?:describe|point to)\s+usage\b/i.test(normalizedText)
  );
}

function joinExplanationSentences(parts) {
  return parts
    .map((part) => normalizeText(part))
    .filter(Boolean)
    .map((part) => /[.!?]$/.test(part) ? part : `${part}.`)
    .join(" ");
}

function hasConcreteExample(text) {
  return /\b(for example|for instance|such as|imagine|think of|example:)\b/i.test(normalizeText(text));
}

function isInsufficientDeepExplanation(request, definition, usage) {
  if (request.mode !== DEEP_MODE) {
    return false;
  }

  const normalizedDefinition = normalizeText(definition);
  const normalizedUsage = normalizeText(usage);
  const combined = normalizeText(`${normalizedDefinition} ${normalizedUsage}`);
  const sourceText = normalizeText(
    `${request.sourceExplanation?.definition || ""} ${request.sourceExplanation?.usage || ""}`
  );

  if (!combined) {
    return true;
  }

  if (combined.length < 240) {
    return true;
  }

  if (!hasConcreteExample(combined)) {
    return true;
  }

  if (sourceText && combined.length <= sourceText.length + 40) {
    return true;
  }

  if (sourceText && isMostlyParaphrase(sourceText, combined)) {
    return true;
  }

  return false;
}

function shouldRepairExplanation(request, explanation) {
  const definition = normalizeText(explanation?.definition);
  const usage = normalizeText(explanation?.usage);
  const contextType = detectContextType(request.selection);

  if (!definition || !usage) {
    return true;
  }

  if (isPlaceholderFieldValue(definition) || isPlaceholderUsageValue(usage)) {
    return true;
  }

  if (isProcessToRoleMismatch(request.selection?.text, definition, usage)) {
    return true;
  }

  if (isNamedEntityStyleMisfire(request, definition, usage)) {
    return true;
  }

  if (containsMetaLeak(definition) || containsMetaLeak(usage)) {
    return true;
  }

  if (usage.length < 18) {
    return true;
  }

  if (classifySelectionKind(request.selection.text) === "sentence-or-passage" && isMostlyParaphrase(request.selection.text, definition)) {
    return true;
  }

  if (countWords(request.selection.text) >= 3 && isMostlyParaphrase(request.selection.text, definition)) {
    return true;
  }

  if (isClearlyGenericUsage(usage)) {
    return true;
  }

  if (isInsufficientDeepExplanation(request, definition, usage)) {
    return true;
  }

  if (isLowValueShortPhraseExplanation(request, definition, usage, contextType)) {
    return true;
  }

  if (isDefinitionEchoUsage(request.selection?.text, definition, usage)) {
    return true;
  }

  return false;
}

function chooseBetterExplanation(request, primaryExplanation, repairedExplanation) {
  if (!repairedExplanation) {
    return primaryExplanation;
  }

  return scoreExplanation(request, repairedExplanation) >= scoreExplanation(request, primaryExplanation)
    ? repairedExplanation
    : primaryExplanation;
}

function scoreExplanation(request, explanation) {
  const definition = normalizeText(explanation?.definition);
  const usage = normalizeText(explanation?.usage);
  const contextType = detectContextType(request.selection);
  let score = 0;

  score += Math.min(definition.length, 180) / 10;
  score += Math.min(usage.length, 180) / 10;

  if (!isMostlyParaphrase(request.selection.text, definition)) {
    score += 14;
  }

  if (/\b(in this (?:sentence|passage|context)|used to|is there to|here,)\b/i.test(usage)) {
    score += 8;
  }

  if (containsMetaLeak(definition) || containsMetaLeak(usage)) {
    score -= 40;
  }

  if (isPlaceholderFieldValue(definition) || isPlaceholderUsageValue(usage)) {
    score -= 80;
  }

  if (isProcessToRoleMismatch(request.selection?.text, definition, usage)) {
    score -= 45;
  }

  if (isNamedEntityStyleMisfire(request, definition, usage)) {
    score -= 55;
  }

  if (isDefinitionEchoUsage(request.selection?.text, definition, usage)) {
    score -= 30;
  }

  if (request.mode === DEEP_MODE) {
    score += hasConcreteExample(definition) || hasConcreteExample(usage) ? 12 : -18;
    score += isInsufficientDeepExplanation(request, definition, usage) ? -28 : 16;
  }

  if (isLowValueShortPhraseExplanation(request, definition, usage, contextType)) {
    score -= 35;
  }

  return score;
}

function isUnusableExplanation(request, explanation) {
  const definition = normalizeText(explanation?.definition);
  const usage = normalizeText(explanation?.usage);
  const contextType = detectContextType(request.selection);

  return (
    !definition ||
    !usage ||
    isPlaceholderFieldValue(definition) ||
    isPlaceholderUsageValue(usage) ||
    isProcessToRoleMismatch(request.selection?.text, definition, usage) ||
    isNamedEntityStyleMisfire(request, definition, usage) ||
    looksTruncatedField(definition) ||
    looksTruncatedField(usage) ||
    containsMetaLeak(definition) ||
    containsMetaLeak(usage) ||
    isInsufficientDeepExplanation(request, definition, usage) ||
    isLowValueShortPhraseExplanation(request, definition, usage, contextType)
  );
}

function isMostlyParaphrase(sourceText, explanationText) {
  const sourceTokens = getMeaningfulTokens(sourceText);
  const explanationTokens = getMeaningfulTokens(explanationText);

  if (sourceTokens.length < 5 || explanationTokens.length < 5) {
    return false;
  }

  const sourceTokenSet = new Set(sourceTokens);
  const explanationTokenSet = new Set(explanationTokens);
  const overlappingTokenCount = explanationTokens.filter((token) => sourceTokenSet.has(token)).length;
  const distinctOverlapCount = [...explanationTokenSet].filter((token) => sourceTokenSet.has(token)).length;
  const overlapRatio = overlappingTokenCount / explanationTokens.length;
  const distinctSourceCoverage = distinctOverlapCount / new Set(sourceTokens).size;

  return overlapRatio >= 0.72 && distinctSourceCoverage >= 0.45;
}

function getMeaningfulTokens(text) {
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "but",
    "by",
    "for",
    "from",
    "how",
    "if",
    "in",
    "into",
    "is",
    "it",
    "its",
    "of",
    "on",
    "or",
    "that",
    "the",
    "their",
    "this",
    "to",
    "what",
    "when",
    "where",
    "which",
    "while",
    "with",
  ]);

  return normalizeText(text)
    .toLowerCase()
    .match(/[a-z0-9]+(?:'[a-z0-9]+)?/g)
    ?.filter((token) => token.length > 2 && !stopWords.has(token)) || [];
}

function detectContextType(selection) {
  const contextText = normalizeText(selection?.contextText).toLowerCase();
  const pageTitle = normalizeText(selection?.pageTitle).toLowerCase();
  const hostname = normalizeText(selection?.hostname).toLowerCase();
  const combined = `${contextText} ${pageTitle} ${hostname}`;
  const hasSocialProfileSignals =
    /\b(followers|following|joined|bio|profile|works as|occupation)\b/.test(combined);
  const hasSocialPostSignals =
    /\b(views|reply|replies|reposted|repost|quote|quoted|thread|post your reply|conversation)\b/.test(combined) ||
    /\bon x[:\s]/.test(pageTitle) ||
    /\b(status|tweet)\b/.test(pageTitle);

  if (hasSocialProfileSignals && !hasSocialPostSignals) {
    return "profile";
  }

  if (
    hasSocialPostSignals ||
    (/\b(x\.com|twitter\.com)\b/.test(hostname) && /\b(post|reply|repl(?:y|ies)|view|conversation)\b/.test(combined))
  ) {
    return "social-post";
  }

  if (/\b(article|chapter|section|reference|abstract)\b/.test(combined)) {
    return "article";
  }

  return "general";
}

function isLowValueShortPhraseExplanation(request, definition, usage, contextType) {
  const selectionText = normalizeText(request.selection?.text);
  const selectionKind = classifySelectionKind(selectionText);
  const normalizedDefinition = normalizeText(definition);
  const normalizedUsage = normalizeText(usage);
  const wordCount = countWords(selectionText);

  if (selectionKind === "sentence-or-passage" || wordCount < 2 || wordCount > 12) {
    return false;
  }

  if (!normalizedDefinition || !normalizedUsage) {
    return false;
  }

  if (isPlaceholderFieldValue(normalizedDefinition) || isPlaceholderUsageValue(normalizedUsage)) {
    return true;
  }

  if (isProcessToRoleMismatch(selectionText, normalizedDefinition, normalizedUsage)) {
    return true;
  }

  if (
    /\b(?:has|means) a specific meaning in this (?:passage|sentence|context)\b/i.test(normalizedDefinition) ||
    /\bcould not fully (?:resolve|explain)\b/i.test(normalizedDefinition)
  ) {
    return true;
  }

  if (/^this (?:phrase|term)\b/i.test(normalizedDefinition) && normalizedDefinition.length < 95) {
    return true;
  }

  if (isClearlyGenericUsage(normalizedUsage)) {
    return true;
  }

  if (wordCount >= 3 && isMostlyParaphrase(selectionText, normalizedDefinition)) {
    return true;
  }

  return false;
}

function decodeCommonEscapes(text) {
  return String(text || "")
    .replace(/\\n/g, " ")
    .replace(/\\"/g, "\"")
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
}

function cleanGeneratedField(text) {
  return normalizeText(text)
    .replace(/^[{[]+/, "")
    .replace(/[}\]]+$/, "")
    .replace(/^(?:here is|here's)\s+the\s+(?:json|response)\s+(?:requested|you asked for)\s*[:\-]?\s*/i, "")
    .replace(/^the\s+json\s+requested\s*[:\-]?\s*/i, "")
    .replace(/^(?:"|')?(?:definition|usage|in context)(?:"|')?\s*[:\-]\s*/i, "")
    .replace(/^(?:"|')(?=[a-z0-9])/i, "")
    .replace(/(?<=[a-z0-9.!?])(?:"|')$/i, "")
    .replace(/^"(.*)"$/i, "$1")
    .replace(/^'(.*)'$/i, "$1");
}

function looksTruncatedField(text) {
  const normalizedText = normalizeText(text);

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

  if (doubleQuoteCount % 2 === 1) {
    return true;
  }

  return false;
}

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsMetaLeak(text) {
  return /\b(json|schema|field names?|code fences?|prompt|instruction|requested output|browser extension|highlighted text)\b/i.test(
    normalizeText(text)
  );
}

function isClearlyGenericUsage(text) {
  const normalizedText = normalizeText(text);

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

function isDefinitionEchoUsage(selectionText, definitionText, usageText) {
  const normalizedSelection = normalizeText(selectionText).toLowerCase();
  const normalizedDefinition = normalizeText(definitionText).toLowerCase();
  const normalizedUsage = normalizeText(usageText).toLowerCase();
  const summarizedDefinition = summarizeDefinitionForUsage(definitionText, selectionText).toLowerCase();

  if (!normalizedDefinition || !normalizedUsage) {
    return false;
  }

  if (
    summarizedDefinition &&
    (normalizedUsage.includes(summarizedDefinition) || summarizedDefinition.includes(normalizedUsage))
  ) {
    return true;
  }

  return Boolean(normalizedSelection) && (
    normalizedUsage.includes(`the word "${normalizedSelection}"`) ||
    normalizedUsage.includes(`the term "${normalizedSelection}"`) ||
    normalizedUsage.includes(`the word '${normalizedSelection}'`) ||
    normalizedUsage.includes(`the term '${normalizedSelection}'`)
  );
}
