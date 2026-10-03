import AppShell from "@/components/app-shell";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  KEY_ENV,
  PROVIDERS,
  type ProviderId,
} from "@/lib/ai/config";

// Read the env per request, not at build time — otherwise the header badge
// could advertise a different provider than /api/chat actually uses, and a key
// saved through the setup dialog would not be noticed until a rebuild.
export const dynamic = "force-dynamic";

export default function Home() {
  const provider = (process.env.AI_PROVIDER ?? DEFAULT_PROVIDER).trim();
  const model = (process.env.AI_MODEL ?? DEFAULT_MODEL).trim();
  const known = (PROVIDERS as readonly string[]).includes(provider);
  const configured = known && Boolean(process.env[KEY_ENV[provider as ProviderId]]);
  return (
    <AppShell
      providerLabel={`${provider}/${model}`}
      configured={configured}
      provider={known ? (provider as ProviderId) : DEFAULT_PROVIDER}
    />
  );
}
