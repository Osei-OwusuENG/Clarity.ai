const AI_PROVIDER_GEMINI = "gemini";
const AI_PROVIDER_OPENAI_COMPATIBLE = "openai-compatible";
const VALID_AI_PROVIDERS = new Set([AI_PROVIDER_GEMINI, AI_PROVIDER_OPENAI_COMPATIBLE]);

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = "https://api.openai.com/v1";

function normalizeProvider(value) {
  const normalizedValue = String(value || "").trim().toLowerCase();
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

function getConfiguredProvider(env = process.env) {
  const explicitProvider = normalizeProvider(env.AI_PROVIDER);

  if (explicitProvider) {
    return explicitProvider;
  }

  if (String(env.OPENAI_API_KEY || "").trim() || normalizeBaseUrl(env.AI_BASE_URL || env.OPENAI_BASE_URL)) {
    return AI_PROVIDER_OPENAI_COMPATIBLE;
  }

  return AI_PROVIDER_GEMINI;
}

function getConfiguredApiKey(env = process.env, provider = getConfiguredProvider(env)) {
  if (provider === AI_PROVIDER_OPENAI_COMPATIBLE) {
    return String(env.AI_API_KEY || env.OPENAI_API_KEY || "").trim();
  }

  return String(env.AI_API_KEY || env.GEMINI_API_KEY || "").trim();
}

function getConfiguredModel(env = process.env, provider = getConfiguredProvider(env)) {
  if (provider === AI_PROVIDER_OPENAI_COMPATIBLE) {
    return normalizeModel(env.AI_MODEL || env.OPENAI_MODEL || "");
  }

  return normalizeModel(env.AI_MODEL || env.GEMINI_MODEL || "") || DEFAULT_GEMINI_MODEL;
}

function getConfiguredBaseUrl(env = process.env, provider = getConfiguredProvider(env)) {
  if (provider !== AI_PROVIDER_OPENAI_COMPATIBLE) {
    return "";
  }

  return normalizeBaseUrl(env.AI_BASE_URL || env.OPENAI_BASE_URL || "") || DEFAULT_OPENAI_COMPATIBLE_BASE_URL;
}

function getProviderDisplayName(provider) {
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
      message: "The backend has an invalid AI_PROVIDER value. Use gemini or openai-compatible.",
    };
  }

  const provider = getConfiguredProvider(env);
  const apiKey = getConfiguredApiKey(env, provider);

  if (!apiKey) {
    return provider === AI_PROVIDER_OPENAI_COMPATIBLE
      ? {
          reason: "missing_openai_compatible_api_key",
          message:
            "The backend is missing AI_API_KEY or OPENAI_API_KEY. Add one to .env and restart the server.",
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
        "The backend is missing AI_MODEL or OPENAI_MODEL. Add an OpenAI-compatible model name and restart the server.",
    };
  }

  return null;
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
  DEFAULT_GEMINI_MODEL,
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  getConfiguredApiKey,
  getConfiguredBaseUrl,
  getConfiguredModel,
  getConfiguredProvider,
  getProviderConfigurationError,
  getProviderDisplayName,
  getProviderHealth,
  normalizeBaseUrl,
  normalizeModel,
  normalizeProvider,
};
