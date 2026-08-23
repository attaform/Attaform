# Attaform size-teardown ground truth (2026-08-23, main @ fb532ad9, v0.27.6)

## Mission

Find how to cut the attaform package size by ~50% without losing features, via deep
refactoring. Fresh-perspective mandate from the author: every past "settled" decision is
open; breaking API changes are fine (pre-1.0, zero users); prefer the ideal architecture
over the current implementation. This pass is ANALYSIS ONLY: produce findings + designs,
not code changes. Optimize for minified+gzipped consumer cost first, npm tarball second,
runtime performance as a co-goal. Zero runtime dependencies is a hard constraint.
Supported stack: Vue 3.5+, Nuxt 3/4, Zod v3 AND v4 (both first-class), SSR included.

## What the library is

Schema-driven, type-safe form library for Vue/Nuxt. Feature surface: useForm (zod v3/v4
or schema-agnostic "abstract"), v-register directive + register() bindings (native +
third-party component hosts), 3-channel error model (schema/blank/user), display-state
engine (anti-flash timing, earned-success), field arrays w/ identity + state migration,
async register transforms, submit pipeline w/ focus-first-error, wizard (multi-step),
history/undo-redo, SSR serialize/hydrate, Nuxt module + devtools panel, Vite/webpack-family
build plugins w/ compile-time template transforms, AI skill assets in tarball.

## Baseline numbers (all measured on this machine, esbuild 0.28.x, prod define, minified)

### Eager cost (code-split, import-statement edges only; scripts/check-eager-size.mjs method)

- zod-v4 minimal useForm: 45.39 kB gz eager + 2.54 async <- ratchet metric, budget 46_500 B
- zod-v3 minimal useForm: 46.08 kB gz
- default barrel 'attaform' minimal useForm: 50.77 kB gz <- BOTH zod adapters load eagerly
- abstract (no zod): 36.85 kB gz <- the schema-agnostic core floor
- v4 + wizard: 50.60 kB gz (wizard adds ~5.2)
- 50% target ≈ 23 kB gz for minimal v4; core floor must drop to ~17-18 kB gz.

### size-limit (whole entry, dynamic imports inlined, gz)

index/zod useForm-only 54.98 kB | zod-v4 48.87 | zod-v3 50.34 | abstract 39.53
injectForm-only 24.75 | useRegister-only 10.75 | createAttaform-only 9.1
nuxt.mjs 8.54 | vite.mjs 8.04 | transforms 4.14 | rollup/esbuild/webpack/rspack ~0.9 each

### npm tarball: 1.8 MB packed / 6.9 MB unpacked / 182 files

- dist .mjs+.cjs 1.13 MB; dist sourcemaps 4.34 MB (63% of unpacked!); dist d.ts 1.30 MB
- one 229 KB type bundle shipped in TRIPLICATE (.d.ts + .d.mts + .d.cts identical)
- full CJS twin of the runtime (281 KB + 1.1 MB map) exists though only ./nuxt exposes require
- skills/ 40 KB, bin/ 8 KB. Source: 148 files, ~45k lines TS.

### Eager attribution, zod-v4 scenario (gz-attributed; full tables in attribution-v4.txt / attribution-index.txt)

By dir: runtime/core 39.5 kB gz (60 files!) | zod-v4 adapter 5.5 | composables 1.1
Top files (gz): create-form-store 7272 | directive 3202 | build-form-api 2755 |
field-state-api 1828 | process-form 1566 | v4/strip 1547 | v4/introspect 1516 |
abstract-schema-factory 1313 | surface-proxy 1260 | path-walker 1190 | history 1127 |
v4/adapter 1092 | use-abstract-form 1089 | register-api 1086 | walk-derive-default 1021 |
assigner-pipeline 936 | diff-apply 914 | errors 852 | walk-slim-primitives 742 | paths 698 |
slim-primitive-gate 676 | directive-aria 652 | schema-coerce 640 | walk-field-meta 631 |
unset-walker 623 | field-state-proxy 602 | errors-proxy 594 | registry 512 | array-identity 503
(gz ≈ raw_minified × 0.31 for estimating)

## Structural facts already established

1. WELD: use-form -> use-abstract-form -> core/plugin (ensureAttaformInstalled) -> vRegister
   -> entire directive stack (~4.6 kB gz) is eager for EVERY consumer even with no v-register.
2. use-abstract-form statically imports createHistoryModule -> history (1.1 kB gz) eager
   though undo/redo is an opt-in feature.
3. The default barrel ('.') === src/zod.ts surface: runtime zod-major detection keeps BOTH
   adapters eager (+5.4 kB vs single-adapter entry).
4. zod-v3 adapter 7.15 kB gz + zod-v4 5.5 kB gz = two full parallel implementations
   (introspect/strip/clone/fingerprint/errors/slim-primitives each duplicated per major).
   jscpd finds only 0.66% literal clones: the duplication is semantic, not textual.
5. The zod path ALSO carries the abstract layer (abstract-schema-factory 1.3 kB +
   use-abstract-form 1.1 kB): adapter-over-abstract double layering.
6. Many parallel tree-walkers: path-walker, walk-path-segments, walk-derive-default,
   walk-field-meta, walk-slim-primitives, unset-walker, diff-apply, merge-deep,
   merge-hydration, canonical-stringify (+ per-adapter walker-introspectors).
7. Proxy zoo on the API surface: surface-proxy, errors-proxy, field-state-proxy,
   values-proxy, callable-readonly-snapshot-proxy, proxy-live-keys, proxy-readonly-helpers,
   wizard-statuses-proxy (~3.2+ kB gz total).
8. Store is a 4,381-line closure (create-form-store) capturing every subsystem; every form
   instance allocates every method; bundle cannot tree-shake unused store capabilities.
9. Dev-only code is mostly DCE'd via **DEV** + prod define (dev-key-collision-warnings is
   an async orphan chunk in prod). Verify remaining dev/warn strings on the eager path.
10. Build: unbuild/rollup, unminified ESM + full sourcemaps + dts rollup; emitCJS true.
11. sideEffects:false is set; hoistTransitiveImports:false. Comments are the repo's style:
    massive doc-comments everywhere (do NOT count comment removal as a size win: the
    minifier already strips them; but .map sourcesContent ships them in the tarball).

## What "50%" means (agreed targets to design against)

- minimal v4 eager: 45.4 -> ≤23 kB gz. Whole-entry useForm-only: 48.9 -> ≤25 kB gz.
- tarball: 1.8 MB -> ≤0.6 MB packed (maps policy + dts dedupe + CJS drop get most of it).
- Runtime perf must not regress; ideally mount/keystroke improve (fewer allocations,
  method sharing, less proxy indirection).

## Constraints & non-constraints

- KEEP: zero runtime deps; Vue 3.5+ / Nuxt; zod v3+v4 first-class; SSR; the feature list
  above (features may become opt-in/lazy/subpath if DX stays reasonable; flag any such
  API change explicitly as api_impact:"public").
- FREE: any internal restructure; any public API reshape (author reviews proposals);
  moving features to subpath entries; changing defaults; deleting truly-low-value
  surface (justify case-by-case); replacing unbuild; changing d.ts strategy.
- Report est_gz_savings_bytes against the minimal-v4 eager set unless the finding is
  tarball-only (then say so in detail).
