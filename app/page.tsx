import AppShell from "@/components/app-shell";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "@/lib/ai/config";

// Read the env per request, not at build time — otherwise the header badge
// could advertise a different provider than /api/chat actually uses.
export const dynamic = "force-dynamic";

export default function Home() {
  const provider = process.env.AI_PROVIDER ?? DEFAULT_PROVIDER;
  const model = process.env.AI_MODEL ?? DEFAULT_MODEL;
  return <AppShell providerLabel={`${provider}/${model}`} />;
}
