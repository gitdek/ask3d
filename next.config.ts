import os from "os";
import type { NextConfig } from "next";

// The statue sidecar (FastAPI, bound to loopback) is reached through the
// app's own origin: /statue/* → http://127.0.0.1:8765/*. One origin means
// the same-origin guard in proxy.ts covers it, no CORS dance, and a phone
// on the LAN can make statues too (it can't reach the host's loopback).
const STATUE_SERVICE_URL = (process.env.STATUE_SERVICE_URL ?? "http://127.0.0.1:8765").replace(
  /\/$/,
  "",
);

/**
 * Hosts the dev server may serve its own /_next/* resources to.
 *
 * Next blocks those for any host but localhost and the -H hostname, and a
 * blocked HMR websocket leaves the page rendered but never hydrated: every
 * button dead. Reaching ask3d from a phone (./start.sh --lan) means the
 * browser's host is this machine's LAN address, so allow this machine's
 * own addresses — read live, because DHCP hands out a new one now and then.
 * No other site can claim these hostnames, and /api/* and /statue/* stay
 * behind the guard in proxy.ts regardless.
 */
function ownHosts(): string[] {
  // Loopback: Next allows "localhost" by default but not the literal
  // addresses, and opening 127.0.0.1 is an ordinary thing to do — it is
  // what `curl` prints, what a bookmark may hold, and what a second app
  // on the machine will link to. Without these the page loads and every
  // button is dead, which looks like a broken app rather than a blocked
  // origin.
  const hosts = new Set<string>(["127.0.0.1", "[::1]", "::1"]);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (!address.internal && String(address.family).includes("4")) hosts.add(address.address);
    }
  }
  const hostname = os.hostname();
  if (hostname) {
    hosts.add(hostname);
    hosts.add(`${hostname.replace(/\.local$/i, "")}.local`);
  }
  for (const extra of (process.env.ASK3D_ALLOWED_HOSTS ?? "").split(",")) {
    const host = extra.trim();
    if (host) hosts.add(host);
  }
  return [...hosts];
}

const nextConfig: NextConfig = {
  allowedDevOrigins: ownHosts(),
  async rewrites() {
    return [{ source: "/statue/:path*", destination: `${STATUE_SERVICE_URL}/:path*` }];
  },
};

export default nextConfig;
