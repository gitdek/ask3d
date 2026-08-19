import { createProviderRegistry, type LanguageModel } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, KEY_ENV, PROVIDERS, type ProviderId } from "./config";

// Explicit provider instances — never plain string models, which would
// silently route through Vercel AI Gateway and demand a gateway key.
const registry = createProviderRegistry({
  google: createGoogleGenerativeAI(),
  anthropic: createAnthropic(),
  openrouter: createOpenRouter(),
});

function isProviderId(value: string): value is ProviderId {
  return (PROVIDERS as readonly string[]).includes(value);
}

/** Resolve the configured model, with friendly errors for misconfiguration. */
export function getModel(): LanguageModel {
  const provider = process.env.AI_PROVIDER ?? DEFAULT_PROVIDER;
  const model = process.env.AI_MODEL ?? DEFAULT_MODEL;
  if (!isProviderId(provider)) {
    throw new Error(
      `Unknown AI_PROVIDER "${provider}". Valid values: ${PROVIDERS.join(", ")}. Set it in .env.local.`,
    );
  }
  if (!process.env[KEY_ENV[provider]]) {
    throw new Error(
      `Missing ${KEY_ENV[provider]} for provider "${provider}" — add it to .env.local. ` +
        `(Google keys are free at https://aistudio.google.com — no credit card.)`,
    );
  }
  return registry.languageModel(`${provider}:${model}` as Parameters<typeof registry.languageModel>[0]);
}
