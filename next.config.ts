import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // lightningcss (which @tailwindcss/postcss uses under the hood) picks its
  // native binary at runtime with a dynamic `require(`lightningcss-${platform}
  // -${arch}-${libc}`)`. Turbopack tries to statically analyze that dynamic
  // require so it can bundle it, can't fully resolve the template literal,
  // and substitutes the literal string 'unknown' as the module id - hence
  // "Cannot find module 'unknown'" even though the real binary package
  // (verified present: node_modules/lightningcss-linux-x64-gnu, ~9MB .node
  // file) is installed correctly. serverExternalPackages is Next's escape
  // hatch for exactly this: these packages are left as plain Node `require`
  // calls at runtime instead of being traced/bundled by Turbopack.
  serverExternalPackages: ["lightningcss", "@tailwindcss/node", "@tailwindcss/postcss"],
  turbopack: {
    // Without this, Turbopack auto-detects the workspace root by walking UP
    // looking for lockfiles and lands on C:\Users\USER (there's a stray
    // package-lock.json there) instead of this project folder. That makes it
    // file-watch the ENTIRE user profile through WSL's slow /mnt/c/ DrvFs
    // mount on every change - which is exactly what "Compiling..." hanging
    // for a long time on any edit looks like, and (worse) it then resolves
    // package imports like 'tailwindcss' from that wrong root, where they
    // don't exist.
    //
    // NOTE: __dirname here is NOT this file's real folder - next.config.ts
    // gets loaded through a transpile step that rehomes it a directory up,
    // which is exactly the bug the first attempt at this fix hit (root
    // landed on .../desktop instead of .../desktop/iqos, breaking every
    // import). process.cwd() is reliable instead: `next dev` / `bun run dev`
    // is always launched FROM the project directory (see package.json's
    // "dev" script), so cwd at config-load time IS the project root.
    root: process.cwd(),
  },
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
          destination: `${process.env.KERNEL_URL || "http://127.0.0.1:3030"}/:path*`,
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
