/**
 * Portable dev-mode flag. `true` under a non-production build, `false`
 * in production. The expression shape below is load-bearing; read both
 * notes before changing it.
 *
 * Why the ternary (consumer dead-code elimination): consumer bundlers
 * replace `process.env.NODE_ENV` (dot-access) with a string literal.
 * Vite and esbuild do this via `define`, Webpack via `DefinePlugin`,
 * Rollup via `@rollup/plugin-replace`. After replacement this reads
 * `('production') !== 'production'`, which folds to the literal `false`,
 * so every `if (__DEV__)` block is dropped from the consumer's
 * production bundle. The `&&`-guarded form
 * (`typeof process !== 'undefined' && process.env.NODE_ENV !== 'production'`)
 * does NOT fold: esbuild will not inline a `const` whose initializer is
 * a short-circuit expression, so the dev branches survive. Keep the
 * `typeof` test inside the ternary condition; do not rewrite it as a
 * leading `&&` guard.
 *
 * Why the `typeof` guard (CDN safety): imported directly through a
 * browser-native ESM CDN (esm.sh, Skypack, unpkg) with no bundler in
 * front, `process` is undeclared. A bare `process.env.NODE_ENV` read
 * would throw a `ReferenceError` at module-eval. The `typeof` test
 * selects the `'production'` branch first, so `__DEV__` resolves to
 * `false` and the library still loads; only the dev diagnostic surface
 * degrades (warnings stay silent). To restore CDN debuggability, put a
 * bundler in the pipeline so `process.env.NODE_ENV` gets replaced,
 * which is the recommended path for any production app regardless.
 *
 * `import.meta.env.DEV` would resolve under Vite but break Node
 * consumers (no `import.meta.env`) and emit esbuild's
 * `empty-import-meta` warning in pre-bundled distributions. The
 * `process.env.NODE_ENV` choice is the broadest-compatibility option.
 *
 * The dot-access read needs the explicit `NODE_ENV` member declared in
 * `types/node-env.d.ts`; tsconfig's `noPropertyAccessFromIndexSignature`
 * rejects index-signature dot-access otherwise.
 */
export const __DEV__: boolean =
  (typeof process !== 'undefined' ? process.env.NODE_ENV : 'production') !== 'production'
