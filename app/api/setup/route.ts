import { promises as fs } from "fs";
import path from "path";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, KEY_ENV, PROVIDERS, type ProviderId } from "@/lib/ai/config";

/**
 * First-run configuration, so nobody has to hand-edit a dotfile to say hello.
 *
 * Writing a key does two things: it persists to .env.local so the choice
 * survives a restart, and it sets the value on the running process so the very
 * next message works without one. `getModel()` reads `process.env` per call, so
 * the live mutation is enough.
 *
 * This writes a secret to disk, which is only reasonable because the whole app
 * already assumes a trusted local network: there is no login, and anyone who
 * can reach the server can already spend the key. proxy.ts keeps the route
 * same-origin and local-host only.
 */

export const runtime = "nodejs";

const ENV_FILE = path.join(process.cwd(), ".env.local");
const MAX_KEY = 400;

function isProvider(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

/** Replace a KEY=... line in place, or append one if it was never there. */
function upsert(source: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(source)) return source.replace(re, line);
  return `${source.replace(/\s*$/, "")}\n${line}\n`;
}

export async function GET(): Promise<Response> {
  const provider = (process.env.AI_PROVIDER ?? DEFAULT_PROVIDER).trim();
  const model = (process.env.AI_MODEL ?? DEFAULT_MODEL).trim();
  const known = isProvider(provider);
  return Response.json({
    provider,
    model,
    // Never return the key itself — only whether one is present.
    configured: known && Boolean(process.env[KEY_ENV[provider]]),
    providers: PROVIDERS,
  });
}

export async function POST(req: Request): Promise<Response> {
  const body: unknown = await req.json().catch(() => null);
  const { provider, apiKey, model } = (body ?? {}) as {
    provider?: unknown;
    apiKey?: unknown;
    model?: unknown;
  };

  if (!isProvider(provider)) {
    return Response.json(
      { error: `Pick one of: ${PROVIDERS.join(", ")}.` },
      { status: 400 },
    );
  }
  if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > MAX_KEY || /\s/.test(apiKey.trim())) {
    return Response.json({ error: "That does not look like an API key." }, { status: 400 });
  }
  const chosenModel =
    typeof model === "string" && model.trim() && /^[\w.\-/:]{1,100}$/.test(model.trim())
      ? model.trim()
      : undefined;

  const key = apiKey.trim();
  const envVar = KEY_ENV[provider];

  try {
    let source = "";
    try {
      source = await fs.readFile(ENV_FILE, "utf8");
    } catch {
      // first run — start from nothing rather than failing
    }
    source = upsert(source, "AI_PROVIDER", provider);
    if (chosenModel) source = upsert(source, "AI_MODEL", chosenModel);
    source = upsert(source, envVar, key);
    await fs.writeFile(ENV_FILE, source, { mode: 0o600 });
  } catch (error) {
    return Response.json(
      {
        error: `Could not write .env.local (${error instanceof Error ? error.message : "unknown"}). Add ${envVar} by hand instead.`,
      },
      { status: 500 },
    );
  }

  // Make it live for the current process so the next message just works.
  process.env.AI_PROVIDER = provider;
  if (chosenModel) process.env.AI_MODEL = chosenModel;
  process.env[envVar] = key;

  return Response.json({
    ok: true,
    provider,
    model: chosenModel ?? process.env.AI_MODEL ?? DEFAULT_MODEL,
  });
}
