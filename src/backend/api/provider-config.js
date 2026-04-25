const AI_PROVIDER_GEMINI = "gemini";
const AI_PROVIDER_OPENAI_COMPATIBLE = "openai-compatible";
const AI_PROVIDER_XAI = "xai";
const VALID_AI_PROVIDERS = new Set([AI_PROVIDER_GEMINI, AI_PROVIDER_OPENAI_COMPATIBLE, AI_PROVIDER_XAI]);

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";

function normalizeProvider(value) {
  const normalizedValue = String(value || "").trim().toLowerCase();

  if (normalizedValue === "grok") {
    return AI_PROVIDER_XAI;
  }

  return VALID_AI_PROVIDERS.has(normalizedValue) ? normalizedValue : "";
}

function normalizeBaseUrl(value) {
  const normalizedValue = String(value || "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(normalizedValue) ? normalizedValue : "";
}

function normalizeModel(value) {
  const normalizedValue = String(value || "").trim();
  return /^[^\s]{1,120}$/i.test(normalizedValue) ? normalizedValue : "";
}

function isGrokModel(value) {
  return /^grok(?:[-.]|$)/i.test(String(value || "").trim());
}

function isXaiBaseUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase() === "api.x.ai";
  } catch (error) {
    return false;
  }
}

function getConfiguredProvider(env = process.env) {
  const explicitProvider = normalizeProvider(env.AI_PROVIDER);

  if (explicitProvider) {
    return explicitProvider;
  }

  if (
    String(env.XAI_API_KEY || "").trim() ||
    normalizeBaseUrl(env.XAI_BASE_URL) ||
    isXaiBaseUrl(normalizeBaseUrl(env.AI_BASE_URL)) ||
    isGrokModel(env.AI_MODEL || env.XAI_MODEL)
  ) {
    return AI_PROVIDER_XAI;
  }

  if (
    String(env.OPENAI_API_KEY || "").trim() ||
    normalizeBaseUrl(env.AI_BASE_URL || env.OPENAI_BASE_URL || env.XAI_BASE_URL)
  ) {
    return AI_PROVIDER_OPENAI_COMPATIBLE;
  }

  return AI_PROVIDER_GEMINI;
}

function getConfiguredApiKey(env = process.env, provider = getConfiguredProvider(env)) {
  if (isOpenAICompatibleProvider(provider)) {
    return provider === AI_PROVIDER_XAI
      ? String(env.AI_API_KEY || env.XAI_API_KEY || env.OPENAI_API_KEY || "").trim()
      : String(env.AI_API_KEY || env.OPENAI_API_KEY || env.XAI_API_KEY || "").trim();
  }

  return String(env.AI_API_KEY || env.GEMINI_API_KEY || "").trim();
}

function getConfiguredModel(env = process.env, provider = getConfiguredProvider(env)) {
  if (isOpenAICompatibleProvider(provider)) {
    return provider === AI_PROVIDER_XAI
      ? normalizeModel(env.AI_MODEL || env.XAI_MODEL || env.OPENAI_MODEL || "")
      : normalizeModel(env.AI_MODEL || env.OPENAI_MODEL || env.XAI_MODEL || "");
  }

  return normalizeModel(env.AI_MODEL || env.GEMINI_MODEL || "") || DEFAULT_GEMINI_MODEL;
}

function getConfiguredBaseUrl(env = process.env, provider = getConfiguredProvider(env)) {
  if (!isOpenAICompatibleProvider(provider)) {
    return "";
  }

  if (provider === AI_PROVIDER_XAI) {
    return (
      normalizeBaseUrl(env.AI_BASE_URL || env.XAI_BASE_URL || env.OPENAI_BASE_URL || "") ||
      DEFAULT_XAI_BASE_URL
    );
  }

  return (
    normalizeBaseUrl(env.AI_BASE_URL || env.OPENAI_BASE_URL || env.XAI_BASE_URL || "") ||
    DEFAULT_OPENAI_COMPATIBLE_BASE_URL
  );
}

function getProviderDisplayName(provider) {
  if (provider === AI_PROVIDER_XAI) {
    return "xAI / Grok";
  }

  if (provider === AI_PROVIDER_OPENAI_COMPATIBLE) {
    return "OpenAI-compatible";
  }

  return "Gemini";
}

function getProviderConfigurationError(env = process.env) {
  const providerSetting = String(env.AI_PROVIDER || "").trim();

  if (providerSetting && !normalizeProvider(providerSetting)) {
    return {
      reason: "invalid_ai_provider",
      message: "The backend has an invalid AI_PROVIDER value. Use gemini, xai, or openai-compatible.",
    };
  }

  const provider = getConfiguredProvider(env);
  const apiKey = getConfiguredApiKey(env, provider);

  if (!apiKey) {
    return isOpenAICompatibleProvider(provider)
      ? {
          reason: "missing_openai_compatible_api_key",
          message:
            "The backend is missing AI_API_KEY, OPENAI_API_KEY, or XAI_API_KEY. Add one to .env and restart the server.",
        }
      : {
          reason: "missing_gemini_api_key",
          message: "The backend is missing AI_API_KEY or GEMINI_API_KEY. Add one to .env and restart the server.",
        };
  }

  const model = getConfiguredModel(env, provider);

  if (!model) {
    return {
      reason: "missing_ai_model",
      message:
        "The backend is missing AI_MODEL, OPENAI_MODEL, or XAI_MODEL. Add a provider model name and restart the server.",
    };
  }

  return null;
}

function isOpenAICompatibleProvider(provider) {
  return provider === AI_PROVIDER_OPENAI_COMPATIBLE || provider === AI_PROVIDER_XAI;
}

function getProviderHealth(env = process.env) {
  const provider = getConfiguredProvider(env);
  const configError = getProviderConfigurationError(env);

  return {
    provider,
    providerLabel: getProviderDisplayName(provider),
    ready: !configError,
    hasApiKey: Boolean(getConfiguredApiKey(env, provider)),
    model: getConfiguredModel(env, provider),
    baseUrl: getConfiguredBaseUrl(env, provider),
    configurationMessage: configError?.message || "",
  };
}

module.exports = {
  AI_PROVIDER_GEMINI,
  AI_PROVIDER_OPENAI_COMPATIBLE,
  AI_PROVIDER_XAI,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  DEFAULT_XAI_BASE_URL,
  getConfiguredApiKey,
  getConfiguredBaseUrl,
  getConfiguredModel,
  getConfiguredProvider,
  getProviderConfigurationError,
  getProviderDisplayName,
  getProviderHealth,
  isOpenAICompatibleProvider,
  normalizeBaseUrl,
  normalizeModel,
  normalizeProvider,
};
