// Tailwind v4's PostCSS plugin does its OWN base-directory detection,
// independent of Next.js/Turbopack's `turbopack.root`. It walks up from the
// CSS file looking for a lockfile/package.json to decide where "the
// project" is - on the original WSL dev machine it found a stray
// package.json/package-lock.json up at C:\Users\USER (one level above this
// project's Desktop folder) and tried to resolve `tailwindcss` FROM there
// instead of from node_modules right here. Passing `base` explicitly skips
// that auto-detection entirely.
//
// IMPORTANT: `base` must be computed from THIS FILE'S OWN location, not
// hardcoded to an absolute path. A hardcoded WSL path
// (/mnt/c/Users/USER/desktop/iqos) doesn't exist inside a Docker container
// (or on any other machine) - Tailwind then can't find the project, and
// silently emits NO CSS while the rest of `next build` still succeeds (no
// error, just an unstyled page - exactly what shipped once before this was
// fixed). Deriving it from import.meta.url works everywhere: WSL, Docker,
// any OS, regardless of cwd.
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const projectRoot = dirname(fileURLToPath(import.meta.url));

// Shape matters to Next's own postcss config loader (webpack path): it
// wants EXACTLY plugin names (strings) or [name, options] tuples in an
// array - not an already-invoked plugin instance (Turbopack tolerated that;
// webpack's shape-check called it "an unknown PostCSS plugin") and not an
// object map either (webpack's loader called THAT "Malformed PostCSS
// Configuration"). The tuple-array form below is what's left.
const config = {
  plugins: [["@tailwindcss/postcss", { base: projectRoot }]],
};

export default config;
