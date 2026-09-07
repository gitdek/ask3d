export const DEFAULT_PROVIDER = "google";
export const DEFAULT_MODEL = "gemini-3.8-flash";

export const PROVIDERS = ["google", "openrouter", "anthropic"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const KEY_ENV: Record<ProviderId, string> = {
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};
