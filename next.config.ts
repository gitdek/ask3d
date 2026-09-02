import type { NextConfig } from "next";

// The statue sidecar (FastAPI, bound to loopback) is reached through the
// app's own origin: /statue/* → http://127.0.0.1:8765/*. One origin means
// the same-origin guard in proxy.ts covers it, no CORS dance, and a phone
// on the LAN can make statues too (it can't reach the host's loopback).
const STATUE_SERVICE_URL = (process.env.STATUE_SERVICE_URL ?? "http://127.0.0.1:8765").replace(
  /\/$/,
  "",
);

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: "/statue/:path*", destination: `${STATUE_SERVICE_URL}/:path*` }];
  },
};

export default nextConfig;
