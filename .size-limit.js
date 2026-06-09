/**
 * Size-limit configuration. Moved out of package.json so each entry
 * can override esbuild's bundle format — measuring in ESM avoids the
 * `empty-import-meta` warning that fires when esbuild's default IIFE
 * format bundles a module using `import.meta.url` (Nuxt module) or
 * `import.meta.server` (Nuxt plugin). The gzipped size measurement
 * is the same either way; IIFE vs ESM only affects the wrapper.
 */

/** @param {import('esbuild').BuildOptions} config */
const asEsm = (config) => ({ ...config, format: 'esm' })

/**
 * For Node-side tooling entries (Nuxt module, Vite plugin, compiler
 * transforms): tell esbuild the bundle is for Node so `node:*`
 * builtins resolve as externals instead of failing with
 * `Could not resolve "node:path"`.
 */
/** @param {import('esbuild').BuildOptions} config */
const asEsmNode = (config) => ({ ...config, format: 'esm', platform: 'node' })

export default [
  {
    path: 'dist/index.mjs',
    // Raised 12 → 12.5 KB after the anonymous-forms work (PR #117)
    // + fingerprint warning landed in the shared core chunk.
    //
    // Raised 12.5 → 14.7 KB on the quiet-ambient-warnings branch
    // (PR #132): lazy ambient-collision walker in useFormContext +
    // source-frame normalization in useAbstractForm.
    //
    // Raised 14.7 → 16 KB on the per-element-persistence-opt-in
    // branch: opt-in registry, sensitive-name regex set + heuristic,
    // SensitivePersistFieldError, deleteAtPath copy-on-write,
    // writePathImmediately + clearPersistedDraft + isEmptyContainer
    // in the persistence layer, form.persist + form.clearPersistedDraft
    // in build-form-api, syncPersistOptIn lifecycle in directive,
    // PersistenceModule + PERSISTENCE_MODULE_KEY plumbing. Measured
    // at 15.08 KB; ~1 KB headroom for the docs/test follow-up commit.
    //
    // Raised 16 → 17 KB on the structural-completeness +
    // fingerprint-persistence branch: mergeStructural +
    // setAtPathWithSchemaFill in path-walker, schema.getDefaultAtPath
    // plumbing, cleanupOrphanKeys + sweepNonConfiguredStandardStores-
    // ForOrphans + sweepAllOrphansAcrossStandardStores, FormStorage
    // listKeys across three backends, fingerprint-suffixed key
    // composition.
    //
    // Raised 17 → 18 KB on the deep-QA cleanup branch:
    //   - DevTools redaction walker (redactSensitiveLeaves +
    //     expanded SENSITIVE_NAME_PATTERNS) for the timeline + inspector
    //   - one-shot adapter dev warnings (localStorage / sessionStorage /
    //     IDB) on quota / open / abort failures
    //   - createAttaform idempotent install dev-warn
    //   - v-register unsupported-element dev-warn (vRegisterDynamic)
    //   - validate() outside-effect-scope dev-warn (process-form)
    //   - schema-error gen-check on the submit success/failure paths
    //   - parseApiErrors maxTotalSegments cap
    //   - registerDrain + awaitPendingWrites on FormStore + Registry
    //     (drain-on-evict + Registry.shutdown)
    //   - <option> static-text fallback in the select transform
    //
    // Raised 18 → 19 KB on the useRegister branch: useRegister
    // composable + WeakSet sentinel (registerOwners), directive
    // tri-state guard with binding.instance.subTree.component lookup,
    // setAssignFunction undefined-no-op + pre-installed-assigner
    // respect, select-transform idempotency marker + kebab-case
    // extension (NATIVE_FORM_TAGS + hasHyphen gate). Measured at
    // 18.23 KB; 0.77 KB headroom for the docs/test follow-up commit.
    //
    // Raised 19 → 24 KB on the slim-primitive write-contract branch:
    // AbstractSchema.getSlimPrimitiveTypesAtPath + zod-v4 walker
    // (slim-primitives.ts), runtime gate (slim-primitive-gate.ts)
    // with one-shot dev-warn dedupe, boolean threading through every
    // setValueAtPath caller (register-api / build-form-api /
    // field-arrays / directive default assigner), vRegisterSelect
    // _assigning write-conditional, default-values issue-classifier
    // (slimPrimitivesOf + slimKindOf at issue path) replacing the
    // refinement-strip behaviour in zod-v4/v3 adapters. Measured at
    // 19.01 KB; the 5 KB ceiling gives runway for upcoming work
    // without per-PR bumps.
    //
    // Raised 24 → 28 KB on the 0.14 surface-refactor branch:
    //   - schema-driven coercion (schema-coerce.ts:
    //     defaultCoercionRules, defineCoercion, resolveCoercionIndex,
    //     buildCoerceFn / buildElementCoerceFn) wired through every
    //     register() + plugin defaults
    //   - register transforms pipeline (RegisterTransform threading
    //     through the directive assigner across all four v-register
    //     variants)
    //   - discriminated-union variant memory (per-variant subtree
    //     snapshot / restore on discriminator change, reset /
    //     resetField interactions)
    //   - useForm return surface rewrite — drillable callable proxies
    //     (errors-proxy.ts, surface-proxy.ts, leaf-aware FieldStateMap)
    //     + meta.errors flat aggregate + meta.instanceId
    //   - parseApiErrors bare-string entry shape
    //   - DOM force-sync after default assigner (4 v-register variants)
    //   - debounceMs: 0 sync-fire path in createDebouncedWriter +
    //     field-validation scheduler
    // Measured at 26.39 KB; 1.61 KB headroom for the follow-up docs /
    // test commit.
    //
    // Raised 28 → 30 KB on the field-state-metadata branch:
    //   - schema-attached metadata (fieldMeta registry, withMeta
    //     helper, humanize fallback, FieldMetaPayload interface,
    //     ResolvedFieldMeta) on both Zod adapters
    //   - AbstractSchema.getFieldMetaAtPath optional hook + adapter
    //     implementations (resolveFieldMetaAtPath + path-walker tree
    //     traversal + per-rootSchema WeakMap-cached path → payload
    //     map for shared-schema disambiguation across multiple paths)
    //   - unified FieldState shape — one type at every path, leaf or
    //     container, with aggregations rolled up at containers
    //     (event-presence by disjunction, uniformity by conjunction);
    //     FieldStateMapEntry rewrite + FieldStateMap mapped type
    //     stripping the optional flag (-?:)
    //   - container call-form: form.fields(path) + form.errors(path)
    //     return aggregated FieldState / ValidationError[] at any
    //     depth (third proxy shape: fieldStateTerminalAt; surface-
    //     proxy resolveCallTarget split between apply trap and get)
    //   - FormMeta = FieldState<F> & { submitting, submitCount,
    //     submitError, canUndo, canRedo, historySize, instanceId }
    //   - shared aggregateErrorsAt helper driving form.errors(p),
    //     form.fields(p).errors, and form.meta.errors through one
    //     active-variant-filtered computed
    //   - field.element / field.elements for native DOM ops
    //   - per-path validity gate (firstValidationDone +
    //     pathHasAsyncValidation) closing the meta.valid flash
    //     window for strict + async schemas
    //   - Zod 4 sync-refinement seed when async siblings throw
    //   - getSchemasAtPath-driven per-path validity in adapters
    // Measured at 28.77 KB; 1.23 KB headroom for the follow-up
    // docs / test commit.
    //
    // Raised 30 → 36 KB on the library-hardening + multi-tab branch:
    //   - multi-tab-sync.ts (~450 LOC): leader-election handshake
    //     (hello / announce / requestSnapshot / snapshot / patches),
    //     per-module senderId + protocol v: 1, inbound validation
    //     (path-segment safety, sensitive-path reject, per-patch type
    //     check, post-apply schema validate + rollback)
    //   - WriteMeta.crossTab + WriteMeta.persist meta flags threaded
    //     through applyFormReplacement, history listener, persistence
    //     writer, and every array helper
    //   - state.noSyncPaths Set<PathKey> + register-time opt-out
    //   - DEFAULT_SENSITIVE_NAMES exported frozen array + factories
    //     (createIsSensitivePath, createSegmentMatchesSensitive) with
    //     resolved closures threaded through persistence, sync, and
    //     devtools redaction walks
    //   - insecure-context-warn.ts: warnOnceInsecureContext(feature)
    //     shared dedup helper, isSecureContext() cross-runtime probe
    //   - reset() 4-part hardening: pre-merge through mergeStructural,
    //     schemaErrors re-derivation, sync validateAtPath rescue, and
    //     firstValidationDone gate restoration (the load-bearing fix
    //     for the post-reset valid:true flash on async-refining
    //     schemas)
    // Measured at 35.47 KB; ~0.5 KB headroom.
    //
    // Raised 36 → 38 KB when the multistep composable shipped
    // (registration, navigation, claim wiring, registry primitive,
    // FormStore handle additions, settle-path consult-defer branch
    // in useAbstractForm). Measured at 36.89 KB.
    //
    // Raised 38 → 39 KB on the multistep history + SSR branch:
    //   - history primitive (push/replace/popstate handle around
    //     `window.history`, no-op variant for SSR + disable path)
    //   - history config + popstate subscription + URL-seed +
    //     replace-on-mount in use-stepper.ts
    //   - StepperHistoryConfig + getServerActiveStep option types
    // Measured at 38.30 KB.
    //
    // Raised 39 → 40 KB on the file-input v-register branch:
    //   - vRegisterFile variant in directive.ts (real change-handler,
    //     blank-marking on register / clear, DOM-clear via el.value = '',
    //     scoped storage watcher for programmatic clears, persisted-file
    //     dev warn dedup via WeakMap<PersistOptInRegistry, Set<PathKey>>)
    //   - 'file' kind plumbing across the v4 adapter (ZodKind, kindOf,
    //     defaultForKind, slim-primitives with 'null' acceptance, plus
    //     case additions in assertSupportedKinds, fingerprint,
    //     path-walker, strip, adapter.walkForMeta)
    //   - cross-adapter SlimPrimitiveKind 'file' + slimKindOf File
    //     branch, v3 PERMISSIVE_V3 'file' entry
    //   - LeafWalker 'File' primitive so form.fields.<file-path>
    //     resolves to FieldState
    //   - syncPersistOptIn carve-out reads vnode.props.type to dodge
    //     the el.type pre-patch timing window
    // Measured at 38.78 KB.
    //
    // Raised 40 → 44 KB on the wizard composition branch (#221), which
    // shipped the v1 entry-form + graph-walker architecture
    // (useWizard(entry), wizard-graph.ts, normalize-next.ts) along with
    // the handleSubmit pipeline, completeness / submissionAttempts /
    // canAdvance state, reset, injectWizard composable, registry wizard
    // map, applyInvalidSubmitPolicy extraction, and the submissionAttempts
    // rename. Measured at 42.6 KB.
    //
    // v2 wizard rewrite (feat/wizard-v2): the graph machinery dropped
    // and steps became a positional list compiled at construction; the
    // surface gained string + function + defer() slots, universal
    // handleSubmit, namespaced allValues / allErrors / forms, and
    // restore / persist URL-sync callbacks. Net-net the budget held
    // — the new surfaces roughly offset the deleted graph code — so
    // the 44 KB ceiling stayed. Re-measure if the limit binds in CI.
    //
    // Raised 44 → 48 KB on the validation-signals refactor (PRs
    // #278-#281): displayState + show* projections replacing
    // shouldShowErrors (display-state.ts), deterministic field ids +
    // aria wiring driven from v-register (field-ids.ts, directive
    // applyAria + getSSRProps), form.list / form.record per-element
    // views + FieldState.key identity (array-identity.ts), and
    // identity-keyed element-state migration across array mutations
    // (array-state-migrate.ts) plus the structural-dirty signal.
    // Measured at 45.66 KB.
    //
    // Raised 48 -> 49 KB on the D1 lazy-load branch (bundle slim-down
    // Block D). Multi-tab sync moved to a dynamically-imported async
    // chunk, so the EAGER path shrank (the minimal-useForm eager set
    // dropped 46.36 -> 45.61 kB gz; see scripts/check-eager-size.mjs).
    // This cap measures the INLINED total, though: with no splitting,
    // esbuild inlines the dynamic import back, adding chunk-interop glue
    // and losing cross-module dedup, so the total ticks up ~0.5 kB even
    // as first-paint bytes drop. The real win lives in the eager gate;
    // this number is the full-feature ceiling. Measured at 48.06 KB.
    //
    // Raised 49 → 50 KB on the timed-display-state branch (#343): the
    // anti-flash display engine (display-state.ts timed reducer +
    // display-engine.ts per-form clock / single timer / machine map) lands in
    // the shared core chunk, read synchronously on every field access so it
    // cannot defer behind an async seam. Measured at 49.48 KB.
    //
    // Raised 50 → 52 KB on the async-register-transforms branch (#361):
    // the store-level transform primitive (beginTransform / endTransform /
    // isCurrentTransform / settleTransforms + activeTransforms counter +
    // per-field abort holder, committed through onFormChange), the
    // pre-validate drain in process-form's handleSubmit (await
    // settleTransforms before the authoritative pass), form.settleTransforms
    // on the public surface, the field / container `transforming` rollup,
    // and the vRegisterFile unification onto the shared transform pipeline
    // (Stage 2). Measured at 51.28 KB.
    limit: '52 KB',
    gzip: true,
    modifyEsbuildConfig: asEsm,
  },
  {
    path: 'dist/zod.mjs',
    // Raised from 12 KB → 14.7 KB to accommodate the v4 fingerprint
    // walker (src/runtime/adapters/zod-v4/fingerprint.ts, ~360 LOC of
    // structural-equivalence code that backs the shared-key mismatch
    // warning). Landed in 9bc2b5a / 590a03b / 7b89e64.
    //
    // Raised 14.7 → 16 KB on per-element-persistence-opt-in (mirrors
    // index.mjs — same shared core chunk). Measured at 15.03 KB.
    //
    // Raised 16 → 17 KB tracking index.mjs's structural-completeness +
    // fingerprint-persistence bump.
    //
    // Raised 17 → 18 KB tracking index.mjs's deep-QA cleanup bump
    // (same shared core chunk: DevTools redaction, dev-warns,
    // gen-checks, registry drain).
    //
    // Raised 18 → 19 KB tracking index.mjs's useRegister bump (same
    // shared core chunk: useRegister + sentinel + directive tri-state
    // + setAssignFunction undefined-no-op + select-transform
    // idempotency / kebab-case extension).
    //
    // Raised 19 → 24 KB tracking index.mjs's slim-primitive
    // write-contract bump (same shared core chunk + zod-v4
    // slim-primitives walker).
    //
    // Raised 24 → 28 KB tracking index.mjs's 0.14 surface-refactor
    // bump (same shared core chunk: coerce + transforms + DU memory
    // + meta-surface rewrite + DOM force-sync + sync-debounce).
    // Measured at 25.71 KB.
    //
    // Raised 28 → 30 KB tracking index.mjs's field-state-metadata
    // bump (same shared core chunk + v4 fieldMeta registry +
    // withMeta clone-on-write + getFieldMetaAtPath resolver + path-
    // walker tree traversal for shared-schema disambiguation).
    // Measured at 29.20 KB.
    //
    // Raised 30 → 45 KB on the unified-attaform/zod-entry branch.
    // `attaform/zod` is no longer a single-adapter subpath — it's
    // the runtime-dispatch unified entry that pulls in BOTH the
    // Zod 3 wrapper and the Zod 4 adapter so it can route on schema
    // shape at call time. The build-time alias in `attaform/vite`
    // rewrites `attaform/zod` imports to the matching explicit
    // subpath (`/zod-v3` or `/zod-v4`), so Vite consumers DON'T
    // ship this file in their bundle. The size cap covers the
    // "no Vite plugin" fallback path. Explicit-subpath consumers
    // (other bundlers) still get a lean ~30 KB v3 or v4 bundle.
    // Measured at 40.55 KB; 4.45 KB headroom.
    //
    // Raised 45 → 48 KB tracking index.mjs's library-hardening +
    // multi-tab bump (same shared core chunk: multi-tab sync module,
    // WriteMeta.crossTab/persist threading, noSyncPaths opt-out,
    // sensitive-names factory refactor, insecure-context-warn helper,
    // reset() 4-part hardening). Measured at 47.5 KB.
    //
    // Raised 48 → 49 KB on the defaultValues-trichotomy branch:
    //   - resolveTrichotomy classifier in core/
    //   - useAbstractForm trichotomy branch + microtask/onServerPrefetch
    //     settle path + pendingHydration re-fire guard
    //   - FormStore.defaultValuesFactory + isHydrating + hydrateError
    //     refs + rehydrate() method that re-fires the captured factory
    //     and re-applies via applyFormReplacement({ hydration: true })
    //   - meta.errorCount + meta.isSubmitted computed siblings
    // Measured at 48.03 KB.
    //
    // Raised 49 → 51 KB when the multistep composable was re-exported
    // from the unified `attaform/zod` entry. The full surface
    // (composable + registry + statuses proxy + history primitive)
    // now ships through this bundle too. Measured at 50.40 KB.
    //
    // Raised 51 → 52 KB tracking index.mjs's file-input v-register
    // bump (same shared core chunk: vRegisterFile variant, 'file'
    // ZodKind plumbing, persistence carve-out). Measured at 50.99 KB.
    //
    // Raised 52 → 56 KB tracking index.mjs's wizard composition
    // bump (#221): wizard graph walker, handleSubmit pipeline,
    // injectWizard, registry extension, applyInvalidSubmitPolicy
    // extraction, submitted/submissionAttempts split. Measured at
    // 54.98 KB.
    //
    // Raised 56 → 60 KB tracking index.mjs's validation-signals bump
    // (PRs #278-#281): same shared core chunk (displayState, field
    // ids + aria, form.list / form.record + FieldState.key,
    // identity-keyed state migration). Measured at 58.04 KB.
    //
    // Raised 60 → 62 KB on the v3-per-method-parity branch (Phase 9
    // of the audit-remediation series, closing D5–D19 + SF1/3/4/5/7/8
    // + B1). The unified `attaform/zod` entry bundles both adapters,
    // so it absorbs every byte added on both sides — v3 picks up
    // walkForMeta / pathMetaCache (D13 / SF3), mergeDeepV3 + setAtPath
    // (D19), an expanded unwrapToDiscriminatedUnion with catch +
    // intersection descent (D11), getLiteralValues (D12), generateValue
    // branches for NaN / void / any / unknown / never (D5 / D6),
    // isCoercePrimitive + hasDeclaredDefaultInChainV3 + preprocess
    // detection (D8), and fingerprint patches for nativeEnum /
    // pipeline / set / branded / object-checks (SF1 / SF4 / SF5 / SF7
    // / SF8 / D17). v4 picks up the symmetric catch peel in
    // unwrapToDiscriminatedUnion (D11) plus `'map' | 'symbol' |
    // 'function'` enumeration in ZodKind / kindOf / assert-supported
    // / default-values / strip (3 sites) / path-walker / fingerprint /
    // walkForMeta / slim-primitives (SF6). Phase 12 ADAPT-D1 dedup
    // reclaims when the per-adapter walkers collapse behind a single
    // `createAbstractSchema(introspector)` factory. Measured at
    // 61.06 KB.
    //
    // Raised 62 → 63 KB on the v3-async-contract branch (Phase 10 of
    // the audit-remediation series, ADAPT-A1 / D14 + D2 + D3 + D4).
    // v3 picks up the async-detection walkers (isAsyncEffect /
    // containsAsyncRefine / containsAsyncTransform) on the introspect
    // shim, a memoised `needsAsyncValidation` on the adapter, the
    // strip-async module (`stripAsyncChecks` + per-kind `carry*`
    // helpers for arrays / sets / objects), the restructured strict
    // `getDefaultValues` that parses against the real schema with
    // stripAsyncChecks fallback (Path A: try-parse, strip-on-throw,
    // no side effects on user predicates), and the
    // `validatorThrewResponse` wrap on every `safeParseAsync` call
    // inside `validateAtPath` (D4 — closes the no-uncaught-exceptions
    // gap). The unified zod.mjs absorbs the full v3 delta. Phase 12
    // dedup reclaims the introspect-walker duplication. Measured at
    // 62.33 KB.
    //
    // Raised 63 → 64 KB tracking index.mjs's timed-display-state bump (#343):
    // same shared core chunk (timed getDisplayState reducer + per-form display
    // engine). Measured at 63.23 KB.
    //
    // Raised 64 → 66 KB tracking index.mjs's async-register-transforms bump
    // (#361): same shared core chunk (transform primitive + handleSubmit
    // drain + settleTransforms surface + transforming rollup + vRegisterFile
    // unification). Measured at 65.09 KB.
    limit: '66 KB',
    gzip: true,
    ignore: ['zod'],
    modifyEsbuildConfig: asEsm,
  },
  {
    path: 'dist/zod-v4.mjs',
    // Explicit Zod 4 subpath. Mirrors what `attaform/zod` used to be
    // before the unified-entry rework: a single-adapter bundle with
    // strict typing. The Vite plugin rewrites `attaform/zod` to this
    // path at build time when zod@^4 is detected, so most Vite
    // consumers ship this regardless of which import they wrote.
    //
    // Cap at 36 KB to match zod-v3.mjs — unbuild's chunker pulls
    // unified-entry shared code into v4's closure on this branch,
    // adding ~5 KB over the pre-rework single-adapter baseline.
    // Measured at 34.89 KB.
    //
    // Raised 36 → 42 KB tracking index.mjs's library-hardening +
    // multi-tab bump (same shared core chunk). Measured at 41.62 KB.
    //
    // Raised 42 → 43 KB on the defaultValues-trichotomy branch
    // (same shared core chunk as zod.mjs). Measured at 42.11 KB.
    //
    // Raised 43 → 45 KB when the multistep composable was re-exported
    // from the `attaform/zod-v4` subpath. Same surface addition as the
    // `attaform/zod` unified entry. Measured at 44.46 KB.
    //
    // Raised 45 → 46 KB tracking index.mjs's file-input v-register
    // bump (same shared core chunk + v4-side 'file' ZodKind plumbing
    // across kindOf / defaultForKind / slim-primitives / fingerprint /
    // path-walker / strip / walkForMeta). Measured at 45.02 KB.
    //
    // Raised 46 → 51 KB tracking index.mjs's wizard composition
    // bump (#221): same shared core chunk additions (graph walker,
    // handleSubmit, injectWizard, registry). Measured at 49.2 KB.
    //
    // Raised 51 → 54 KB tracking index.mjs's validation-signals bump
    // (PRs #278-#281): same shared core chunk. Measured at 52.27 KB.
    //
    // Held at 54 KB through Phase 9 of the audit-remediation series
    // — v4 picked up the symmetric catch peel in
    // unwrapToDiscriminatedUnion (D11) plus `'map' | 'symbol' |
    // 'function'` enumeration across ZodKind / kindOf / assert-supported
    // / default-values / strip (3 sites) / path-walker / fingerprint /
    // walkForMeta / slim-primitives (SF6). Measured at 53.69 KB; the
    // 54 KB symmetry with zod-v3.mjs maintained without a bump.
    //
    // Raised 54 → 55 KB on the adapter-factory-part-2 branch (Phase 12
    // part 2 of the audit-remediation series, ADAPT-D2 + D3 + D5).
    // The three inner walkers (deriveDefault / slimPrimitives /
    // walkPathSegments) lifted into `core/walk-*` modules dispatched
    // through `SchemaIntrospector`. Net structure: v3 + v4 collectively
    // shrunk by ~600 LOC and gain a shared `core/walk-derive-default.ts`
    // (~440 LOC) + `core/walk-slim-primitives.ts` (~270 LOC) +
    // `core/walk-path-segments.ts` (~170 LOC) + `core/merge-deep.ts`
    // (~40 LOC), plus extension of the SchemaIntrospector contract by
    // 19 walker-accessor members and a `walker-introspector.ts` const
    // file per adapter. The shared-chunk allocator pulls a chunk of
    // the walker infrastructure into v4's closure; combined with the
    // catch-precedence service knob and the `peelEmbeddedDefault` /
    // `hasDeclaredDefaultInChain` helpers + chain-peel pre-check at
    // every node visit, that adds ~600 B to v4's gzipped surface.
    // Measured at 54.57 KB.
    //
    // Raised 55 → 56 KB on the file-extraction branch (Phase 17 of
    // the audit-remediation series). Three real fixes ship in this
    // phase that add bytes: PASS2-13 attaches a `pagehide` flush
    // listener for tab-close edit survival, PASS2-S2 adds the
    // per-write generation counter + drain loop to
    // `createDebouncedWriter`, and CORE-P3 collapses
    // `form.meta`'s 28 computed wrappers to inline getters (slightly
    // less compressible). The structural extractions
    // (variant-memory, array-bookkeeping, DU-stubs, ARIA, file,
    // lifecycle, wirePersistence) are net-neutral. Measured at
    // 55.14 KB.
    //
    // Raised 56 -> 57 KB on the bundle-slim D2 branch: persistence's
    // wiring + payload machinery (the onFormChange writer, envelope
    // read/build, debounce, pluck / strip / filter) moved onto a
    // dynamically-imported chunk so the always-on useForm path stops
    // shipping it. size-limit builds with NO code-splitting, so it folds
    // the dynamic import back inline and adds the chunk-interop glue plus
    // the dedup it can no longer share, ticking the INLINED total up even
    // though the EAGER set drops 45.61 -> 44.60 KB gz. The real D-metric
    // is scripts/check-eager-size.mjs (splitting:true); this cap tracks
    // only the inlined whole. Measured at 56.03 KB.
    //
    // Raised 57 → 58 KB tracking index.mjs's timed-display-state bump (#343):
    // same shared core chunk (timed display reducer + per-form engine).
    // Measured at 57.46 KB.
    //
    // Raised 58 → 60 KB tracking index.mjs's async-register-transforms bump
    // (#361): same shared core chunk. Measured at 59.27 KB.
    limit: '60 KB',
    gzip: true,
    ignore: ['zod'],
    modifyEsbuildConfig: asEsm,
  },
  {
    path: 'dist/zod-v3.mjs',
    // Raised 12 → 12.5 → 14.7 KB tracking index.mjs — the shared
    // core chunk carries anonymous-forms + fingerprint warning +
    // (now) lazy ambient-collision walker + source-frame
    // normalization, all inherited by the v3 adapter entry.
    //
    // Raised 14.7 → 16 KB on per-element-persistence-opt-in (mirrors
    // index.mjs). Measured at 14.71 KB.
    //
    // Raised 16 → 17 KB tracking index.mjs's structural-completeness +
    // fingerprint-persistence bump.
    //
    // Raised 17 → 18 KB on the deep-QA cleanup branch (same shared
    // core chunk as index.mjs PLUS v3-specific work: bounded
    // wrapper-peel recursion, ZodPipeline / ZodReadonly / ZodBranded /
    // ZodCatch handling, Symbol path-segment coercion).
    //
    // Raised 18 → 19 KB tracking index.mjs's useRegister bump (same
    // shared core chunk).
    //
    // Raised 19 → 24 KB tracking index.mjs's slim-primitive
    // write-contract bump (same shared core chunk + v3-inline
    // slimPrimitivesV3 walker on the v3 adapter).
    //
    // Raised 24 → 28 KB tracking index.mjs's 0.14 surface-refactor
    // bump (same shared core chunk + UseFormConfigurationWithZod
    // adding coerce / rememberVariants fields + getUnionDiscriminator
    // plumbing in the v3 adapter). Measured at 25.68 KB.
    //
    // Raised 28 → 30 KB tracking index.mjs's field-state-metadata
    // bump (same shared core chunk + v3 fieldMeta WeakMap shim +
    // withMeta clone via constructor+_def + v3 getFieldMetaAtPath
    // resolver). Measured at 29.05 KB.
    //
    // Raised 30 → 36 KB on the unified-attaform/zod-entry branch:
    // unbuild's chunker now shares more code between zod-v3.mjs and
    // the unified zod.mjs (which imports from both v3 and v4). The
    // shared chunk pulls extra symbols into v3's closure that
    // weren't there when zod.mjs was a single-adapter v4 bundle.
    // Measured at 34.49 KB; 1.51 KB headroom.
    //
    // Raised 36 → 42 KB tracking index.mjs's library-hardening +
    // multi-tab bump (same shared core chunk). Measured at 41.03 KB.
    //
    // Raised 42 → 44 KB when the multistep composable was re-exported
    // from the `attaform/zod-v3` subpath. Same surface addition as the
    // `attaform/zod` unified entry. Measured at 43.86 KB.
    //
    // Raised 44 → 45 KB tracking index.mjs's file-input v-register
    // bump (same shared core chunk + v3 PERMISSIVE_V3 'file' entry).
    // Measured at 44.41 KB.
    //
    // Raised 45 → 50 KB tracking index.mjs's wizard composition
    // bump (#221): same shared core chunk additions (graph walker,
    // handleSubmit, injectWizard, registry). Measured at 48.07 KB.
    //
    // Raised 50 → 53 KB tracking index.mjs's validation-signals bump
    // (PRs #278-#281): same shared core chunk. Measured at 51.13 KB.
    //
    // Raised 53 → 54 KB on the v3-walker-unification branch (Phase 8
    // of the audit-remediation series, D1 / D15 / D16 / R1). The v3
    // adapter's `getNestedZodSchemasAtPath` becomes a kind-switch
    // mirror of v4's `walkSegments` — descends ZodUnion / ZodTuple /
    // ZodIntersection / ZodLazy and peels ZodCatch transparently,
    // closing the five parity gaps the audit flagged. The structural
    // parallelism with v4 (now sharing the same accessor surface and
    // walker shape) is the unblocker for Phase 12's adapter dedup
    // factory (ADAPT-D1), which will collapse the parallel methods
    // into one and reclaim this slot and more. Matches v4's 54 KB
    // cap exactly — symmetry is honest, both adapters carry the
    // same surface area now. Measured at 53.24 KB.
    //
    // Raised 54 → 55 KB on the v3-per-method-parity branch (Phase 9
    // of the audit-remediation series, closing D5–D19 + SF1/3/4/5/7/8
    // + B1). v3 picks up walkForMeta / pathMetaCache / consumePayload
    // / peelAllV3Wrappers (D13 / SF3), mergeDeepV3 (D19), an expanded
    // unwrapToDiscriminatedUnion with catch + intersection descent +
    // effects peel (D11), getLiteralValues (D12), generateValue
    // branches for NaN / void / any / unknown / never (D5 / D6),
    // isCoercePrimitive + hasDeclaredDefaultInChainV3 + preprocess
    // detection in generateValue and isPreprocessOrCoerceLeaf (D8),
    // resolved.every all-vs-first union semantic in isRequiredAtPath
    // (D10), ZodVoid in isLeafRequiredV3 (D9), and fingerprint patches
    // for nativeEnum / pipeline / set / branded / object-checks
    // (SF1 / SF4 / SF5 / SF7 / SF8 / D17). Phase 12 ADAPT-D1 dedup
    // reclaims when the per-adapter walkers collapse behind a single
    // `createAbstractSchema(introspector)` factory. Measured at
    // 54.01 KB; symmetry with v4's 54 KB cap broke by 0.32 KB this
    // phase — accept the temporary asymmetry rather than padding v4
    // to match. Phase 12 dedup is the structural answer.
    //
    // Raised 55 → 56 KB on the v3-async-contract branch (Phase 10 of
    // the audit-remediation series, ADAPT-A1 / D14 + D2 + D3 + D4).
    // v3 picks up isAsyncEffect / containsAsyncRefine /
    // containsAsyncTransform on the introspect shim (~120 LOC of
    // walker mirroring v4's pattern), a memoised
    // `needsAsyncValidation` on the adapter, the new strip-async
    // module (`stripAsyncChecks` + per-kind `carry*` helpers for
    // arrays / sets / objects, ~250 LOC), the restructured strict
    // `getDefaultValues` that parses against the real schema with
    // `stripAsyncChecks` fallback (Path A: try-parse, strip-on-throw,
    // no side effects on user predicates), and the
    // `validatorThrewResponse` wrap on every `safeParseAsync` call
    // inside `validateAtPath` (closes the no-uncaught-exceptions gap
    // for refine / transform / preprocess throws on v3). Phase 12
    // dedup reclaims when the v3 + v4 async walkers collapse behind
    // the shared `createAbstractSchema(introspector)` factory.
    // Measured at 55.06 KB; symmetry with v4's 54 KB cap drift to
    // 1.37 KB this phase. Accept the temporary asymmetry rather than
    // padding v4 to match — the v3 walker semantic asymmetry (sync
    // refines wrap an async-capable closure; v3 cannot statically
    // distinguish) is intrinsic to v3's runtime and won't reverse.
    //
    // Raised 56 → 57 KB on the file-extraction branch (Phase 17 of
    // the audit-remediation series). Tracks the same three new fixes
    // that pushed v4 from 55 → 56 KB: PASS2-13 `pagehide` flush,
    // PASS2-S2 drain race fix in `createDebouncedWriter`, and
    // CORE-P3 `form.meta` computed→getter collapse. Measured at
    // 56.22 KB.
    //
    // Held at 57 KB on the drop-lodash-peer branch, which removed the
    // `lodash-es` peer dependency. The v3 adapter's only lodash uses
    // were `cloneDeep` (discriminated-union slim path) and `isFunction`,
    // now the dependency-free `cloneSchemaDeep` (clone-schema.ts) and a
    // `typeof` check. `lodash-es` left this entry's `ignore` list since
    // it is no longer a dependency. Self-size ticked 56.22 → 56.54 KB:
    // `cloneDeep` was external (ignored, so never counted here), whereas
    // `cloneSchemaDeep` is first-party and counted. The real win is
    // consumer-side and invisible to this number: a v3 consumer drops
    // lodash's ~5.0 KB gz `cloneDeep` closure for the ~0.35 KB clone, a
    // ~4.67 KB gz net reduction in their bundle.
    //
    // Raised 57 -> 58 KB on the D1 lazy-load branch (bundle slim-down
    // Block D), tracking index.mjs: multi-tab sync moved to an async
    // chunk. The eager path shrank, but size-limit inlines the dynamic
    // import back (it cannot see the eager/async split), so the inlined
    // total ticks up ~0.5 kB. See the index.mjs note plus the eager gate
    // (scripts/check-eager-size.mjs). Measured at 57.16 KB.
    //
    // Raised 58 → 59 KB tracking index.mjs's timed-display-state bump (#343):
    // same shared core chunk (timed display reducer + per-form engine).
    // Measured at 58.63 KB.
    //
    // Raised 59 → 60 KB tracking the v-register external-update sync (#362):
    // the shared-core directive-value-sync watcher (mirrors store changes
    // that don't ride a re-render onto the bound DOM control) ticks every
    // adapter's inlined total up; zod-v3.mjs, the tightest, crossed 59.
    // Measured at 59.05 KB.
    //
    // Raised 60 → 61 KB tracking index.mjs's async-register-transforms bump
    // (#361): same shared core chunk. Measured at 60.44 KB.
    //
    // Raised 61 → 62 KB tracking the targeted in-place apply (T2 keystroke
    // bust): the shared-core write funnel gains tryInPlaceLeafWrite
    // (path-walker) + applyTargetedWrite / commitWritePatches
    // (create-form-store), taking a single setValue from O(field-count) /
    // O(array-length) to O(depth). The inlined total (no splitting) absorbs
    // the full delta; zod-v3.mjs, the tightest adapter bundle, crossed 61.
    // Measured at 61.13 KB.
    limit: '62 KB',
    gzip: true,
    ignore: ['zod'],
    modifyEsbuildConfig: asEsm,
  },
  {
    path: 'dist/nuxt.mjs',
    // Raised 6 → 7 KB on the Nuxt DevTools overlay panel branch:
    //   - `nuxt.hook('ready')` + lazy-imported `@nuxt/devtools-kit`
    //     `addCustomTab` call (Attaform tab with iframe view targeting
    //     `/_attaform_devtools`).
    //   - `package.json`-version read via `createRequire` for the
    //     module's DevTools meta pill and runtime-config slot.
    //   - Polished module meta (`name: 'Attaform'`, `version`, `docs`).
    // Measured at 6.22 KB; ~0.8 KB headroom.
    //
    // Raised 7 → 14 KB on the wizard composition branch (#221):
    //   - useWizard SSR-prefetch hook integration into the Nuxt
    //     plugin path
    //   - registry wizard map extensions pulled in through the
    //     shared core chunk
    //   - SSR active-step seeding via getServerActiveStep
    // Measured at 12.56 KB.
    limit: '14 KB',
    gzip: true,
    ignore: ['@nuxt/kit', 'nuxt/app'],
    modifyEsbuildConfig: asEsmNode,
  },
  {
    path: 'dist/vite.mjs',
    // Raised 4 → 5 KB on the unified-attaform/zod-entry branch: the
    // plugin gained a `resolveId` hook + Zod-major detection
    // (`detectZodMajor` reads the consumer's `zod/package.json` via
    // `import.meta.resolve`) + the `resolveZodAlias` opt-out + the
    // associated diagnostic copy (missing-zod throw, unparseable-
    // version warn). Measured at 4.19 KB; ~0.8 KB headroom for the
    // follow-up docs / test commit.
    //
    // Raised 5 → 6 KB on the Nuxt DevTools overlay panel branch:
    // `configureServer` middleware that serves the iframe HTML at
    // `/_attaform_devtools` (Vite-layer middleware so the URL bypasses
    // vue-router and works for `app.vue`-only consumers without
    // forcing pages-mode). The HTML body is inlined as a string;
    // `server.transformIndexHtml` runs Vite's resolver across the
    // inline `<script type="module">` so bare specifiers like `vue`
    // and `attaform/devtools-panel` resolve through node_modules.
    // Measured at 5.16 KB; ~0.8 KB headroom.
    //
    // Raised 6 → 13 KB on the wizard composition branch (#221):
    //   - graph-walker module pulled into the Vite plugin's
    //     transform pipeline through shared core re-exports
    //   - wizard SSR / hydration handshake helpers visible to the
    //     transform side
    // Measured at 12.05 KB.
    limit: '13 KB',
    gzip: true,
    ignore: ['vite'],
    modifyEsbuildConfig: asEsmNode,
  },
  // Cross-bundler `attaform/zod` adapter-rewrite plugins (Block E). Each
  // is a hand-written, zero-dep Node build-time plugin: the shared
  // `core/detect-zod-major` (detection + diagnostics) plus a thin
  // bundler-specific rewrite hook. They import nothing from the bundler
  // (structural types only), so the gzipped size is small and stable;
  // the tight cap is a tripwire against a future edit accidentally
  // pulling runtime weight into a build-time entry. platform:node
  // externalizes the `node:*` builtins. Measured: rollup 811 B,
  // esbuild 906 B, webpack 849 B, rspack 849 B.
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
    path: 'dist/transforms.mjs',
    limit: '6 KB',
    gzip: true,
    ignore: ['@vue/compiler-core'],
    modifyEsbuildConfig: asEsmNode,
  },
]
