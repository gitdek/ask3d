export const DEFAULT_PROVIDER = "google";
export const DEFAULT_MODEL = "gemini-3.8-flash";

export const PROVIDERS = ["google", "openrouter", "anthropic"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const KEY_ENV: Record<ProviderId, string> = {
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

/** What to put in the model box when someone picks a provider in setup. */
export const SUGGESTED_MODEL: Record<ProviderId, string> = {
  google: DEFAULT_MODEL,
  openrouter: "z-ai/glm-5.2:free",
  anthropic: "claude-sonnet-5",
};

/** Where to get a key, and what it costs, shown in the setup dialog. */
export const PROVIDER_INFO: Record<ProviderId, { label: string; note: string; url: string }> = {
  google: {
    label: "Google Gemini",
    note: "Free, no credit card",
    url: "https://aistudio.google.com",
  },
  openrouter: {
    label: "OpenRouter",
    note: "Free models available",
    url: "https://openrouter.ai/keys",
  },
  anthropic: {
    label: "Anthropic",
    note: "Paid",
    url: "https://console.anthropic.com",
  },
};
