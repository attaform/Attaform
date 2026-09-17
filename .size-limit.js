/**
 * Size-limit configuration, kept out of package.json so each entry can
 * override esbuild's bundle format.
 *
 * Conventions shared by every entry below:
 *
 *  - `format: 'esm'` (via asEsm / asEsmNode). Measuring in ESM avoids the
 *    `empty-import-meta` warning esbuild's default IIFE format raises for
 *    a module reading `import.meta.url` (the Nuxt module) or
 *    `import.meta.server` (the Nuxt plugin). The gzipped figure is the
 *    same either way; the format only changes the wrapper.
 *  - `ignore: ['zod']`. Zod is a peer dependency, so a consumer's own copy
 *    is what ships. Every Attaform entry that reaches an adapter treats it
 *    as external, which is what makes these numbers Attaform's own weight.
 *  - Vue is external everywhere, as the preset configures it.
 *
 * A `limit` is a ceiling, not a record of a measurement: `pnpm check:size`
 * prints the current size beside each one. Where a cap sits snug it is a
 * tripwire and is meant to bind. Why any given cap moved is in git.
 */

/** @param {import('esbuild').BuildOptions} config */
const asEsm = (config) => ({ ...config, format: 'esm' })

/**
 * Node-side tooling entries (the Nuxt module, the Vite plugin, the
 * compiler transforms) additionally declare `platform: 'node'`, so `node:*`
 * builtins resolve as externals instead of failing the build with
 * `Could not resolve "node:path"`.
 *
 * @param {import('esbuild').BuildOptions} config
 */
const asEsmNode = (config) => ({ ...config, format: 'esm', platform: 'node' })

export default [
  {
    // The barrel: the dispatching `useForm`, both Zod adapters, and the
    // whole optional surface (wizard, injectForm, useRegister, v-register).
    // This is the widest cap Attaform has, so it is the one feature
    // branches bump; the tripwires at the bottom of this file are what
    // prove a consumer importing less than all of it pays less.
    path: 'dist/index.mjs',
    limit: '51.5 KB',
    gzip: true,
    ignore: ['zod'],
    modifyEsbuildConfig: asEsm,
  },
  {
    // `attaform/zod`, the explicit spelling of the barrel. Identical bytes
    // to dist/index.mjs by construction, so the two caps track together
    // and a divergence between them is itself the signal.
    path: 'dist/zod.mjs',
    limit: '51.5 KB',
    gzip: true,
    ignore: ['zod'],
    modifyEsbuildConfig: asEsm,
  },
  {
    // The explicit Zod 4 subpath: one adapter, no runtime dispatch. The
    // Vite plugin rewrites `attaform/zod` to this path when it detects
    // zod@^4, so most Vite consumers ship this entry whichever spelling
    // they wrote.
    path: 'dist/zod-v4.mjs',
    limit: '47.5 KB',
    gzip: true,
    ignore: ['zod'],
    modifyEsbuildConfig: asEsm,
  },
  {
    // The explicit Zod 3 subpath, the v4 entry's peer. It runs heavier
    // than v4 because v3 has no static accessor for async refinements, so
    // the adapter carries its own issue-path rewrite and async-strip pass.
    path: 'dist/zod-v3.mjs',
    limit: '49 KB',
    gzip: true,
    ignore: ['zod'],
    modifyEsbuildConfig: asEsm,
  },
  {
    // `attaform/abstract`, the schema-agnostic escape hatch:
    // useAbstractForm plus the shared core, with no Zod adapter. Lighter
    // than the Zod entries by exactly what an adapter costs (no v3/v4
    // dispatch, no fingerprint walker, no slim-primitive machinery), so
    // it prices the shared core on its own.
    path: 'dist/abstract.mjs',
    limit: '40.25 KB',
    gzip: true,
    modifyEsbuildConfig: asEsm,
  },
  {
    // The v-register delivery entry: the directive and its satellites
    // (aria, file, listeners, lifecycle, value-sync), register-protocol,
    // assigner-pipeline, vue-shared-shim, dom-binding and installVRegister.
    // This is weight only an app that renders v-register pays, delivered
    // by the Vite/Nuxt rewrite's injected import or by installVRegister.
    // A jump here with no directive-side feature behind it means core
    // modules started leaking into the cluster's graph.
    path: 'dist/directive.mjs',
    limit: '7.5 KB',
    gzip: true,
    modifyEsbuildConfig: asEsm,
  },
  {
    // The undo/redo entry: historyPlugin, the snapshot ring buffer, and
    // the pure core helpers it leans on (structuralSnapshot, numeric-option
    // normalization). Only a form that opts into history pays it; the core
    // links none of it. A jump here with no history-side feature behind it
    // means the plugin's graph started dragging store weight along.
    path: 'dist/history.mjs',
    limit: '1.5 KB',
    gzip: true,
    modifyEsbuildConfig: asEsm,
  },
  {
    // The Nuxt module: auto-import manifest, runtime-config slot, and the
    // lazily imported DevTools custom tab. Build-time weight, not shipped
    // to the browser, which is why this cap is loose next to the runtime
    // entries above.
    path: 'dist/nuxt.mjs',
    limit: '14 KB',
    gzip: true,
    ignore: ['@nuxt/kit', 'nuxt/app'],
    modifyEsbuildConfig: asEsmNode,
  },
  {
    // The Vite plugin: the `resolveId` hook and Zod-major detection that
    // rewrite `attaform/zod` to a single-adapter entry, the devtools iframe
    // middleware, and the auto-import manifest re-export. Build-time
    // weight, so this cap is loose for the same reason the Nuxt one is.
    path: 'dist/vite.mjs',
    limit: '13 KB',
    gzip: true,
    ignore: ['vite'],
    modifyEsbuildConfig: asEsmNode,
  },
  // The cross-bundler `attaform/zod` rewrite plugins. Each is a
  // hand-written, zero-dependency Node build-time plugin: the shared
  // `core/detect-zod-major` (detection plus diagnostics) behind a thin
  // bundler-specific rewrite hook. They import nothing from their bundler
  // (structural types only), so each one is small and stable. The caps are
  // deliberately snug, as a tripwire against an edit that pulls runtime
  // weight into a build-time entry.
  {
    path: 'dist/rollup.mjs',
    limit: '1.25 KB',
    gzip: true,
    modifyEsbuildConfig: asEsmNode,
  },
  {
    path: 'dist/esbuild.mjs',
    limit: '1.25 KB',
    gzip: true,
    modifyEsbuildConfig: asEsmNode,
  },
  {
    path: 'dist/webpack.mjs',
    limit: '1.25 KB',
    gzip: true,
    modifyEsbuildConfig: asEsmNode,
  },
  {
    path: 'dist/rspack.mjs',
    limit: '1.25 KB',
    gzip: true,
    modifyEsbuildConfig: asEsmNode,
  },
  {
    // The Vue compiler transforms that give v-register its SSR markup.
    // Build-time only, with @vue/compiler-core external.
    path: 'dist/transforms.mjs',
    limit: '6 KB',
    gzip: true,
    ignore: ['@vue/compiler-core'],
    modifyEsbuildConfig: asEsmNode,
  },

  // Tree-shaking tripwires: a single named import, not the whole entry.
  //
  // The entries above cap each subpath's full inlined surface. They do not
  // prove that a consumer importing one symbol drops the rest. `import:`
  // does: size-limit's esbuild analyzer bundles only the named import and
  // tree-shakes the entry around it, so the figure here is the real cost
  // of that one symbol.
  //
  // The load-bearing case is `useWizard`, which shares a physical chunk
  // with `useAbstractForm`, the engine behind every `useForm`. Dropping it
  // therefore relies on the consumer bundler's intra-chunk dead-code
  // elimination rather than a whole-module drop. These caps are the
  // standing proof that elimination still works: a regression that makes
  // `useForm` transitively reach `use-wizard.ts`, say through a shared
  // helper migrating into it, pushes `{ useForm }` up by around 5 KB gzip
  // and trips the cap. No full-entry cap above can see that leak.
  //
  // These caps track the same shared core as the full entries, so they
  // bump in lockstep on a branch that legitimately grows `useForm`'s
  // closure. A jump LARGER than the accompanying full-entry bump is the
  // leak signal.
  {
    // Both adapters, since the entry dispatches, but none of the wizard,
    // injectForm, useRegister, unset or lazy surface the full cap covers.
    // The gap below that cap is the tree-shaken optional surface.
    name: 'zod: { useForm } only (no wizard/register/injectForm)',
    path: 'dist/zod.mjs',
    import: '{ useForm }',
    limit: '39.75 KB',
    gzip: true,
    ignore: ['zod'],
    modifyEsbuildConfig: asEsm,
  },
  {
    // One adapter, no dispatch, no wizard surface.
    name: 'zod-v4: { useForm } only',
    path: 'dist/zod-v4.mjs',
    import: '{ useForm }',
    limit: '35 KB',
    gzip: true,
    ignore: ['zod'],
    modifyEsbuildConfig: asEsm,
  },
  {
    // The v4 tripwire's peer, and the tightest of the three `{ useForm }`
    // caps, so a shared-core growth binds here first.
    name: 'zod-v3: { useForm } only',
    path: 'dist/zod-v3.mjs',
    import: '{ useForm }',
    limit: '36.5 KB',
    gzip: true,
    ignore: ['zod'],
    modifyEsbuildConfig: asEsm,
  },
  {
    // Reaching an ancestor form's surface (the callable proxies and the
    // FieldState read machinery) without the schema, validation or
    // store-creation `useForm` carries, and without the wizard surface.
    name: 'zod: { injectForm } only',
    path: 'dist/zod.mjs',
    import: '{ injectForm }',
    limit: '14.75 KB',
    gzip: true,
    ignore: ['zod'],
    modifyEsbuildConfig: asEsm,
  },
  {
    // Rebinding a field without creating a form. The baseline is small
    // enough that anything heavy leaking in (the form store, an adapter,
    // the wizard) shows up starkly rather than as a rounding error.
    name: 'zod: { useRegister } only',
    path: 'dist/zod.mjs',
    import: '{ useRegister }',
    limit: '9.5 KB',
    gzip: true,
    ignore: ['zod'],
    modifyEsbuildConfig: asEsm,
  },
  {
    // Byte-identical to the `zod: { useForm }` tripwire above, since
    // index.mjs and zod.mjs are the same bundle. This cap is the standing
    // proof that the barrel never diverges from the explicit Zod entry.
    name: 'attaform: { useForm } only (barrel == zod)',
    path: 'dist/index.mjs',
    import: '{ useForm }',
    limit: '39.75 KB',
    gzip: true,
    ignore: ['zod'],
    modifyEsbuildConfig: asEsm,
  },
  {
    // The leanest core import: the plugin and registry, none of the form,
    // adapter or wizard surface. Proof that pulling one core symbol out of
    // the barrel tree-shakes away the dispatcher and both Zod adapters,
    // which is the payoff of moving core into _shared-exports. A
    // regression that ropes an adapter into createAttaform's graph trips
    // here first.
    name: 'attaform: { createAttaform } only',
    path: 'dist/index.mjs',
    import: '{ createAttaform }',
    limit: '1.5 KB',
    gzip: true,
    ignore: ['zod'],
    modifyEsbuildConfig: asEsm,
  },
  {
    // The abstract form with neither Zod adapter, about 10 KB leaner than
    // the dispatcher's `{ useForm }`. A regression that pulls an adapter
    // into the abstract path would balloon this.
    name: 'abstract: { useAbstractForm } only',
    path: 'dist/abstract.mjs',
    import: '{ useAbstractForm }',
    limit: '27.5 KB',
    gzip: true,
    modifyEsbuildConfig: asEsm,
  },
]
