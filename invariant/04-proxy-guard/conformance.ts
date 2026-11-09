import { writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { NextRequest } from "next/server.js";

// The application bundler resolves next/server without an extension. Native
// Node needs the .js suffix; resolve that same package module without editing
// or replacing the application's import or implementation.
const nextResolution = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === "next/server" ? "next/server.js" : specifier, context);
  },
});
const { proxy } = await import("../../proxy.ts");
nextResolution.deregister();

const methods = ["GET", "POST"] as const;
const hosts = [
  "localhost:3000",
  "192.168.1.2:3000",
  "workstation.local:3000",
  "app.example:3000",
  "evil.example:3000",
  "",
] as const;
const sites = ["", "same-origin", "none", "cross-site"] as const;
const origins = ["", "own", "other", "not a URL"] as const;
const paths = ["/api/conformance", "/statue/conformance"] as const;
const otherOrigin = "http://other.example:3000";

type Input = {
  method: (typeof methods)[number];
  host: (typeof hosts)[number];
  site: (typeof sites)[number];
  origin: (typeof origins)[number];
};
type Exchange = { request: NextRequest; response: ReturnType<typeof proxy> };
type State = {
  request: "no request" | Input;
  response: "ready" | "next" | "403";
};

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`Missing ${name}`);
  return value;
}

function count(name: string, minimum: number): number {
  const raw = required(name);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

// FNV-1a seeds Mulberry32 using the complete seed, including nonnumeric seeds.
function generator(seed: string): () => number {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    state = Math.imul(state ^ seed.charCodeAt(i), 16777619) >>> 0;
  }
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function within<T extends string>(value: string, values: readonly T[]): T {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`Observed value outside bounds: ${value}`);
  return found;
}

function makeRequest(input: Input, path: string): NextRequest {
  const url = `http://${input.host || "localhost:3000"}${path}`;
  const headers = new Headers();
  // Omitting Host is intentional: the request URL is not a Host header.
  if (input.host !== "") headers.set("host", input.host);
  if (input.site !== "") headers.set("sec-fetch-site", input.site);
  if (input.origin !== "") {
    headers.set(
      "origin",
      input.origin === "own"
        ? new URL(url).origin
        : input.origin === "other"
          ? otherOrigin
          : input.origin,
    );
  }
  return new NextRequest(url, { method: input.method, headers });
}

// Project the actual request and response, never the generated input or an
// independently calculated guard decision. All model values here are strings
// and a record, so no set/sequence/model-value wrappers are needed.
function abstract(exchange: Exchange | null): State {
  if (exchange === null) return { request: "no request", response: "ready" };

  const req = exchange.request;
  const rawOrigin = req.headers.get("origin") ?? "";
  let origin: Input["origin"];
  if (rawOrigin === "" || rawOrigin === "not a URL") origin = rawOrigin;
  else if (rawOrigin === otherOrigin) origin = "other";
  else if (rawOrigin === new URL(req.url).origin) origin = "own";
  else throw new Error(`Observed Origin outside bounds: ${rawOrigin}`);

  const res = exchange.response;
  const next = res.headers.get("x-middleware-next");
  let response: State["response"];
  if (res.status === 200 && next === "1") response = "next";
  else if (res.status === 403 && next === null) response = "403";
  else throw new Error(`Unexpected proxy response: status=${res.status}, next=${next}`);

  return {
    request: {
      method: within(req.method, methods),
      host: within(req.headers.get("host") ?? "", hosts),
      site: within(req.headers.get("sec-fetch-site") ?? "", sites),
      origin,
    },
    response,
  };
}

async function main(): Promise<void> {
  const runs = count("INVARIANT_RUNS", 1);
  const steps = count("INVARIANT_STEPS", 0);
  const random = generator(required("INVARIANT_SEED"));
  const output = required("INVARIANT_TRACES");
  const combinations: Input[] = [];
  for (const method of methods) {
    for (const host of hosts) {
      for (const site of sites) {
        for (const origin of origins) combinations.push({ method, host, site, origin });
      }
    }
  }

  // Draw without replacement across runs, then reshuffle. Every block of 192
  // decisions exercises the whole bounded product, regardless of responses.
  let deck: Input[] = [];
  function draw(): Input {
    if (deck.length === 0) {
      deck = combinations.slice();
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
    }
    return deck.pop()!;
  }

  const previousAllowedHosts = process.env.ASK3D_ALLOWED_HOSTS;
  process.env.ASK3D_ALLOWED_HOSTS = "app.example";
  try {
    const traces: State[][] = [];
    for (let run = 0; run < runs; run++) {
      let exchange: Exchange | null = null;
      const trace: State[] = [abstract(exchange)];
      for (let step = 0; step < steps; step++) {
        if (exchange === null) {
          const req = makeRequest(draw(), paths[Math.floor(random() * paths.length)]);
          exchange = { request: req, response: proxy(req) };
        } else {
          // Reset is completion of the observed call: consume its response and
          // release the exchange. The proxy itself has no persistent state.
          // Do this for both passes and refusals; no request is filtered out.
          await exchange.response.arrayBuffer();
          exchange = null;
        }
        trace.push(abstract(exchange));
      }
      traces.push(trace);
      if (exchange !== null) await exchange.response.arrayBuffer();
    }
    await writeFile(output, JSON.stringify({ traces }), "utf8");
  } finally {
    if (previousAllowedHosts === undefined) delete process.env.ASK3D_ALLOWED_HOSTS;
    else process.env.ASK3D_ALLOWED_HOSTS = previousAllowedHosts;
  }
}

await main();
