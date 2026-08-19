import AppShell from "@/components/app-shell";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "@/lib/ai/config";

export default function Home() {
  const provider = process.env.AI_PROVIDER ?? DEFAULT_PROVIDER;
  const model = process.env.AI_MODEL ?? DEFAULT_MODEL;
  return <AppShell providerLabel={`${provider}/${model}`} />;
}
