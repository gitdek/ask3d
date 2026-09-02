import { NextResponse, type NextRequest } from "next/server";

/**
 * Same-origin guard for every state-changing or key-spending request.
 *
 * ask3d is a single-user tool with no login: whoever can reach the server
 * can spend the API key, fill or wipe the library, or start statue
 * generations. Two things keep that "whoever" down to the person at the
 * keyboard: `next dev` binds loopback by default (package.json; `./start.sh
 * --lan` opts into the LAN), and this proxy refuses browser requests that
 * didn't originate from the app's own page. A malicious site can fire a
 * no-preflight POST at localhost:3000 from any tab, but browsers label such
 * requests (Sec-Fetch-Site, Origin) and they are rejected here. The Host
 * check closes DNS rebinding, where the attacker's page IS same-origin —
 * with the attacker's hostname. Non-browser clients (curl) carry none of
 * these headers and pass: that is the network boundary's job, not this one.
 */

const LOCAL_HOSTNAME =
  /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[\w-]+\.local)$/i;

function hostnameOf(host: string | null): string {
  if (!host) return "";
  const h = host.trim();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0];
}

function refuse(reason: string): NextResponse {
  return NextResponse.json({ error: `request refused: ${reason}` }, { status: 403 });
}

export function proxy(req: NextRequest) {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return NextResponse.next();

  const host = req.headers.get("host");
  const hostname = hostnameOf(host);
  const extraHosts = (process.env.ASK3D_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!LOCAL_HOSTNAME.test(hostname) && !extraHosts.includes(hostname)) {
    return refuse(`host "${hostname}" is not a local address (set ASK3D_ALLOWED_HOSTS to allow it)`);
  }

  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return refuse(`${site} request`);

  const origin = req.headers.get("origin");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return refuse("malformed Origin");
    }
    if (originHost !== host) return refuse(`origin ${originHost} does not match host ${host}`);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*", "/statue/:path*"],
};
