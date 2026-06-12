// Types for codegen.mjs so nuxt.config.ts (TypeScript) can import the
// generator without `allowJs`. The implementation stays a plain `.mjs` so
// `node scripts/demo-styles/codegen.mjs` runs it directly, matching the other
// build scripts in this directory.

/** Regenerate one demo folder's styles.css. Returns true if it changed. */
export function generateOne(folder: string): boolean

/** Regenerate every folder demo. Returns a summary for logging. */
export function generateAll(): { demos: number; written: number }
