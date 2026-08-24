# P0: packaging config

Status: DONE 2026-08-23. Measured: 282.2 kB packed, 60 files (was 1.8 MB, 182);
eager unchanged at 46,477 B gz. Attribution not regenerated (no src changes).

Execution findings beyond the plan below:

- Two scripts used `dist/zod-v4.d.ts` as their built-dist sentinel
  (`check-bundled-types.mjs`, `check-doc-snippets.mjs`); both re-pointed at
  `.d.mts`.
- The bundled-types fixtures imported dist by relative extensionless paths,
  which only resolved through the deleted `.d.ts` flavor. Rewritten to package
  -name imports (`attaform/zod-v4`, ...), which typecheck the real exports-map
  resolution path via Node package self-reference.
- `test/packaging/exports.test.ts` now carries the new contract: no `main`
  field, no `require` conditions, and no `.cjs`/`.map`/`.d.cts` in a real
  dist. It only runs against a real (non-stub) dist, so mid-chain `pnpm test`
  skips it and `check:size`/`check:coverage` exercise it.
- The `.vue` stub choice fell out of the generic negation: `!dist/**/*.d.ts`
  prunes `*.vue.d.ts`, so `*.d.vue.ts` (the TS allowArbitraryExtensions shape)
  is the shipped flavor. No re-include rule needed.
- `check:doc-snippets` prints 7 tolerated typed mismatches; verified
  pre-existing on the pre-P0 tree (stash + rebuild baseline), exit 0 both.

## Changes

1. `build.config.ts`: `sourcemap: false` (both the top-level key and
   `rollup.esbuild.sourcemap`), `rollup.emitCJS: false`, `declaration: 'node16'`.
2. `package.json`:
   - exports `./nuxt`: drop the `require` condition (Nuxt 3+ loads ESM; kit uses jiti).
   - drop the `./types` export alias and the top-level `main` field ("types" top-level
     field stays, pointing at `./dist/index.d.mts`; verify `types` still resolves for
     TS "node16"/"bundler" resolution via the exports map, which it does per-entry).
   - `files`: add negation guards so a future config regression cannot silently
     re-ship weight: `"!dist/**/*.map"`, `"!dist/**/*.cjs"`, `"!dist/**/*.d.cts"`,
     `"!dist/**/*.d.ts"` (keep `.d.mts`; NOTE the two mkdist `.vue` declaration stub
     shapes: `*.vue.d.ts` and `*.d.vue.ts`, both currently double-shipped; keep
     exactly one shape, prune the other, and add the matching negation).
3. New `scripts/check-tarball-size.mjs`: runs `npm pack --dry-run --json
--ignore-scripts`, asserts packed size under a committed budget (start 350_000 B;
   P1 raises it to ~500_000 when the dev flavor lands, with a recorded reason).
   Wire as `check:tarball` into the root `check` script after `check:size`.
4. `.size-limit.js`: entries unchanged (they measure dist/\*.mjs). Sanity-run.

## Watchpoints found in the audit

- unbuild logs "Potential missing package.json files: dist/nuxt.cjs" once the require
  condition is dropped later than the emitCJS flip; do both in the same commit.
- `test/source-shape.test.ts` guards the mkdist directional contract; run it after the
  .vue stub pruning to be sure the tripwire logic does not reference the pruned shape.
- Grep the repo for `dist/index.cjs` / `.cjs` references (nuxt module resolver paths,
  docs) before landing; the audit found the CJS tree fully unreachable but verify at
  execution time.
- Consumer smoke: `pnpm dev:prepare && pnpm check:site` (site typecheck resolves the
  package through the exports map) plus one `vue-tsc` pass in apps/site catches a
  broken types resolution immediately.

## Acceptance

- `npm pack --dry-run --ignore-scripts`: packed <= 350 kB, no .map/.cjs/.d.cts/.d.ts
  (non-mts) in the file list; total files ~60.
- Full `pnpm check` green. `check:eager` unchanged (46,477 +- minifier noise).
- Ratchet actions: add tarball budget; no BUDGET_GZ change; ledger row updated.
