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
    //
    // Raised 52 → 53 KB on the P3 render-isolation bust
    // (perf/runtime-analysis): getFormMetaBase's eager `{ ...rootBase }`
    // spread became per-field LAZY getters (the 28 FieldStateBase rollup
    // fields + errorCount), so the library-default predicate tracks only the
    // O(1) form-level scalars (submissionAttempts, ...) instead of the
    // whole-form rollup. That kills the O(field-count) component over-render on
    // the form.fields surface — a sibling field's edit no longer wakes every
    // field's computed. The 28 getters are slightly less compressible than the
    // prior spread, the same trade the CORE-P3 form.meta getter collapse
    // already took (see zod-v4.mjs). Output is byte-identical (the behavior-lock
    // golden held). Measured at 52.13 KB.
    //
    // Raised 53 → 54 KB on the form.onChange branch (#395): the change
    // seam ships in the shared core chunk. on-change.ts holds the per-path
    // + whole-form handler registry and the change context (attempt /
    // signal / retry) with abort + retry plumbing; create-form-store.ts
    // dispatches at the write funnel and threads the { silent } write
    // opt-out through setValue / reset so hydration and reset never fire
    // saves; build-form-api.ts + use-abstract-form.ts surface form.onChange
    // + useForm({ onChange }). Measured at 53.39 KB.
    //
    // Lowered 54 → 52 KB on the multi-tab-sync removal branch
    // (chore/rip-multitab): multi-tab-sync.ts and the async chunk
    // esbuild inlines back into this single-file build left the bundle,
    // along with the WriteMeta.crossTab thread, the state.noSyncPaths
    // ref-counted opt-out, and the RegisterValue markNoSync /
    // unmarkNoSync hooks. Measured at 51.44 KB.
    //
    // Lowered 52 → 46 KB on the persist removal branch (chore/rip-persist):
    // the persistence/ engine, sensitive-names, insecure-context-warn, the
    // persistOptIns / isSensitivePath core remnants, and the WriteMeta.persist
    // thread all left the bundle. Measured at 44.52 KB.
    //
    // Lowered 46 → 44 KB on the form.onChange removal branch
    // (chore/rip-onchange): on-change.ts, the change registry + dispatch at the
    // write funnel, and the WriteMeta.silent / SetValueOptions thread all left
    // the shared core chunk. Measured at 43.43 KB.
    //
    // Raised 44 → 45 KB on the v-register third-party-component branch
    // (feat/v-register-third-party): the directive's component-host
    // element-discovery branch (activateComponentHost's latch / no-latch /
    // self-heal / widget-root focus, plus the registerValue DOM-attr strip),
    // create-form-store's markHostConnected, the RegisterValue host delegates,
    // and the directly-bound-container own-record field-state fold all ship in
    // the shared eager core. Measured at 44.28 KB.
    //
    // Raised 45 -> 46 KB tracking the #464 redundant-binding guard: the
    // directive's eager `warnRedundantStateBinding` dev-warn lands in the
    // shared core this bundle ships. Measured at 44.94 KB.
    //
    // Raised 46 → 62 KB on the schema-entry re-partition (barrel flip):
    // src/index.ts is now `export *` from _shared-exports + _zod-binding,
    // structurally identical to dist/zod.mjs. This entry is no longer the
    // abstract barrel (~45 KB, which now lives at dist/abstract.mjs); it is
    // the Zod-default dispatcher + core. Measured at 60.97 KB — byte-for-byte
    // the same as zod.mjs. The `{ useForm }` tripwire below held at 54 KB, so
    // a real single-import consumer pays nothing for the whole-entry growth.
    //
    // Under a bundler plugin (attaform/vite|rollup|esbuild|webpack|rspack)
    // with a single Zod major detected, bare `attaform` is rewritten to the
    // pinned adapter (Phase 3 — the same rewrite `attaform/zod` already got),
    // so a plugin-using consumer ships the dist/zod-v4.mjs / dist/zod-v3.mjs
    // single-adapter weight (see those entries: 56 / 57 KB) rather than this
    // dispatcher measurement — the recommended `attaform` import is as lean as
    // the explicit pin. This 62 KB cap is the no-plugin (runtime-dispatch)
    // ceiling; there is no separate under-plugin measurement because the
    // rewrite lands the consumer on the zod-v3/v4 entries already capped below.
    //
    // Raised 62 → 63 KB on the gating branch (feat/form-disabled, #523).
    // useForm({ disabled }) lands the bypass-proof data freeze in the shared
    // eager core: the effectiveDisabled computed + externalLock ref, the
    // setValueAtPath write gate + warn-once, field.disabled /
    // form.meta.disabled, the displayState idle branch, RegisterValue.disabled,
    // and the native + component-host :disabled binds (SSR + client). On top,
    // gate() adds the slot marker, the submission-triggered cleared latch, the
    // nav-lock / freeze derived sets, and the reactive corrector in
    // use-wizard.ts. This whole entry absorbs both. Measured at 62.49 KB.
    //
    // Raised 63 -> 64 KB on the interact branch (#544). `form.interact(path?)`
    // adds `interactAtPath` (the ladder-writing leaf walk over `originals`)
    // plus its `__DEV__` unresolved-path warn in create-form-store, the
    // `interact` wrapper in build-form-api, and the widened earned-success
    // term (`dirty || interacted`) in display-state. All of it lives in the
    // always-on useForm closure, so this tripwire moves in lockstep -- a
    // legitimate feature addition, not a tree-shake leak (baseline measured at
    // 62.89 KB on the parent commit, 63.02 KB here). As with the #464 note
    // above, the dev warn folds out of a consumer's production build; this
    // tripwire defines no `process.env.NODE_ENV`, so it measures the raw dist.
    // Measured at 63.02 KB.
    //
    // Tightened 64 → 58 KB on the size-teardown P1a dual-dist branch: the
    // shipped prod flavor is pre-stripped of `__DEV__` code at package
    // build, so the raw-dist measurement drops by the dev mass this
    // tripwire previously carried. Measured at 56.42 KB.    //
    // Tightened 58 -> 57.5 KB on the size-teardown P2 directive un-weld:
    // the app-level `app.directive('register', ...)` weld left
    // createAttaform, the store's DOM slice moved behind the lazily-armed
    // dom-binding module, and array-bookkeeping dropped its unused
    // elements dep. Whole-entry bundles keep the directive (the barrel
    // still exports it); the big win shows in the treeshaken tripwires
    // below. Measured at 56.49 KB.
    limit: '57.5 KB',
    gzip: true,
    // `zod` is a peer dep, external in the measurement exactly as for
    // dist/zod.mjs — this entry dispatches into it now that it's the barrel.
    ignore: ['zod'],
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
    //
    // Raised 66 → 67 KB on the zod-version-skew hardening branch (#383):
    // the v3 adapter's new rebuild-schema.ts reconstructs slim / stripped
    // nodes from the consumer's own node (prototype-preserving, zero
    // ambient `z.*` construction) so a hoisted second zod major cannot
    // poison the rebuild. The unified entry bundles the v3 adapter, so it
    // absorbs the module (rebuildWithDef + the per-kind wrappers + the DU
    // optionsMap remap, which reuses zod's own discriminator extraction
    // rather than re-deriving it). zod-v3.mjs holds at 62 KB (61.53).
    // Measured at 66.23 KB.
    //
    // Raised 67 → 68 KB tracking index.mjs's form.onChange bump (#395):
    // the unified entry bundles the shared core chunk, so it absorbs the
    // onChange seam (on-change.ts registry + change context, create-form-
    // store dispatch + { silent } opt-out, form.onChange / useForm({
    // onChange }) surface). Measured at 67.44 KB.
    //
    // Lowered 68 → 66 KB on the multi-tab-sync removal branch
    // (chore/rip-multitab): the unified entry's shared core chunk drops
    // multi-tab-sync.ts plus the crossTab / noSyncPaths remnants.
    // Measured at 65.48 KB.
    //
    // Lowered 66 → 60 KB on the persist removal branch (chore/rip-persist):
    // the shared core chunk drops the persistence/ engine + sensitive-names +
    // insecure-context-warn. Measured at 58.72 KB.
    //
    // Lowered 60 → 58 KB on the form.onChange removal branch
    // (chore/rip-onchange): the unified entry's shared core chunk drops the
    // onChange seam (on-change.ts + dispatch + the silent thread). Measured at
    // 57.64 KB.
    //
    // Raised 58 → 59 KB on the submit-success-semantics branch (#438): the
    // post-callback failure routing lands in the shared core chunk. process-
    // form's handleSubmit gains a userErrors-non-empty check after onSubmit
    // (focus + onError + early return so a setErrors-and-return callback no
    // longer flips submitted), mirrored in use-wizard (collectCallbackErrors +
    // focusFirstWizardError, gating done / step-advance on a clean callback).
    // Measured at 58.08 KB.
    //
    // Raised 59 → 60 KB tracking index.mjs's v-register third-party-component
    // bump (same shared core chunk: directive component-host branch +
    // registerValue strip + RegisterValue host delegates + markHostConnected +
    // the directly-bound-container field-state fold). The unified entry bundles
    // both adapters, so it absorbs the full delta. Measured at 59.31 KB.
    //
    // Raised 60 -> 61 KB tracking the #464 redundant-binding guard's eager
    // dev-warn in the shared core. Measured at 59.97 KB.
    //
    // Raised 61 → 62 KB on the schema-entry re-partition: core (createAttaform,
    // serialize, directive, paths, devtools, display) moved into
    // _shared-exports, so this entry now re-exports it as named exports too —
    // additive, ~1 KB to the whole-entry surface. Real consumers tree-shake it
    // (the `{ useForm }` / `{ injectForm }` / `{ useRegister }` tripwires below
    // held). Measured at 60.97 KB.
    //
    // Raised 62 → 63 KB tracking index.mjs's gating bump (feat/form-disabled,
    // #523): the same useForm({ disabled }) data freeze in the shared eager
    // core plus gate() in use-wizard.ts. Byte-for-byte identical to index.mjs.
    // Measured at 62.49 KB.
    //
    // Raised 63 -> 64 KB tracking index.mjs's interact bump (#544):
    // `form.interact(path?)` plus the widened earned-success term. Byte-for-
    // byte identical to index.mjs; see that entry's note. Measured at 63.02 KB.
    //
    // Tightened 64 → 58 KB on the size-teardown P1a dual-dist branch: the
    // shipped prod flavor is pre-stripped of `__DEV__` code at package
    // build, so the raw-dist measurement drops by the dev mass this
    // tripwire previously carried. Measured at 56.42 KB.    //
    // Tightened 58 -> 57.5 KB on the size-teardown P2 directive un-weld:
    // the app-level `app.directive('register', ...)` weld left
    // createAttaform, the store's DOM slice moved behind the lazily-armed
    // dom-binding module, and array-bookkeeping dropped its unused
    // elements dep. Whole-entry bundles keep the directive (the barrel
    // still exports it); the big win shows in the treeshaken tripwires
    // below. Measured at 56.49 KB.
    limit: '57.5 KB',
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
    //
    // Raised 60 → 61 KB tracking index.mjs's P3 render-isolation bust
    // (perf/runtime-analysis): same shared core chunk — getFormMetaBase's eager
    // rootBase spread became per-field lazy getters, eliminating the
    // O(field-count) form.fields component over-render. The 28 rollup getters
    // are slightly less compressible than the spread. Measured at 60.09 KB.
    //
    // Raised 61 → 62 KB tracking index.mjs's form.onChange bump (#395):
    // same shared core chunk (on-change.ts registry + change context,
    // create-form-store dispatch + { silent } opt-out, form.onChange /
    // useForm({ onChange }) surface). Measured at 61.33 KB.
    //
    // Lowered 62 → 60 KB on the multi-tab-sync removal branch
    // (chore/rip-multitab): same shared core chunk drops multi-tab-sync.ts
    // plus the crossTab / noSyncPaths remnants. Measured at 59.34 KB.
    //
    // Lowered 60 → 54 KB on the persist removal branch (chore/rip-persist):
    // drops the persistence/ engine + sensitive-names + insecure-context-warn.
    // Measured at 52.65 KB.
    //
    // Lowered 54 → 52 KB on the form.onChange removal branch
    // (chore/rip-onchange): same shared core chunk drops the onChange seam
    // (on-change.ts + dispatch + the silent thread). Measured at 51.56 KB.
    //
    // Raised 52 → 53 KB on the meta.dirty removal-detection branch (#420):
    // the shared core chunk gains the removal-dirty machinery in
    // create-form-store.ts — the pre-write identity-baseline realign for a
    // wholesale array shrink, plus the removedSubtrees set + isContainer /
    // subtreeHadRealBaseline / hasRemovedSubtreeUnder helpers and the reset()
    // clear for a container -> non-container drop — and field-state-api.ts
    // consults hasRemovedSubtreeUnder in the container dirty rollup. zod-v4.mjs,
    // the tightest full entry (zod-v3 still has ~0.5 KB headroom), had spent its
    // and crossed 52. Measured at 52.12 KB.
    //
    // Raised 53 → 54 KB tracking index.mjs's v-register third-party-component
    // bump (same shared core chunk: directive component-host branch +
    // registerValue strip + RegisterValue host delegates + markHostConnected +
    // the directly-bound-container field-state fold). Measured at 53.26 KB.
    //
    // Raised 54 -> 55 KB tracking the #464 redundant-binding guard's eager
    // dev-warn in the shared core. Measured at 53.92 KB.
    //
    // Raised 55 → 56 KB on the schema-entry re-partition: same additive core
    // (createAttaform / serialize / directive / paths / devtools / display)
    // now re-exported from every entry via _shared-exports. Whole-entry only;
    // the `{ useForm }` tripwire held. Measured at 54.89 KB.
    //
    // Raised 56 → 57 KB tracking index.mjs's gating bump (feat/form-disabled,
    // #523): the same disabled data freeze in the shared eager core plus the
    // wizard gate() surface. Measured at 56.37 KB.
    //
    // Tightened 57 → 52 KB on the size-teardown P1a dual-dist branch: the
    // shipped prod flavor is pre-stripped of `__DEV__` code at package
    // build, so the raw-dist measurement drops by the dev mass this
    // tripwire previously carried. Measured at 50.33 KB.    //
    // Tightened 52 -> 51.5 KB on the size-teardown P2 directive un-weld:
    // the app-level `app.directive('register', ...)` weld left
    // createAttaform, the store's DOM slice moved behind the lazily-armed
    // dom-binding module, and array-bookkeeping dropped its unused
    // elements dep. Whole-entry bundles keep the directive (the barrel
    // still exports it); the big win shows in the treeshaken tripwires
    // below. Measured at 50.42 KB.
    limit: '51.5 KB',
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
    //
    // Raised 62 → 63 KB tracking index.mjs's form.onChange bump (#395):
    // same shared core chunk (on-change.ts registry + change context,
    // create-form-store dispatch + { silent } opt-out, form.onChange /
    // useForm({ onChange }) surface). zod-v3.mjs, the tightest adapter
    // bundle, lands at 62.80 KB — keep an eye on it; a further core
    // addition will bind here first.
    //
    // Raised 63 → 64 KB on the array-write-path perf branch (#399): the
    // array-op fast path adds freshElementIndices plus the scoped slim-gate /
    // mergeStructural / authored-walk branches and an authoredPaths migration to
    // the shared core. zod-v3.mjs lands at 62.96; this restores ~1 KB of headroom
    // (the 63 cap was the predicted bind point and left ~40 bytes, within gzip
    // measurement jitter and apt to flake the gate). Measured at 62.96 KB.
    //
    // Lowered 64 → 62 KB on the multi-tab-sync removal branch
    // (chore/rip-multitab): same shared core chunk drops multi-tab-sync.ts
    // plus the crossTab / noSyncPaths remnants. zod-v3.mjs measured at
    // 60.81 KB.
    //
    // Lowered 62 → 56 KB on the persist removal branch (chore/rip-persist):
    // drops the persistence/ engine + sensitive-names + insecure-context-warn.
    // Measured at 54.03 KB.
    //
    // Lowered 56 → 54 KB on the form.onChange removal branch
    // (chore/rip-onchange): same shared core chunk drops the onChange seam.
    // zod-v3.mjs, the tightest adapter bundle, measured at 52.93 KB.
    //
    // Raised 54 → 55 KB tracking index.mjs's v-register third-party-component
    // bump (same shared core chunk: directive component-host branch +
    // registerValue strip + RegisterValue host delegates + markHostConnected +
    // the directly-bound-container field-state fold). zod-v3.mjs, the tightest
    // adapter bundle, crossed 54. Measured at 54.62 KB.
    //
    // Raised 55 → 56 KB on the wizard nullish-steps branch (#467):
    // use-wizard.ts gains the forward-continuity watch that re-points
    // activeKey when the active step drops out of the compiled list, plus
    // the null / undefined slot guards in resolveSlot / resolveSlotResult.
    // Ships in the shared core reached by every wizard-bearing entry;
    // zod-v3.mjs, the tightest adapter bundle, crossed 55 first (the other
    // full entries hold 0.25-0.33 KB headroom). Measured at 55.04 KB.
    //
    // Raised 56 → 57 KB on the schema-entry re-partition: same additive core
    // now re-exported from every entry via _shared-exports. Whole-entry only;
    // the `{ useForm }` tripwire held. Measured at 56.24 KB.
    //
    // Raised 57 → 58 KB tracking index.mjs's gating bump (feat/form-disabled,
    // #523): same shared eager core (useForm({ disabled })) plus gate().
    // zod-v3.mjs, the tightest full adapter entry, crossed by 0.39 KB.
    // Measured at 57.74 KB.
    //
    // Raised 58 → 59 KB on the no-latch-host focus branch (#538): the shared
    // core chunk gains the focus-first-error anchor for no-latch component
    // hosts. create-form-store adds the hostTargets map, resolveHostFocusTarget,
    // and the host-root weave into getFirstErrorElement's DOM-order walk, plus
    // the markHostConnected host-el thread. zod-v3.mjs, the tightest adapter
    // bundle, crossed 58 first (index / zod hold ~0.1 KB, zod-v4 ~0.2 KB).
    // Measured at 58.17 KB.
    //
    // Tightened 59 → 53 KB on the size-teardown P1a dual-dist branch: the
    // shipped prod flavor is pre-stripped of `__DEV__` code at package
    // build, so the raw-dist measurement drops by the dev mass this
    // tripwire previously carried. Measured at 51.59 KB.    //
    // Tightened 53 -> 52.5 KB on the size-teardown P2 directive un-weld:
    // the app-level `app.directive('register', ...)` weld left
    // createAttaform, the store's DOM slice moved behind the lazily-armed
    // dom-binding module, and array-bookkeeping dropped its unused
    // elements dep. Whole-entry bundles keep the directive (the barrel
    // still exports it); the big win shows in the treeshaken tripwires
    // below. Measured at 51.66 KB.
    limit: '52.5 KB',
    gzip: true,
    ignore: ['zod'],
    modifyEsbuildConfig: asEsm,
  },
  {
    path: 'dist/abstract.mjs',
    // The schema-agnostic escape hatch (attaform/abstract): useAbstractForm
    // + the shared core, with NO Zod adapter. Structurally what
    // dist/index.mjs was before the barrel flip — the abstract form used to
    // be the barrel's default export. Lighter than the Zod entries because
    // it ships neither adapter: no v3/v4 dispatch, no fingerprint / walker /
    // slim-primitive machinery. Measured at 45.33 KB.
    //
    // Raised 46 → 47 KB on the gating branch (feat/form-disabled, #523): the
    // disabled data freeze in the shared core (threaded through useAbstractForm)
    // plus gate(). No Zod adapter here, but the core and wizard surface both
    // grow. Measured at 46.85 KB.
    //
    // Raised 47 → 48 KB on the no-latch-host focus branch (#538): the same
    // shared-core focus anchor (hostTargets, resolveHostFocusTarget, the
    // getFirstErrorElement weave) reaches this entry through useAbstractForm.
    // Measured at 47.23 KB.
    //
    // Tightened 48 → 42 KB on the size-teardown P1a dual-dist branch: the
    // shipped prod flavor is pre-stripped of `__DEV__` code at package
    // build, so the raw-dist measurement drops by the dev mass this
    // tripwire previously carried. Measured at 40.68 KB.    //
    // Tightened 42 -> 41.5 KB on the size-teardown P2 directive un-weld:
    // the app-level `app.directive('register', ...)` weld left
    // createAttaform, the store's DOM slice moved behind the lazily-armed
    // dom-binding module, and array-bookkeeping dropped its unused
    // elements dep. Whole-entry bundles keep the directive (the barrel
    // still exports it); the big win shows in the treeshaken tripwires
    // below. Measured at 40.78 KB.
    limit: '41.5 KB',
    gzip: true,
    modifyEsbuildConfig: asEsm,
  },
  {
    path: 'dist/directive.mjs',
    // The v-register delivery entry (size-teardown P2 un-weld): the
    // directive + its satellites (aria / file / listeners / lifecycle /
    // value-sync), register-protocol, assigner-pipeline, vue-shared-shim,
    // dom-binding, and installVRegister. This is the weight only apps
    // that render v-register pay — delivered by the Vite/Nuxt rewrite's
    // injected import, or by the installVRegister one-liner. The cap
    // guards against core modules leaking INTO the cluster's graph (a
    // jump here without a matching directive-side feature means the
    // entry started dragging kernel weight along). Measured at 7.17 KB.
    limit: '8 KB',
    gzip: true,
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
    //
    // Held at 14 KB through the auto-import work: the module now registers
    // the full auto-import manifest (src/runtime/auto-imports) behind the
    // `autoImports` toggle instead of a single useForm entry, but the
    // manifest is a tiny static array and the persist / onchange /
    // multi-tab removals since #221 freed ~5 KB of headroom. Measured at
    // 8.39 KB.
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
    //
    // Held at 13 KB when attaform/vite began re-exporting the auto-import
    // manifest + imports-map (src/runtime/auto-imports) for the
    // unplugin-auto-import preset — a small static data re-export, no
    // runtime weight. Measured at 7.89 KB.
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

  // ----------------------------------------------------------------
  // Tree-shaking tripwires (single named import, NOT the whole entry).
  //
  // The entries above cap each subpath's FULL inlined surface. They do
  // NOT prove that a consumer importing only one symbol drops the rest
  // — `import:` does. size-limit's esbuild analyzer bundles ONLY the
  // named import and tree-shakes the entry around it, so the gzipped
  // number here is the real cost a consumer pays for that one symbol
  // (Vue is external as for every entry; `zod` is ignored explicitly).
  //
  // The load-bearing case: `useWizard` shares its physical chunk with
  // `useAbstractForm` (the engine behind every `useForm`), so dropping
  // it relies on the consumer bundler's intra-chunk dead-code
  // elimination, not a whole-module drop. These caps are the standing
  // proof that elimination still works: a regression that makes
  // `useForm` transitively reach `use-wizard.ts` (e.g. a shared helper
  // migrating into it) pushes `{ useForm }` up by ~5 KB gzip and trips
  // the cap — the kind of leak no full-entry cap above can see.
  //
  // Caps are snug against the measured size. They track the same shared
  // core as the full entries, so they bump in lockstep on feature
  // branches that legitimately grow `useForm`'s closure — same cadence
  // as `index.mjs` / `zod.mjs` above. A jump LARGER than the
  // accompanying full-entry bump is the leak signal.
  {
    name: 'zod: { useForm } only (no wizard/register/injectForm)',
    path: 'dist/zod.mjs',
    import: '{ useForm }',
    // Unified entry, so `{ useForm }` pulls BOTH adapters (runtime
    // dispatch) but NOT the wizard / injectForm / useRegister / unset /
    // lazy surface that the full 59 KB cap above includes. The ~6 KB
    // gap below that cap is the tree-shaken optional surface. Measured
    // at 52.15 KB; ~0.85 KB headroom.
    //
    // Raised 53 → 54 KB tracking the v-register third-party-component branch
    // (same shared eager core as the full entries above: directive
    // component-host branch + registerValue strip + host delegates +
    // markHostConnected + the directly-bound-container field-state fold).
    // Measured at 53.45 KB.
    //
    // Raised 54 → 55 KB for submit-throw surfacing (process-form's catch-block
    // inject piping a thrown onSubmit into the user-error layer). Measured at
    // 54.04 KB.
    //
    // Tightened 55 → 52 KB on the size-teardown P1a dual-dist branch: the
    // shipped prod flavor is pre-stripped of `__DEV__` code at package
    // build, so the raw-dist measurement drops by the dev mass this
    // tripwire previously carried. Measured at 50.21 KB.
    //
    // Tightened 52 -> 45 KB on the size-teardown P2 directive un-weld:
    // createAttaform / lazy install register no directive, so this
    // treeshaken graph drops the whole directive cluster (directive +
    // satellites, register-protocol, assigner-pipeline, vue-shared-shim)
    // and the store's DOM slice (now the lazily-armed dom-binding).
    // Delivery is the Vite/Nuxt compile-time rewrite or installVRegister.
    // Measured at 43.82 KB.
    limit: '45 KB',
    gzip: true,
    ignore: ['zod'],
    modifyEsbuildConfig: asEsm,
  },
  {
    name: 'zod-v4: { useForm } only',
    path: 'dist/zod-v4.mjs',
    import: '{ useForm }',
    // Single-adapter v4 entry: one adapter, no wizard surface. Measured
    // at 45.99 KB; ~1 KB headroom.
    //
    // Raised 47 → 48 KB tracking the v-register third-party-component branch
    // (same shared eager core: directive component-host branch + registerValue
    // strip + host delegates + markHostConnected + the directly-bound-container
    // field-state fold). Measured at 47.27 KB.
    //
    // Raised 48 → 49 KB tracking the gating branch (feat/form-disabled, #523).
    // useForm({ disabled }) adds the data freeze to the always-on useForm
    // closure (effectiveDisabled + write gate + field.disabled + displayState
    // idle + the :disabled binds). gate() tree-shakes out of a { useForm }-only
    // import, so this grew +1.18 KB in lockstep with the full zod-v4.mjs entry's
    // core growth (+1.13 KB), legitimate feature weight and not a wizard leak.
    // Measured at 48.47 KB.
    //
    // Tightened 49 → 46 KB on the size-teardown P1a dual-dist branch: the
    // shipped prod flavor is pre-stripped of `__DEV__` code at package
    // build, so the raw-dist measurement drops by the dev mass this
    // tripwire previously carried. Measured at 44.11 KB.
    //
    // Tightened 46 -> 39 KB on the size-teardown P2 directive un-weld:
    // createAttaform / lazy install register no directive, so this
    // treeshaken graph drops the whole directive cluster (directive +
    // satellites, register-protocol, assigner-pipeline, vue-shared-shim)
    // and the store's DOM slice (now the lazily-armed dom-binding).
    // Delivery is the Vite/Nuxt compile-time rewrite or installVRegister.
    // Measured at 37.71 KB.
    limit: '39 KB',
    gzip: true,
    ignore: ['zod'],
    modifyEsbuildConfig: asEsm,
  },
  {
    name: 'zod-v3: { useForm } only',
    path: 'dist/zod-v3.mjs',
    import: '{ useForm }',
    // Single-adapter v3 entry. Measured at 47.48 KB; ~0.5 KB headroom.
    //
    // Raised 48 -> 49 KB tracking the v-register third-party-component
    // branch (Phase 2 of plan zany-finding-melody): the directive gains its
    // component-host element-discovery branch (activateComponentHost: the
    // Case-A hasRegisteredDescendant discriminator, the exactly-one
    // querySelectorAll latch via registerElement, the componentHostLatch
    // teardown), create-form-store gains markHostConnected (client connected
    // for a no-latch host), and the RegisterValue gains markHostConnected /
    // hasRegisteredDescendant delegates (plus Phase 1's setValueFromHost).
    // All eager (the directive ships in the always-on useForm closure), so
    // the tripwire bumps in lockstep -- a legitimate ~0.35 KB feature growth,
    // not a tree-shake leak. zod-v3.mjs is the tightest { useForm } tripwire,
    // so it bound first; v4's still has ~0.5 KB headroom (46.46 KB) and the
    // full entries are under cap. Measured at 48.01 KB.
    //
    // Raised 49 -> 50 KB tracking the #464 redundant-binding guard: the
    // directive's `created` hook gains `warnRedundantStateBinding` (the
    // dev-only runtime warn that flags a redundant `:value` / `:checked` /
    // `v-model` beside v-register), its module-level dedupe Set, and the
    // `V_REGISTER_COMPILED_MODIFIER` read. All `__DEV__`-gated, so a
    // consumer's production build folds it out; this tripwire defines no
    // `process.env.NODE_ENV`, so it measures the raw dist and moves in
    // lockstep like the branch above -- a legitimate feature addition, not a
    // tree-shake leak. zod-v3.mjs stays the tightest { useForm } tripwire, so
    // it bound first. Measured at 49.03 KB.
    //
    // Raised 50 -> 51 KB tracking the #528 gate seed-clear fix: create-form-store
    // gains the lazy `defaultsValid()` seed verdict (a full parse of the default
    // snapshot frozen at construction, refreshed on reset), so a `gate()`
    // pre-clears only from a consumer-asserted valid seed and never from a live
    // edit or the schema's own structural fills. The method itself lives in the
    // always-on useForm closure (only its parse is deferred to gate use), so this
    // tripwire moves in lockstep -- a legitimate correctness-fix addition, not a
    // tree-shake leak. zod-v3.mjs stays the tightest { useForm } tripwire.
    // Measured at 50.05 KB.
    //
    // Tightened 51 → 47 KB on the size-teardown P1a dual-dist branch: the
    // shipped prod flavor is pre-stripped of `__DEV__` code at package
    // build, so the raw-dist measurement drops by the dev mass this
    // tripwire previously carried. Measured at 45.47 KB.
    //
    // Tightened 47 -> 40.5 KB on the size-teardown P2 directive un-weld:
    // createAttaform / lazy install register no directive, so this
    // treeshaken graph drops the whole directive cluster (directive +
    // satellites, register-protocol, assigner-pipeline, vue-shared-shim)
    // and the store's DOM slice (now the lazily-armed dom-binding).
    // Delivery is the Vite/Nuxt compile-time rewrite or installVRegister.
    // Measured at 39.05 KB.
    limit: '40.5 KB',
    gzip: true,
    ignore: ['zod'],
    modifyEsbuildConfig: asEsm,
  },
  {
    name: 'zod: { injectForm } only',
    path: 'dist/zod.mjs',
    import: '{ injectForm }',
    // Reaching an ancestor form's surface (proxy + FieldState read
    // machinery) without the schema / validation / store-creation that
    // `useForm` carries, and crucially without the wizard surface.
    // Measured at 22.44 KB; ~0.56 KB headroom.
    //
    // Raised 23 → 24 KB tracking the v-register third-party-component branch:
    // the directive's component-host branch + the registerValue strip ship in
    // the shared core that injectForm reaches too. Measured at 23.51 KB.
    //
    // Raised 24 -> 25 KB tracking the #464 redundant-binding guard: the
    // eager dev-warn ships in the shared core injectForm reaches too.
    // Measured at 23.98 KB.
    //
    // Tightened 25 → 23 KB on the size-teardown P1a dual-dist branch: the
    // shipped prod flavor is pre-stripped of `__DEV__` code at package
    // build, so the raw-dist measurement drops by the dev mass this
    // tripwire previously carried. Measured at 20.91 KB.
    //
    // Tightened 23 -> 16.5 KB on the size-teardown P2 directive un-weld:
    // createAttaform / lazy install register no directive, so this
    // treeshaken graph drops the whole directive cluster (directive +
    // satellites, register-protocol, assigner-pipeline, vue-shared-shim)
    // and the store's DOM slice (now the lazily-armed dom-binding).
    // Delivery is the Vite/Nuxt compile-time rewrite or installVRegister.
    // Measured at 15.14 KB.
    limit: '16.5 KB',
    gzip: true,
    ignore: ['zod'],
    modifyEsbuildConfig: asEsm,
  },
  {
    name: 'zod: { useRegister } only',
    path: 'dist/zod.mjs',
    import: '{ useRegister }',
    // The leanest field-rebind helper. The tightest tripwire: anything
    // heavy leaking into it (form store, adapters, wizard) shows up
    // immediately against this small baseline. Measured at 9.65 KB;
    // ~0.35 KB headroom.
    //
    // Raised 10 → 11 KB tracking the v-register third-party-component branch:
    // the directive's component-host branch + the registerValue strip land in
    // the shared core that useRegister pulls in. The tightest tripwire, so it
    // shows the feature delta most starkly. Measured at 10.26 KB.
    //
    // Tightened 11 → 9.5 KB on the size-teardown P1a dual-dist branch: the
    // shipped prod flavor is pre-stripped of `__DEV__` code at package
    // build, so the raw-dist measurement drops by the dev mass this
    // tripwire previously carried. Measured at 7.85 KB.
    //
    // Held at 9.5 KB through the size-teardown P2 directive un-weld:
    // useRegister's graph swapped the app-level weld it reached through
    // ensureAttaformInstalled for the dom-binding module it now arms
    // directly (element registry + focus listeners + focus walk).
    // Measured at 9.09 KB.
    limit: '9.5 KB',
    gzip: true,
    ignore: ['zod'],
    modifyEsbuildConfig: asEsm,
  },
  {
    name: 'attaform: { useForm } only (barrel == zod)',
    path: 'dist/index.mjs',
    import: '{ useForm }',
    // The barrel's dispatching useForm. Byte-identical to the
    // `zod: { useForm }` tripwire above — index.mjs ≡ zod.mjs after the
    // re-partition — so this cap is the standing proof the barrel never
    // diverges from the explicit Zod entry. Measured at 54.05 KB.
    //
    // Tightened 55 → 52 KB on the size-teardown P1a dual-dist branch: the
    // shipped prod flavor is pre-stripped of `__DEV__` code at package
    // build, so the raw-dist measurement drops by the dev mass this
    // tripwire previously carried. Measured at 50.21 KB.
    //
    // Tightened 52 -> 45 KB on the size-teardown P2 directive un-weld:
    // createAttaform / lazy install register no directive, so this
    // treeshaken graph drops the whole directive cluster (directive +
    // satellites, register-protocol, assigner-pipeline, vue-shared-shim)
    // and the store's DOM slice (now the lazily-armed dom-binding).
    // Delivery is the Vite/Nuxt compile-time rewrite or installVRegister.
    // Measured at 43.82 KB.
    limit: '45 KB',
    gzip: true,
    ignore: ['zod'],
    modifyEsbuildConfig: asEsm,
  },
  {
    name: 'attaform: { createAttaform } only',
    path: 'dist/index.mjs',
    import: '{ createAttaform }',
    // The leanest core import: the plugin + registry, none of the form /
    // adapter / wizard surface. The proof that pulling one core symbol
    // from the barrel tree-shakes away the dispatcher AND both Zod
    // adapters — the payoff of moving core into _shared-exports. A
    // regression that ropes the adapters into createAttaform's graph
    // trips here. Measured at 8.98 KB.
    //
    // Tightened 10 → 8 KB on the size-teardown P1a dual-dist branch: the
    // shipped prod flavor is pre-stripped of `__DEV__` code at package
    // build, so the raw-dist measurement drops by the dev mass this
    // tripwire previously carried. Measured at 6.66 KB.
    //
    // Tightened 8 -> 1.5 KB on the size-teardown P2 directive un-weld:
    // createAttaform WAS the weld. With `app.directive('register', ...)`
    // gone from the install path, this import is now just the plugin +
    // registry it always claimed to be — the leanest core import for
    // real this time. Measured at 0.79 KB.
    limit: '1.5 KB',
    gzip: true,
    ignore: ['zod'],
    modifyEsbuildConfig: asEsm,
  },
  {
    name: 'abstract: { useAbstractForm } only',
    path: 'dist/abstract.mjs',
    import: '{ useAbstractForm }',
    // The abstract form with neither Zod adapter — ~15 KB leaner than the
    // Zod dispatcher's `{ useForm }` (no v3/v4 dispatch, fingerprint,
    // walker, or slim-primitive machinery). A regression that pulls a Zod
    // adapter into the abstract path would balloon this. Measured at
    // 38.56 KB.
    //
    // Tightened 40 → 36 KB on the size-teardown P1a dual-dist branch: the
    // shipped prod flavor is pre-stripped of `__DEV__` code at package
    // build, so the raw-dist measurement drops by the dev mass this
    // tripwire previously carried. Measured at 34.69 KB.
    //
    // Tightened 36 -> 29.5 KB on the size-teardown P2 directive un-weld:
    // createAttaform / lazy install register no directive, so this
    // treeshaken graph drops the whole directive cluster (directive +
    // satellites, register-protocol, assigner-pipeline, vue-shared-shim)
    // and the store's DOM slice (now the lazily-armed dom-binding).
    // Delivery is the Vite/Nuxt compile-time rewrite or installVRegister.
    // Measured at 28.36 KB.
    limit: '29.5 KB',
    gzip: true,
    modifyEsbuildConfig: asEsm,
  },
]
