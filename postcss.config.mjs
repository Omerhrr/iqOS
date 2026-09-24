// Tailwind v4's PostCSS plugin does its OWN base-directory detection,
// independent of Next.js/Turbopack's `turbopack.root` (that only steers
// Turbopack's bundler - it never reaches into Tailwind's own resolver). It
// walks up from the CSS file looking for a lockfile/package.json to decide
// where "the project" is, finds a stray package.json/package-lock.json up at
// C:\Users\USER (one level above this project's Desktop folder), and then
// tries to resolve `tailwindcss` FROM there instead of from node_modules
// right here - hence "Can't resolve 'tailwindcss' in '/mnt/c/Users/USER/desktop'".
// Passing `base` explicitly skips that auto-detection entirely.
//
// IMPORTANT: this must be the OBJECT-MAP form ({ "plugin-name": options }),
// not an already-invoked plugin instance ([tailwindcss({...})]). Turbopack
// tolerated the instance form, but Next's WEBPACK postcss loader validates
// the plugins shape itself and rejects an instance with "An unknown PostCSS
// plugin was provided ([object Object])" / "Malformed PostCSS Configuration"
// - it wants plugin names (strings) or this object-map, then resolves and
// calls the plugin itself.
const config = {
  plugins: {
    "@tailwindcss/postcss": { base: "/mnt/c/Users/USER/desktop/iqos" },
  },
};

export default config;
