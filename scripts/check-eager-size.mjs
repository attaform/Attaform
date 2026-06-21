#!/usr/bin/env node
/**
 * Eager-byte regression gate. Measures the gzipped EAGER cost of a
 * minimal `useForm` consumer: the bytes paid on first paint by every
 * consumer, before any lazy feature runs. Fails if it exceeds the
 * committed budget.
 *
 * Why a bespoke script and not a `.size-limit.js` entry: size-limit's
 * esbuild config has no `splitting`, so it inlines dynamic `import()`
 * back into the entry and measures eager + async together. That total
 * is blind to whether a feature sits on the eager path, so it cannot
 * gate the eager/async split that the lazy-loading work banks. This
 * script builds with `splitting: true`, walks the esbuild metafile from
 * the entry following only `import-statement` edges (the eager set),
 * and gzips just those chunks. Same methodology as
 * analysis/measure-split.mjs, kept as a standing CI guard.
 *
 * A production `define` (`process.env.NODE_ENV` -> "production") is
 * applied so the measured bytes match what a consumer's prod build
 * ships, including the dev-branch dead-code elimination from
 * core/dev.ts.
 *
 * Zero new deps: esbuild is already installed (transitively, via vite /
 * size-limit). pnpm keeps it under node_modules/.pnpm, so we resolve
 * the newest installed copy from there.
 *
 * CLI: `node scripts/check-eager-size.mjs` enforces the budget.
 * Library: `import { measureEager }` powers test/packaging/dev-dce.test.ts.
 */
import { gzipSync } from 'node:zlib'
import { readdirSync, realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { argv, exit } from 'node:process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// Resolve esbuild from the pnpm store. It is a transitive dep (not in
// top-level node_modules), and several versions can coexist; pick the
// newest by numeric semver so a version bump needs no edit here.
function resolveEsbuild() {
  const store = join(ROOT, 'node_modules', '.pnpm')
  const dirs = readdirSync(store).filter((d) => /^esbuild@\d+\.\d+\.\d+/.test(d))
  if (!dirs.length) throw new Error('esbuild not found under node_modules/.pnpm')
  const parts = (d) =>
    d
      .slice('esbuild@'.length)
      .split('.')
      .map((n) => parseInt(n, 10))
  dirs.sort((a, b) => {
    const [A0, A1, A2] = parts(a)
    const [B0, B1, B2] = parts(b)
    return A0 - B0 || A1 - B1 || A2 - B2
  })
  return join(store, dirs[dirs.length - 1], 'node_modules', 'esbuild', 'lib', 'main.js')
}
const esbuild = (await import(resolveEsbuild())).default

const V4 = join(ROOT, 'src', 'zod-v4.ts').replace(/\\/g, '/')

// Exercise the full minimal-useForm surface so tree-shaking keeps the
// real eager set. A bare `import { useForm }` with no uses would shake
// most of it away and under-measure.
const SCENARIO = `import { useForm } from '${V4}'
export const make = (s) => {
  const f = useForm({ schema: s, key: 'k' })
  return [f.values, f.errors, f.fields, f.register('x'), f.handleSubmit(() => {}), f.setValue('x', 1), f.meta, f.reset()]
}`

const PROD_DEFINE = { 'process.env.NODE_ENV': '"production"' }

/**
 * Build the scenario with code-splitting and return the eager/async
 * byte split plus the per-chunk input lists (so callers can assert a
 * module is or isn't on a given path) and the concatenated output text
 * (so callers can assert a dev-only string was dead-code-eliminated).
 * @param {Record<string, string>} define
 */
export async function measureEager(define = PROD_DEFINE) {
  const r = await esbuild.build({
    stdin: { contents: SCENARIO, loader: 'ts', resolveDir: ROOT },
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2020',
    platform: 'neutral',
    packages: 'external',
    splitting: true,
    define,
    metafile: true,
    write: false,
    outdir: 'out',
    legalComments: 'none',
    logLevel: 'silent',
  })
  const fileOf = (k) => k.replace(/^.*\//, '')
  const byPath = new Map(r.outputFiles.map((f) => [fileOf(f.path), f.text]))
  const outputs = {}
  for (const [k, v] of Object.entries(r.metafile.outputs)) outputs[fileOf(k)] = v

  const entryKey =
    Object.keys(outputs).find((k) => outputs[k].entryPoint === '<stdin>') ||
    Object.keys(outputs).find((k) => k.startsWith('stdin'))
  const eager = new Set()
  const queue = [entryKey]
  while (queue.length) {
    const cur = queue.shift()
    if (eager.has(cur) || !outputs[cur]) continue
    eager.add(cur)
    for (const imp of outputs[cur].imports || []) {
      const t = fileOf(imp.path)
      if (imp.kind === 'import-statement' && outputs[t]) queue.push(t)
    }
  }
  const asyncSet = Object.keys(outputs).filter((k) => !eager.has(k))

  // Reachable set: BFS over ANY edge kind (statement or dynamic-import).
  // A chunk that no edge reaches is an orphan esbuild emitted but nothing
  // loads (e.g. a dynamic import dead-code-eliminated behind `__DEV__`).
  const reachable = new Set()
  const rq = [entryKey]
  while (rq.length) {
    const cur = rq.shift()
    if (reachable.has(cur) || !outputs[cur]) continue
    reachable.add(cur)
    for (const imp of outputs[cur].imports || []) {
      const t = fileOf(imp.path)
      if (outputs[t]) rq.push(t)
    }
  }

  const gzOf = (k) => {
    const c = byPath.get(k)
    return c ? gzipSync(Buffer.from(c), { level: 9 }).length : 0
  }
  const sumGz = (set) => [...set].reduce((a, k) => a + gzOf(k), 0)
  const inputsOf = (set) => [...set].flatMap((k) => Object.keys(outputs[k].inputs || {}))

  return {
    eagerGz: sumGz(eager),
    asyncGz: sumGz([...asyncSet]),
    eagerInputs: inputsOf(eager),
    asyncInputs: inputsOf(asyncSet),
    // Inputs of every chunk a consumer actually loads. Excludes orphans,
    // so a `__DEV__`-gated dynamic import drops out of the prod build.
    reachableInputs: inputsOf(reachable),
    // Concatenated text of the eager chunks only (where the eager `import`
    // call sites live). Excludes orphan chunk bodies, so a dev-only string
    // that was dead-code-eliminated is genuinely absent here.
    eagerText: [...eager].map((k) => byPath.get(k) || '').join('\n'),
  }
}

// Committed eager budget (gz bytes) for a minimal `useForm` (zod-v4).
// Baseline measured at 46.28 kB gz when this gate landed, with the
// dev-flag DCE win (core/dev.ts) folded in under the production define.
// D1 then lazy-loads multi-tab sync onto the async path (45.61 kB gz),
// D2 lazy-loads persistence's wiring + payload machinery (the
// onFormChange writer, envelope read/build, debounce, pluck / strip /
// filter) onto the async path (44.60 kB gz), and D3 lazy-loads the
// schema fingerprint walker + its canonicalStringify helper (only the
// opt-in persistence key path plus a dev-only mismatch warning consume
// them), landing the eager set at 44.38 kB gz; the
// budget is tightened here to lock that in. The single-adapter delta is
// modest because the async deferral machinery offsets most of the
// fingerprint bytes, but the unified `attaform/zod` entry (both adapters'
// walkers leave eager against the same one-time machinery) drops ~1.0 kB.
// Block F then moves the dev-only shared-key collision warnings into their
// own dynamic-imported module, so a prod build orphans that chunk instead of
// shipping it as dead code (esbuild keeps a top-level function called only
// from a dead `__DEV__` branch — tree-shaking runs before the define-fold),
// landing the eager set at 43.91 kB gz.
//
// RECORDED LOOSENING (anti-flash display timing): the timed `getDisplayState`
// reducer + the per-form display engine (clock / single timer / machine map)
// sit on the eager path because `field.displayState` is read synchronously on
// every field access — there is no async seam to defer them behind. That is a
// deliberate capability-for-bytes trade (a polished, tunable anti-flash
// spinner baked into every form, otherwise re-built ad hoc by each consumer),
// landing the eager set at 44.51 kB gz. The container / form.meta rollup (#346)
// then consumed that headroom, landing the eager set at exactly 45.00 kB gz.
//
// RECORDED LOOSENING (form.meta pending during submit): form.meta reads as
// pending while a submit runs its own validation pass, so one
// `form.meta.showPending` can drive a form-level "validating" affordance. The
// projection reads `state.submitting` + `state.activeValidations` at the root,
// landing the eager set at 45.01 kB gz. Budget raised to restore ~0.5 kB
// headroom for minifier-version drift. The lazy-loading work tightens this as
// optional features move to the async path; never loosen it without a recorded
// reason in the commit.
//
// RECORDED LOOSENING (async register transforms, #361): the async-transform
// feature (Stage 1 store primitive — beginTransform / endTransform /
// settleTransforms + activeTransforms + transformErrors; Stage 2 vRegisterFile
// unification) sits on the always-on useForm path. register() runs the
// sync-fast transform pipeline on every write, handleSubmit drains in-flight
// transforms before its authoritative pass, and form.settleTransforms is a
// public surface — none has an async seam. Deferring only the await/commit
// orchestrator was evaluated and declined: it reclaims a fraction of the cost
// and would push the synchronous `transforming` flip (beginTransform runs
// inside the assigner) behind a dynamic import, lagging the busy state by a
// microtask. Keeping it eager is the deliberate trade. Measured at 46.67 kB gz;
// budget raised to restore ~0.5 kB headroom for minifier-version drift.
//
// RECORDED LOOSENING (targeted in-place apply, T2 keystroke bust): the
// single-`setValue` fast path (tryInPlaceLeafWrite + applyTargetedWrite)
// mutates the target leaf's slot in place when it already exists, preserving
// ancestor container identity and taking the keystroke from O(field-count) /
// O(array-length) to O(depth) — 100-230x at scale on the matrix bench. It
// sits on the always-on write funnel (every setValue), so it cannot defer
// behind an async seam. Measured at 47.35 kB gz; budget raised to restore
// ~0.5 kB headroom for minifier-version drift. The ~9 kB of known
// eager-optional features (bundle-size analysis) remain the place to reclaim
// this; never loosen without a recorded reason.
//
// NOTE (multi-tab-sync removal, chore/rip-multitab): multi-tab sync has been
// async since D1, so deleting it barely moves the eager set — only the
// core-anchored remnants (WriteMeta.crossTab thread, state.noSyncPaths
// ref-counted opt-out) come off here, landing eager at 47.61 kB gz, held
// within the budget with no change. The real reclaim is the ~2 kB the inlined
// async chunk freed from the full bundle, locked in via the .size-limit.js
// cap ratchets (54→52 / 68→66 / 62→60 / 64→62 KB).
//
// NOTE (persist removal, chore/rip-persist): persist was lazy since D2, but its
// core-anchored remnants were heavier than multi-tab's — the persistOptIns
// registry, the isSensitivePath resolution, the sensitive-names static import,
// the insecure-context-warn helper, and the WriteMeta.persist thread all come
// off the eager path, landing eager at 43.48 kB gz (down ~4.1 kB). Budget
// ratcheted 49_000 → 46_000 to lock it in; the full-bundle reclaim (~6 kB per
// entry) is locked via the .size-limit.js caps (52→46 / 66→60 / 60→54 / 62→56).
//
// NOTE (form.onChange removal, chore/rip-onchange): the onChange seam shipped
// eager (its dispatch ran on the write funnel, with no async seam to defer it
// behind), so removing on-change.ts + the registry + the WriteMeta.silent
// thread drops the eager set ~1.0 kB, landing it at 42.47 kB gz. Budget
// ratcheted 46_000 → 44_000 to lock it in; the full-bundle reclaim (~2 kB per
// entry) is locked via the .size-limit.js caps (46→44 / 60→58 / 54→52 / 56→54).
//
// RECORDED LOOSENING (esbuild 0.28.1 minifier drift + v-register third-party
// binding): the #456 dev-deps bump moved esbuild to 0.28.1 (lockfile-pinned via
// vite@8.0.16; this script resolves it as the newest installed copy), whose minifier
// emits a larger output. Core features also landed since the onChange removal without
// a ratchet (error model #423, submit semantics #438). Together these push the
// clean-main eager set to ~44_011 bytes, ~11 bytes over the 44_000 budget independent
// of any feature branch. The third-party-component v-model desugar then adds a small
// setValueFromHost on the eager RegisterValue (a v-model host emits its typed value
// through onUpdate:modelValue with no DOM input listener to flip the sticky interacted
// bit, so the host write bundles the value write with markInteracted), landing eager
// at ~44_020 bytes. Budget raised 44_000 → 44_500 to restore ~0.5 kB headroom for
// minifier-version drift; never loosen it without a recorded reason in the commit.
//
// RECORDED LOOSENING (v-register third-party Phase 5, feat/v-register-third-party):
// the directive's no-latch host branch grows the rich FieldState for composite and
// control-less third-party widgets. Item 1 (composite / no-control focus) adds an
// rv.markFocused delegate plus a focusin / focusout pair on the widget root (with a
// relatedTarget containment check so intra-widget tabbing is not a blur), since a
// host with no single latchable control has no element-level focus listener. That
// lands eager at ~44_523 bytes. Two more Phase 5 items landed on the same eager
// directive path: async self-heal (a scoped MutationObserver that latches a control
// rendered after mount) and the multi-root drop diagnostic (a dev-only warn in
// setValueFromHost when a value update arrives but the directive never attached; the
// non-v-model diagnostic was dropped as undetectable post-matrix). Budget raised
// 44_500 → 45_500 once for the whole phase rather than per item. Phase 5 is now
// complete and lands eager at ~45_080 bytes, ~0.41 kB under this budget -- about the
// conventional drift headroom, so the phase-wide estimate held and the budget stays
// at 45_500. Never loosen further without a recorded reason.
const BUDGET_GZ = 45_500

const isMain = import.meta.url === pathToFileURL(realpathSync(argv[1])).href
if (isMain) {
  const { eagerGz, asyncGz } = await measureEager()
  const kb = (b) => (b / 1024).toFixed(2)
  console.log(`eager (minimal useForm, zod-v4, prod): ${kb(eagerGz)} kB gz`)
  console.log(`async (lazy chunks):                   ${kb(asyncGz)} kB gz`)
  console.log(`budget:                                ${kb(BUDGET_GZ)} kB gz`)
  if (eagerGz > BUDGET_GZ) {
    console.error(`\n✗ eager budget exceeded by ${kb(eagerGz - BUDGET_GZ)} kB gz`)
    exit(1)
  }
  console.log(`\n✓ within budget (${kb(BUDGET_GZ - eagerGz)} kB gz headroom)`)
}
