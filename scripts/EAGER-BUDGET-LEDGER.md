# Eager-budget ledger

Every move of `BUDGET_GZ` in `scripts/check-eager-size.mjs`, oldest first,
with the measurement and the reason behind it. It lives here rather than
above the constant because it is a record that grows with the project,
and a gate script should not be three quarters changelog.

The rules it records, which have not changed:

- The ratchet is the only byte authority. Ledger arithmetic is not.
- Tighten at every phase boundary, to the new measurement plus about
  0.3 kB of minifier-drift headroom.
- Never loosen without a recorded reason, and price the loosening
  against what it bought.

## Where the budget started

Committed eager budget (gz bytes) for a minimal `useForm` (zod-v4).
Baseline measured at 46.28 kB gz when this gate landed, with the
dev-flag DCE win (core/dev.ts) folded in under the production define.
D1 then lazy-loads multi-tab sync onto the async path (45.61 kB gz),
D2 lazy-loads persistence's wiring + payload machinery (the
onFormChange writer, envelope read/build, debounce, pluck / strip /
filter) onto the async path (44.60 kB gz), and D3 lazy-loads the
schema fingerprint walker + its canonicalStringify helper (only the
opt-in persistence key path plus a dev-only mismatch warning consume
them), landing the eager set at 44.38 kB gz; the
budget is tightened here to lock that in. The single-adapter delta is
modest because the async deferral machinery offsets most of the
fingerprint bytes, but the unified `attaform/zod` entry (both adapters'
walkers leave eager against the same one-time machinery) drops ~1.0 kB.
Block F then moves the dev-only shared-key collision warnings into their
own dynamic-imported module, so a prod build orphans that chunk instead of
shipping it as dead code (esbuild keeps a top-level function called only
from a dead `__DEV__` branch — tree-shaking runs before the define-fold),
landing the eager set at 43.91 kB gz.

## Recorded Loosening: anti-flash display timing

RECORDED LOOSENING (anti-flash display timing): the timed `getDisplayState`
reducer + the per-form display engine (clock / single timer / machine map)
sit on the eager path because `field.displayState` is read synchronously on
every field access — there is no async seam to defer them behind. That is a
deliberate capability-for-bytes trade (a polished, tunable anti-flash
spinner baked into every form, otherwise re-built ad hoc by each consumer),
landing the eager set at 44.51 kB gz. The container / form.meta rollup (#346)
then consumed that headroom, landing the eager set at exactly 45.00 kB gz.

## Recorded Loosening: form.meta pending during submit

RECORDED LOOSENING (form.meta pending during submit): form.meta reads as
pending while a submit runs its own validation pass, so one
`form.meta.showPending` can drive a form-level "validating" affordance. The
projection reads `state.submitting` + `state.activeValidations` at the root,
landing the eager set at 45.01 kB gz. Budget raised to restore ~0.5 kB
headroom for minifier-version drift. The lazy-loading work tightens this as
optional features move to the async path; never loosen it without a recorded
reason in the commit.

## Recorded Loosening: async register transforms, #361

RECORDED LOOSENING (async register transforms, #361): the async-transform
feature (Stage 1 store primitive — beginTransform / endTransform /
settleTransforms + activeTransforms + transformErrors; Stage 2 vRegisterFile
unification) sits on the always-on useForm path. register() runs the
sync-fast transform pipeline on every write, handleSubmit drains in-flight
transforms before its authoritative pass, and form.settleTransforms is a
public surface — none has an async seam. Deferring only the await/commit
orchestrator was evaluated and declined: it reclaims a fraction of the cost
and would push the synchronous `transforming` flip (beginTransform runs
inside the assigner) behind a dynamic import, lagging the busy state by a
microtask. Keeping it eager is the deliberate trade. Measured at 46.67 kB gz;
budget raised to restore ~0.5 kB headroom for minifier-version drift.

## Recorded Loosening: targeted in-place apply, T2 keystroke bust

RECORDED LOOSENING (targeted in-place apply, T2 keystroke bust): the
single-`setValue` fast path (tryInPlaceLeafWrite + applyTargetedWrite)
mutates the target leaf's slot in place when it already exists, preserving
ancestor container identity and taking the keystroke from O(field-count) /
O(array-length) to O(depth) — 100-230x at scale on the matrix bench. It
sits on the always-on write funnel (every setValue), so it cannot defer
behind an async seam. Measured at 47.35 kB gz; budget raised to restore
~0.5 kB headroom for minifier-version drift. The ~9 kB of known
eager-optional features (bundle-size analysis) remain the place to reclaim
this; never loosen without a recorded reason.

## Note: multi-tab-sync removal, chore/rip-multitab

NOTE (multi-tab-sync removal, chore/rip-multitab): multi-tab sync has been
async since D1, so deleting it barely moves the eager set — only the
core-anchored remnants (WriteMeta.crossTab thread, state.noSyncPaths
ref-counted opt-out) come off here, landing eager at 47.61 kB gz, held
within the budget with no change. The real reclaim is the ~2 kB the inlined
async chunk freed from the full bundle, locked in via the .size-limit.js
cap ratchets (54→52 / 68→66 / 62→60 / 64→62 KB).

## Note: persist removal, chore/rip-persist

NOTE (persist removal, chore/rip-persist): persist was lazy since D2, but its
core-anchored remnants were heavier than multi-tab's — the persistOptIns
registry, the isSensitivePath resolution, the sensitive-names static import,
the insecure-context-warn helper, and the WriteMeta.persist thread all come
off the eager path, landing eager at 43.48 kB gz (down ~4.1 kB). Budget
ratcheted 49_000 → 46_000 to lock it in; the full-bundle reclaim (~6 kB per
entry) is locked via the .size-limit.js caps (52→46 / 66→60 / 60→54 / 62→56).

## Note: form.onChange removal, chore/rip-onchange

NOTE (form.onChange removal, chore/rip-onchange): the onChange seam shipped
eager (its dispatch ran on the write funnel, with no async seam to defer it
behind), so removing on-change.ts + the registry + the WriteMeta.silent
thread drops the eager set ~1.0 kB, landing it at 42.47 kB gz. Budget
ratcheted 46_000 → 44_000 to lock it in; the full-bundle reclaim (~2 kB per
entry) is locked via the .size-limit.js caps (46→44 / 60→58 / 54→52 / 56→54).

## RECORDED LOOSENING (esbuild 0.28.1 minifier drift + v-register third-p

RECORDED LOOSENING (esbuild 0.28.1 minifier drift + v-register third-party
binding): the #456 dev-deps bump moved esbuild to 0.28.1 (lockfile-pinned via
vite@8.0.16; this script resolves it as the newest installed copy), whose minifier
emits a larger output. Core features also landed since the onChange removal without
a ratchet (error model #423, submit semantics #438). Together these push the
clean-main eager set to ~44_011 bytes, ~11 bytes over the 44_000 budget independent
of any feature branch. The third-party-component v-model desugar then adds a small
setValueFromHost on the eager RegisterValue (a v-model host emits its typed value
through onUpdate:modelValue with no DOM input listener to flip the sticky interacted
bit, so the host write bundles the value write with markInteracted), landing eager
at ~44_020 bytes. Budget raised 44_000 → 44_500 to restore ~0.5 kB headroom for
minifier-version drift; never loosen it without a recorded reason in the commit.

## Recorded Loosening: v-register third-party Phase 5, feat/v-register-third-party

RECORDED LOOSENING (v-register third-party Phase 5, feat/v-register-third-party):
the directive's no-latch host branch grows the rich FieldState for composite and
control-less third-party widgets. Item 1 (composite / no-control focus) adds an
rv.markFocused delegate plus a focusin / focusout pair on the widget root (with a
relatedTarget containment check so intra-widget tabbing is not a blur), since a
host with no single latchable control has no element-level focus listener. That
lands eager at ~44_523 bytes. Two more Phase 5 items landed on the same eager
directive path: async self-heal (a scoped MutationObserver that latches a control
rendered after mount) and the multi-root drop diagnostic (a dev-only warn in
setValueFromHost when a value update arrives but the directive never attached; the
non-v-model diagnostic was dropped as undetectable post-matrix). Budget raised
44_500 → 45_500 once for the whole phase rather than per item. Phase 5 is now
complete and lands eager at ~45_080 bytes, ~0.41 kB under this budget -- about the
conventional drift headroom, so the phase-wide estimate held and the budget stays
at 45_500. Never loosen further without a recorded reason.

## Recorded Loosening: submit-throw surfacing

Submit-throw surfacing: a thrown / rejected `onSubmit` callback is now piped
into the user-error layer as a `ValidationError` (alongside the raw
`submitError`), so it shows on `form.errors` / `meta.ownErrors` /
`firstOwnError`. The eager cost is process-form's catch-block inject path
(deriveSubmitErrors + isErrorInputLike + the per-path grouping write +
focus-first-error + a dev-only messageless-throw warn); it reuses the hoisted
`normalizeErrorInput`, so the net add is ~242 bytes gz, landing the eager set
at ~45_742 bytes. Budget raised 45_500 → 46_500 to restore ~0.5 kB headroom
for minifier drift.

## Ratchet: size-teardown P1a, dev/prod dual dist

RATCHET (size-teardown P1a, dev/prod dual dist): the measurement now applies
the package build's source-level `__DEV__` strip (see devFlagStripPlugin
above), so the ratchet equals shipped prod-flavor bytes. The strip removes
the dev mass the define-fold left behind (functions only called from dead
branches, dev prose consts, the dev-stack-trace module), and the three
previously unguarded v-register warn sites (checkbox missing-value pair in
directive.ts, non-RegisterValue hint in assigner-pipeline.ts) are now
`__DEV__`-gated so their prose strips too. Measured at 43,741 B gz
(down 2,736 from the 46,477 baseline). Budget tightened 46_500 → 44_250 to
lock the win, keeping ~0.5 kB headroom for minifier-version drift; never
loosen it without a recorded reason in the commit.

## Ratchet: size-teardown P2, directive un-weld

RATCHET (size-teardown P2, directive un-weld): createAttaform /
ensureAttaformInstalled no longer register the v-register directive, so
the whole directive cluster (directive + aria/file/listeners/lifecycle/
value-sync satellites, register-protocol, assigner-pipeline,
vue-shared-shim) leaves this scenario's eager graph — delivery is the
Vite/Nuxt compile-time rewrite or installVRegister, and the store's DOM
slice (element registry, focus listeners, first-error focus walk,
interactive-tags) moved behind the lazily-armed dom-binding module.
Measured at 37,210 B gz (down 6,531 from 43,741: 5,702 un-weld + 829 DOM
slice). Budget tightened 44_250 → 37_700; dev-dce S4 guards the module
set structurally so a re-weld fails even inside the byte headroom.

## Ratchet: size-teardown P3, history plugin + arrays engine

RATCHET (size-teardown P3, history plugin + arrays engine): the undo/redo
runtime moved behind `historyPlugin()` from the new attaform/history
entry, so history.ts leaves this scenario's eager graph entirely — the
core wires the module through the plugin's attach() seam, and the ring-
buffer rewrite killed diff-apply's applyPatchesForward/Inverse plus
path-walker's deleteAtPath (history was their only consumer). The five
array/variant modules (identity, state-migrate, bookkeeping, variant-
memory, field-arrays) consolidated into array-engine.ts around one
remapForOp / permuteList / shared-key-walk core, and the write funnel
decodes each structural op's remap exactly once. Measured at 35,776 B gz
(down 1,434 from 37,210: ~1,240 history un-weld + ~195 arrays engine).
Budget tightened 37_700 → 36_250; dev-dce S4 now also asserts history.ts
off the eager inputs.

## Ratchet: size-teardown P4, field-meta walk un-weld + probe delete

RATCHET (size-teardown P4, field-meta walk un-weld + probe delete): the
path-walking field-meta resolver (walk-field-meta.ts) rides the
registration surface now — `withMeta` / `fieldMeta.add` install it into
the shared store's builder slot, the adapters read the slot, and a
consumer that never registers metadata resolves labels through the
`.describe()` / humanize fallbacks without shipping the walk. And
`arrayShapeAtPath` became definitive (`number | null`, sign-off 6), so
path-walker's high-index probe loop died. Measured at 35,207 B gz (down
569 from 35,776). Budget tightened 36_250 → 35_650; dev-dce S4 now also
asserts walk-field-meta.ts off the eager inputs.

## P5 Ratchet: store kernel, 2026-08-23

P5 RATCHET (store kernel, 2026-08-23): the one phase that RAISED this
number, recorded honestly. The kernel rewrite (plain state record +
store-first-arg functions + method skins), the tagged error store
(semantics-preserving cell machinery net of the per-entry formKey
drops), and the DU capability flag cost more bytes than the phase's
deletions (double diff, du-stubs fold, one-clone construction) saved:
measured 35,768 B gz, +561 over P4. The audit's store-lazy credits did
not survive measurement — the activation-chunk split was implemented
and DECLINED (cross-chunk glue + per-chunk gzip loss exceeded the
moved bytes). The phase's value landed elsewhere: keystroke deep
+14/+26/+50%, array writes +8-12% (see
plans/size-teardown/reference/p5-bench-after.json), one construction
tree-copy dropped, per-entry formKey off the SSR wire, and the
characterization discipline. Budget 35_650 -> 36_200.

## P6 Ratchet: validation shell fold, 2026-08-23

P6 RATCHET (validation shell fold, 2026-08-23): one activeValidations
shell (withActiveValidation) across the reactive kickoff, the
imperative path, and handleSubmit; parse(path?, { commit? }) absorbed
validateAsync (sign-off 4); pathStartsWith / groupErrorsByKey /
submit-throw grouping deduped; display-engine introspection hooks
dev-gated. Measured 35,621 B gz (down 147 from 35,768) — under the
-250..-500 expectation band because gzip already compresses
near-identical shells to almost nothing: folding textual twins buys
little; only deleting structurally redundant logic moves this number.

## Ratchet: the ~430 B headroom convention

Budget tightened 36_200 -> 36_050 (the ~430 B headroom convention).

## P7 Ratchet: 2026-08-24

P7 RATCHET (2026-08-24): 34,530 -> 33,999 measured (-531). Sign-off 7
landed: the slim-schema rebuild (getSlimSchema + stripRefinements +
walkSlim) is DELETED on both majors in favor of the shared DU-aware
structural fix walk (core/walk-fix-structural.ts) that never parses
and never runs user refines/transforms at construction; introspect's
kindOf switch became an alias table + identity set and walkSchemaTree
descent went data-driven; the catchOnUseDefaultFalse knob died when
v3 aligned to v4's recurse-inner semantics. Exhaustive-case lint
tails cost +49 back; the core-walk genericization cost +98 on this
metric and bought -2,260 on the plugin-less barrel (41,080 ->
38,820). Sign-off 6's factory absorption was REFUSED on rep evidence
(+17 gz). Budget 34_950 -> 34_400 (~0.4 kB headroom).

## P8 Ratchet: surface program, 2026-08-24

P8 RATCHET (surface program, 2026-08-24): callable-tree.ts replaced the
seven-module proxy zoo (surface-proxy, errors-proxy, field-state-proxy,
values-proxy, callable-readonly-snapshot-proxy [now wizard-only],
plus the two helper modules staying as imports); fields leaf views and
call-form terminals unified onto one cached per-path view over the
shared field-state accessor; errors toJSON trees memoised in
per-container computeds; the two build-form-api meta getter forests
loop-generated over FIELD_STATE_KEYS with a once-per-form shared
FormMetaBase bag (rollup computed-memoised); pickDefined collapsed the
conditional-spread stacks. The exotic-name schema-authority
arbitration is dropped (sign-off 8); the root call/apply/bind invoke
shims are RESTORED after the playground finding (sucrase downlevels
the documented `surface(path)?.x` idiom into a `.call`-reading helper
— no-uncaught-exceptions outranks the size sign-off). Measured
34,530 B gz (down 1,091 from 35,621). Refused with measurement: the
leaf/container field-state builder fold (twin-tail-only, P6 gzip
discount), the activation-getter loop (+15 B), the useForm layer
collapse (type-weight only). Budget tightened 36_050 -> 34_950.

## P1b Ratchet: error codes + prose diet, 2026-08-24

P1b RATCHET (error codes + prose diet, 2026-08-24): 33,999 -> 33,124
measured (-875). Every prod-surviving prose diagnostic (14 sites)
now ships as `[attaform] AF## attaform.dev/e/af##` (+ the dynamic
detail where load-bearing) while the dev flavor keeps the full
prose via call-site `__DEV__` ternaries the dual-dist split folds
per flavor. No shared helper on purpose: 14 near-identical literals
gzip to almost nothing and each site stays greppable by its code.
The /e/af## reference pages ship in the same PR (docs/e/ ->
attaform.dev/e via the site's `errors` content collection), so the
URL in every prod message resolves from day one. Budget
34_400 -> 33_550 (~0.43 kB headroom).

## P10 Ratchet: sweep + lock, program close, 2026-08-24

P10 RATCHET (sweep + lock, program close, 2026-08-24): 33,128 ->
33,004 measured (-124). The June persist rip-out had orphaned the
store's whole drain spine (registerDrain / drainHooks / an
awaitPendingWrites that always resolved immediately) plus the
registry's drain-then-dispose eviction choreography and a
shutdown() that awaited nothing, with zero callers anywhere. Deleted;
eviction now disposes directly. Budget 33_550 -> 33_430
(~0.43 kB headroom).
values-snapshot (#567): 33,355 -> 33,469 measured (+114). `form.values()`
returns a detached snapshot instead of the live readonly proxy, memoised
through a computed so repeated calls stay at parity with the proxy return,
and released on every write so a cleared File is not pinned by the stale
copy. The eager cost is the memoising computed, the onFormChange release
subscription, and the guard that keeps a released box from ever being read;
all three sit in the shared core a minimal useForm pulls in. The budget had
~0.07 kB left before this, which is why 114 B tripped it. Budget
33_430 -> 33_900 (~0.42 kB headroom, back to the conventional band).
map/set entry paths (#614): 33,660 -> 34,400 measured (+740). A `z.map`
entry became a path on every surface, which the schema walker, the value
walker, the diff (so an entry carries its own `dirty` baseline), the
container proxies and the write gate all had to learn, and a `z.set`
member stopped being one, which took the reserved member segment and its
coercion lookup. All of it sits in the shared core a minimal useForm
pulls in; none of it is adapter-specific (the v3 issue-path rewrite is
not in this scenario, which measures zod-v4). The budget had ~0.23 kB
left before this. Budget 33_900 -> 34_850 (~0.44 kB headroom, the
conventional band).

## E0 Ratchet: efficiency program, 2026-09-15

E0 RATCHET (efficiency program, 2026-09-15): 34,508 -> 33,722 measured
(-786). `AbstractSchema.fingerprint()` and both adapters' structural
walkers are gone. Almost none of that is the walkers themselves, which
were already lazy: v4's fingerprint chunk statically imported
`zod-v4/introspect`, which the entry also needs, so esbuild's splitting
hoisted introspect + consumer-code into a SECOND EAGER CHUNK that
gzipped alone at 1,506 B instead of ~750 B folded into the entry. The
deletion removed the chunk boundary, not the code; output went from
three chunks to one. The dev-only shared-key mismatch warning now
sketches both schemas over the public AbstractSchema surface, which
costs nothing eager because that module is **DEV**-gated and dropped.
Budget 34_850 -> 34_050 (~0.33 kB headroom).

## E1 + E2: defects, 2026-09-16

E1 + E2 (defects, 2026-09-16): 33,722 -> 33,846 (+124). Three write- and
read-path defects and three adapter ones cost bytes rather than saving
them: the store-owned liveness sweep, and two zod kinds that had been
resolving to `'unknown'` needing a case in each of four walkers. Held
inside the E0 budget rather than raising it.

## E3 Sweep: 2026-09-16

E3 SWEEP (2026-09-16): 33,846 -> 33,589 measured (-257) over seven
mechanical items. Three of the ten planned items were REFUSED on
measurement and the refusals are the reusable part: folding the last
error-store twin measured +10, folding v4's three no-op introspector
stubs +5, and collapsing the whole 43-entry method-skin table into a
bound table -29 against a -505 ablation ceiling. gzip had already
collected the rent on all three. Only unique deletions paid. Budget
34_050 -> 33_900 (~0.31 kB headroom).

## E5b Ratchet: 2026-09-16

E5b RATCHET (2026-09-16): 33,587 -> 33,133 measured (-454). Both
adapters' async-strip walkers are gone. Each rebuilt the entire schema
with its async predicates removed so the sync checks beside them could
still seed at construction, and each was a second parallel
understanding of its own Zod major — which is why they gave DIFFERENT
answers for the same schema (v4 seeded sync refines, v3 only container
checks). Deleting both converges them: a schema declaring async work
anywhere seeds nothing and defers every verdict to the post-mount
pass. The first-paint cost is one frame of an error COUNT;
`meta.valid` does not move, because the async gate already clamps it.
Budget 33_900 -> 33_450 (~0.32 kB headroom).

## E4 Spends Bytes: heap + hot paths, 2026-09-16

E4 SPENDS BYTES (heap + hot paths, 2026-09-16): 33,150 -> 33,758
measured (+608), and it is the first phase of this program to raise
the budget rather than lower it. What it buys, all measured rather
than argued:

per form, prod build, keepNames:false, forced GC
signup untouched 59,043 B -> 45,976 B -22%
signup read-swept 113,419 B -> 89,061 B -21%
100 leaves read-swept 1,039 kB -> 663 kB -36%
400-row table, 800 errors
first form.list() read 332 ms -> 18.7 ms 18x
the same read per keystroke 278 ms -> 7.4 ms 38x
interleaved A/B vs main, 3 rounds, 23 scenarios
500-item array remove+append churn 94% FASTER
reset() full baseline rebuild 35% FASTER
nothing slower beyond the run's noise floor

The bytes went on four things that are each a structure rather than a
branch: one Proxy per meta forest in place of 62 accessors, the
weak per-schema store that lets one `AbstractSchema` serve every form
on a schema, the sorted prefix index over the error stores, and the
bound on the per-path memos that sharing made load-bearing.

Against `main` the branch is still -750 B eager. A budget exists to
catch drift nobody chose, not to forbid a trade somebody priced.
Budget 33_450 -> 34_050 (~0.29 kB headroom).

## A1 Ratchet: the app-level defaults layer, 2026-09-16

A1 RATCHET (2026-09-16): 33,764 -> 33,637 measured (-127), against a
-94 estimate. The pass-2 feature audit opened here.

`createAttaform({ defaults })` let an app set nine `useForm` options
once and have every form inherit them. It is gone, along with
`AttaformDefaults`, `mergeWithDefaults`, `AttaformRegistry.defaults`,
and the Nuxt module's `attaform: { defaults }` config key plus its
`useRuntimeConfig().public.attaform.defaults` slot. The replacement is
three lines of consumer code:

```ts
const useAppForm = (cfg) => useForm({ ...appDefaults, ...cfg })
```

Why it went: 137 `useForm` calls across the downstream consumer pass
`defaultValues` 114x, `key` 113x, `schema` 108x, `validateOn` 2x, and
every other option zero times. `createAttaform()` is called bare.
`attaform/nuxt` is registered with no options. The layer resolved
nothing that was ever set.

The measurement beat the estimate because the ablation that produced
the -94 cut the merge, and the real deletion also took the frozen
registry field and the option-resolution plumbing around it. That is
the program's byte law running the friendly way for once: this was a
unique deletion, not a fold.

Budget 34_050 -> 33_940 (~0.30 kB headroom).

## A2 Ratchet: always strict, 2026-09-16

A2 RATCHET (2026-09-16): 33,637 -> 33,571 measured (-66), against a -20
estimate. `useForm({ strict })` is gone; construction validates, always.

The bytes were never the point, and the phase paid for itself twice
over in what it uncovered. `strict` already defaulted to `true`, so the
only thing deleted was the opt-out: v4's `if (config.strict === false)`
early return, v3's `if ((config.strict ?? true) !== false)` wrapper and
its lax tail, `GetDefaultValuesConfig.strict`, `FormState.strict`, and
the `strict` parameter threaded through `computeBaselineResponse`,
`initialFirstValidationGate` and `queueInitialAsyncValidation`.

**The blind spot is the finding.** 180 `strict: false` call sites across
75 test files, plus a `strict: false` DEFAULT baked into
`test/utils/form-harness.ts`, meant a large share of the suite exercised
an arm no consumer reaches. Moving them onto the real path turned 60
tests red across 14 files. Every one was a fixture that mounted with
defaults its own schema rejects and then asserted on a clean error
store. This is the same shape that hid defect D5, where 19 of 27 v3
parity cases ran lax.

Two behaviours surfaced that the lax fixtures had been hiding. BOTH
were verified pre-existing by checking out A1, removing only the test
harness's `strict: false` default, and re-running with the library
untouched: both reproduce exactly. A real consumer has been reaching
them all along, because `strict: true` was already the default.

1. A container whose subtree holds construction-seeded errors gets a
   NEW aggregated-errors array identity on the form's FIRST write, even
   when its contents and `displayState` do not change, costing one
   extra render per unrelated container. Bounded and one-shot: writes
   2..n hold the isolation the perf lock pins. Now pinned explicitly in
   `test/perf-lock/render-isolation.lock.test.ts`, so a regression to
   per-keystroke fails a test rather than going unnoticed.
2. An unfilled `z.promise(z.string())` leaf on v3 emits an unhandled
   rejection at construction: v3 reports success and hands back a
   derived promise carrying the real verdict, which nothing awaits.
   Already documented and deliberate (Attaform does not silence it; a
   blanket `.catch()` would also swallow a consumer's own promise). The
   smoke fixtures now fill the leaf, so the run stays quiet and a real
   rejection would stand out.

Budget 33_940 -> 33_870 (~0.29 kB headroom).
