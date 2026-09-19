import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  async rewrites() {
    return {
      // Kernel passthrough: the OS client (src/lib/os/client.ts) calls the
      // trading-core REST API and socket.io with ?XTransformPort=3030. When
      // the app is served through the Caddy gateway (:81) that query param
      // triggers a reverse proxy - but hitting the Next server directly
      // (:3000) 404'd every kernel call, leaving the market watch, chart,
      // ticket and feeds empty ("0 instruments / reconnecting…"). Rewriting
      // the guarded paths here makes the app self-sufficient on any port.
      // Scope: only requests carrying XTransformPort, so /api/* and page
      // routes are untouched. Kernel port is pinned to 3030 in client.ts.
      // Note on socket.io: Next's runtime normalization 308s '/socket.io/'
      // down to '/socket.io' before rewrites run; the kernel's engine.io is
      // configured with addTrailingSlash:false so it claims both spellings.
      // WebSocket upgrades cannot follow the 308, so the :3000 feed falls
      // back to long-polling (socket.io does this transparently); full
      // websocket still flows through the Caddy :81 gateway.
      beforeFiles: [
        {
          source: "/:path*",
          has: [{ type: "query", key: "XTransformPort" }],
          destination: "http://127.0.0.1:3030/:path*",
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
