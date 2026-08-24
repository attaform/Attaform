# Attaform Size Teardown

Analysis-only report. Branch `experiment/size-teardown` (identical to `main` @ `fb532ad9`,
v0.27.6), 2026-08-23. Produced by a 24-agent audit (14 subsystem analysts, 3 architects,
6 adversarial verifiers, 1 judge) plus direct measurement; every load-bearing byte claim
below was either measured with the repo's own ratchet methodology
(`scripts/check-eager-size.mjs`: esbuild, prod define, code-split, import-statement edges)
or adversarially verified and adjusted. No code was changed in this pass.

## 1. Verdict

The 50% goal splits into two different problems with two different answers.

**npm tarball: goal exceeded, config-only, measured.** Three build-config switches
(`sourcemap: false`, `emitCJS: false`, `declaration: 'node16'`) take the package from
1.8 MB packed / 6.9 MB unpacked to a measured **282 kB packed / 1.1 MB unpacked**, an
84% cut with zero feature loss and zero effect on consumer bundles. After adding the
recommended dev/prod dual dist (which grows dist again) and the d.ts comment diet, the
landing zone is **330-430 kB packed, a 76-82% cut**.

**Consumer eager bundle: 44-47% verified, 50% at the optimistic edge, ~60% of headroom
exists.** The ratchet metric (minimal `useForm`, zod-v4, prod) is 46,477 B gz today. The
plan-of-record program below budgets **25,960 B gz** (itemized 24,760 + 1,200 reserve),
with an honest landing range of **24.5-27.0 kB**. Every mechanically measured lever is
banked in that number; the spread comes from rewrite-realization risk (every rewrite a
verifier measured delivered 60-75% of its first estimate). Reaching the literal 23.2 kB
(true 50%) requires the favorable edge of every band plus either the one signed SSR
trade-off (stripAsyncChecks deletion, ~0.5 kB) or a second, harder pass. The clean-sheet
design floor (~18-19 kB, two architects arrived there independently) confirms the
headroom is real; it is just not bankable from verified claims in one program.

Two context points make the practical win bigger than the ratchet number:

1. Today's real consumer pays more than the ratchet says. A real Vite prod build leaks
   ~3.5 kB gz of dev-only diagnostics (measured; the `__DEV__` const-folding strategy
   fails outside esbuild), and a plugin-less default-entry consumer pays +5.4 kB for the
   second zod adapter. The program deletes both structurally.
2. When-used feature costs also drop: wizard 6.1 -> ~3.2 kB gz, the history chunk halves,
   and v-register users gain lazy file/host sub-chunks worth ~1.6-2.1 kB.

## 2. Method

- Baseline, per-file attribution, and scenario matrix measured with the exact
  `check-eager-size.mjs` methodology (esbuild from the pnpm store, prod define, minify,
  `splitting: true`, eager = import-statement closure from the entry). Attribution
  tables: `scratchpad/attribution-v4.txt`, `attribution-index.txt` (session scratchpad).
- Packaging numbers measured in a detached git worktree with modified `build.config.ts`
  (no repo changes).
- 14 subsystem analysts read their files end-to-end and returned structured findings;
  6 verifiers then attacked the biggest claims, several by building and measuring real
  replacement implementations (preserved in `scratchpad/rep/`); 3 architects proposed
  target designs; a judge synthesized the plan of record with verifier-adjusted numbers.
- Supporting sweeps: jscpd (0.66% literal clones: the duplication is semantic, not
  textual), fallow 2.88.3 (top targets agree with the attribution), grep-verified dead
  code.

## 3. Baseline: where every byte lives

Eager cost by entry scenario (gz, measured):

| scenario                                    | today                                            |
| ------------------------------------------- | ------------------------------------------------ |
| `attaform/zod-v4` minimal useForm (ratchet) | 45.39 kB (46,477 B)                              |
| `attaform/zod-v3` minimal                   | 46.08 kB                                         |
| `attaform` default barrel, no build plugin  | 50.77 kB (both adapters eager)                   |
| `attaform` via Nuxt/Vite plugin             | 45.39 kB (plugin aliases to the installed major) |
| `attaform/abstract` (no zod)                | 36.85 kB                                         |
| + useWizard                                 | +6.1 kB when used (tree-shakes to 0 otherwise)   |

Where the minimal-v4 46,477 B sits (gz-attributed):

| cluster                                   | gz bytes | notes                                       |
| ----------------------------------------- | -------- | ------------------------------------------- |
| runtime/core (60 files, everything eager) | 39.5 kB  | the structural problem                      |
| zod-v4 adapter                            | 5.5 kB   | v3 is 7.2; both ride the plugin-less barrel |
| composables                               | 1.1 kB   |                                             |

Top files: create-form-store 7,272 (4,381 lines, ~110-member store surface, ~115 closures
per form), directive stack ~6.3 kB welded on via `plugin.ts` even when unused,
build-form-api 2,755, field-state-api 1,828, process-form 1,566, proxy zoo 3,196 across
seven files, walkers ~6 kB across ten files, history 1,127 welded on though opt-in.

Tarball composition today: sourcemaps 4.34 MB (63% of unpacked), d.ts 1.30 MB with one
229 kB type bundle shipped in triplicate (and 85.9% of that bundle is doc-comments,
which are the IDE-hover feature, worth keeping single-flavor), runtime mjs + a fully
unreachable CJS twin 1.13 MB.

Latent defect found while measuring: **~2,551 B gz of dev-only code ships in every prod
bundle today** (esbuild consumers; ~3.5-4.4 kB on Vite/webpack-class pipelines). The
`__DEV__` cross-module const defeats DCE for early-return guards, `if(!1){}` blocks
survive minification, and `test/packaging/dev-dce.test.ts` asserts exactly one string
that happens to sit in a foldable shape, so CI cannot see the leak.

## 4. The verified program

Eleven workstreams, each independently landable, each re-baselining the eager ratchet on
merge (the standing ratchet number is the only authority; ledger arithmetic never is).
Delivered bytes are verifier-adjusted, deduplicated, against the minimal-v4 metric.

| #   | workstream                                                                                                                                       | eager gz                        | depends on                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | ------------------------------------ |
| P0  | Packaging config: maps off, CJS off, node16 d.mts, files guards, tarball ratchet                                                                 | 0 (tarball -84%)                | nothing                              |
| P1  | Dev/prod dual dist + `development` condition + error codes + hardened DCE test                                                                   | -3,500                          | docs error pages live                |
| P2  | Directive un-weld: registry-only install, transform-injected registration, `attaform/directive` + `installVRegister`, DOM slice out of the store | -5,900                          | SSR compile spike; sign-off 1        |
| P3  | `attaform/history` plugin + snapshot-ring rewrite + one arrays engine                                                                            | -1,650                          | sign-off 2                           |
| P4  | walk-field-meta registration-side install + SPI probe delete                                                                                     | -600                            | sign-off 6                           |
| P5  | Store kernel: plain FormState, store-first-arg functions, single-walk write funnel, one tagged error store, construction=reset                   | -2,700                          | characterization suites pinned first |
| P6  | Validation/display fold: one imperative shell, parse absorbs validateAsync, display merge                                                        | -650                            | P5; sign-offs 4, 5                   |
| P7  | zod-core + per-major probe packs; delete getSlimSchema/stripRefinements (keep stripAsyncChecks)                                                  | -900 (-1,400 with SSR sign-off) | sign-offs 6, 7                       |
| P8  | Surfaces: callableTree factory replaces seven proxy files (callable reads kept), key-list loops, unified field-state builder                     | -2,650                          | P5; REPL verified                    |
| P9  | Interned path trie + normalized-node introspector + one reconcile engine + schema-io merge                                                       | -1,500                          | P5                                   |
| P10 | Sweep: registry fusion, guard()/emitAll, barrel hygiene, d.ts comment policy, wizard internal halving                                            | -480                            | all prior                            |

Sum of deltas -20,530; budget lands 25,960 B with the 1,200 B integration reserve and
~600 B gzip-superadditivity drag already inside the arithmetic. P0-P4 are low-risk and
mostly measured (-11.65 kB, landing ~34.8 kB, a 25% cut, before any rewrite risk is
taken). The rewrites (P5-P9) carry the band.

## 5. Target architecture (judge's synthesis)

Entries: `.` (unified, runtime dispatch; penalty ~2.5-3 kB once adapters are probe
packs), `./zod-v4`, `./zod-v3`, `./abstract`, `./nuxt`, `./vite`, `./transforms`,
per-bundler plugin entries, `./devtools-panel`, plus new `./directive`, `./history`,
`./ssr`. `./types` dropped. Wizard stays in the main entries (measured: tree-shakes to
0). Every runtime entry ships prod + dev flavors behind a `development` export
condition; SSR-only code behind node/server conditions; `__DEV__` resolved at package
build with a CI grep gate on the prod flavor.

Module map with eager budget (minimal-v4, bytes gz):

| module                     | budget     | replaces / notes                                                                                                         |
| -------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| core/path                  | 450        | interned path trie, === equality; replaces paths.ts 698 + round-trips                                                    |
| core/value-walk            | 1,150      | raw ops + ONE reconcile(schema,node,value,mode) engine; replaces 4 walkers ~2.0 kB                                       |
| core/schema-walk           | 1,150      | normalized node() introspector, 8 kinds instead of ~25 wrapper arms                                                      |
| core/hash+humanize+ids     | 380        | kept, genuinely eager                                                                                                    |
| core/diag+errors (prod)    | 500        | AF codes + attaform.dev/e URLs; prose only in dev flavor                                                                 |
| core/kernel                | 3,400      | FormState record, init=reset, single-walk write funnel, tagged error map, hooks; transform-latch bookkeeping stays eager |
| core/display               | 640        | merged, behavior verbatim                                                                                                |
| core/arrays                | 1,100      | one remap engine; mutation eager (no chunk race)                                                                         |
| core/validate+submit       | 1,150      | one shell; focus policy lazy inside async submit                                                                         |
| core/schema-io             | 1,000      | slim-gate + coerce over one per-store SchemaNode cache                                                                   |
| core/variants              | 730        | DU consolidated, eager, work gated on hasDU; rememberVariants default-true intact                                        |
| core/form-api              | 1,950      | plain literal, FIELD_STATE_KEYS loops, activation folded in                                                              |
| core/field-state           | 1,500      | one builder, leaf = degenerate container                                                                                 |
| core/surfaces              | 1,450      | ONE callableTree factory, callable reads KEPT                                                                            |
| core/register              | 1,050      | per-path FieldPort cache; owns element registration + host anchors                                                       |
| core/create-form + entries | 850        | one createForm core, thin adapter wrappers                                                                               |
| core/registry              | 380        | plugin+ssr fused; registers NO directive                                                                                 |
| zod/core                   | 3,600      | shared walk/peel/DU/issue-map/withMeta + data-walk strict defaults                                                       |
| zod/v4-pack                | 1,500      | ~28 accessors, kind table as data, safeParse glue                                                                        |
| zod/adapter-class          | 830        | prototype class absorbing abstract-schema-factory                                                                        |
| integration reserve        | 1,200      | concentrated on kernel/zod-core/surfaces                                                                                 |
| **total**                  | **25,960** | range 24.5-27.0 kB                                                                                                       |

Capability attachment channels: (a) compile-time (vite/nuxt transforms inject
component-local directive registration importing `attaform/directive`, client AND SSR
compiles; needs a spike including the component-host SSR parity traps from #381/#404);
(b) import-gated sync (historyPlugin option value, wizard gate() marker, withMeta
installing walk-field-meta); (c) lazy inside async moments (focus policy, activation,
async-transform then-body, host/file binding chunks); (d) SSR-conditional (hydration
replay behind a payload version stamp; serialize in `./ssr`; Nuxt runtime plugin splits
.server/.client and imports flavored bare specifiers to avoid the two-registry hazard).

## 6. What the verifiers did to the claims

The audit's honesty comes from this pass; the deltas matter for future planning.

- **Directive un-weld: confirmed.** 6,255 B independently reproduced by deleting one
  import. Deflations: the replay-stub idea is REJECTED (a chunk fetch is not a
  microtask; the replayed seed can clobber typed input, silent degradation); the
  "compiled v-model pattern" framing was wrong (Vue compiler helpers import only from
  'vue'), so client delivery is new plugin machinery needing a spike; no-build and
  webpack-family consumers get a documented one-liner `installVRegister(app)`.
- **Dev/prod dual dist: confirmed exactly** (2,551 measured twice) and strengthened: the
  simulated Vite-class pipeline leaks ~4.4 kB raw, ~3.5 kB realistic. Conditions: Nuxt
  runtime plugin flavor mixing (literal file path vs bare specifier), the ratchet must
  re-point at the shipped prod flavor, dual flavor costs ~+130 kB packed.
- **Store lazy program: partially refuted, 4,475 -> ~2,850.** The async-transform
  bookkeeping must stay eager (sync supersede, per-path counts, cancel inside the write
  funnel; the recorded #361 decline was correct); only the then-body commit orchestrator
  defers. Activation lazy is sound with sync gating flips. The DOM move is real but is a
  public RegisterValue reshape contingent on P2. The double full-form diff is real
  (verified at create-form-store.ts:2100 vs diff-apply.ts:309) but only on replacement
  writes: 300, not 450.
- **Adapter program: partially refuted, 2,390 -> 900 central.** Full strip.ts stub
  measures -1,081 gross (attribution said 1,547), the replacement DU-aware fix walk
  costs 200-300, and the real trap was semantic: deleting stripAsyncChecks loses SSR
  construction-time error seeds for async-refine strict schemas (the compensating pass
  is !ssr-gated); it stays by default. kindOf-as-data measured -76, not -250 (gzip
  compresses the switch nearly free). Both-majors total lands ~6.5-7.5 kB, so the barrel
  penalty drops to ~2.5-3 kB.
- **Proxy zoo: confirmed with conditions, 2,850 -> ~2,083 measured** with real
  replacement modules (preserved in scratchpad/rep/): zoo replacement 1,862, forest
  loops 344, non-additive. The callable API survives (thin function-target wrapper over
  memoized computed trees); array-target machinery and toJSON are load-bearing
  (apps/site: 107 JSON.stringify(form.values) sites, 11 v-for-over-fields sites).
- **Program floor: confirmed.** Independent bottom-up floor ~18-19 kB; cross-report
  double-counting quantified at ~1.9 kB and removed from the plan; central landing
  25.3-26.0 kB.

## 7. Do-not-do list (settled by measurement or vetoed)

- Runtime-lazy zod adapter selection: impossible, useForm introspection is sync at first
  paint.
- Barrel flip to v4-only: violates the v3/v4 first-class parity stance; probe packs make
  it unnecessary.
- Wizard subpath entry for size: measured 0 eager benefit; it already tree-shakes.
- Lazy array-mutation half: chunk race silently degrades positional identity; vetoed
  three times independently.
- Replay-stub directive delivery: input-clobber hazard (above).
- Replacing unbuild / per-entry builds: re-creates solved problems (registry module
  identity across entries); zero tarball benefit beyond the config switches.
- Minifying the published dist: zero consumer bytes (bundlers minify), real DX cost.
- Comment stripping in source as a "size" win: comments never reach bundles; the d.ts
  comment policy is a separate, deliberate DX decision.
- Symbol.for description diet, catchOnUseDefaultFalse removal without its own
  conversation, conditional DU install (same-tick reshape contract forbids it).

## 8. Performance co-wins (no-regression is a program gate; these improve)

- Per keystroke: today up to 6 tree walks incl. a provable double diff, 4-6
  canonicalizePath string round-trips, a Date().toISOString() + fresh 8-field record,
  and (with any container/root refine) a whole-form safeParse. Target: ONE schema-guided
  descent emitting patches, interned path === comparisons, capability flags skipping
  DU/transform stages entirely on forms without them.
- Per form mount: ~115 closures + 32 Maps/Sets + an 18-method adapter closure + 16
  service closures today; target: plain state records + prototype/module functions
  (this also unblocks the mount-perf ceiling the perf program hit).
- Per field read: 3-4 proxy/service hops collapse to 1-2; field identity memoized;
  FieldPort cache gives stable RegisterValue identity.
- v3-specific: makeSubSchema no longer builds a full recursive adapter per
  getSchemasAtPath call; DU option deep-clones disappear with the rebuild machinery.
- Wizard: activeForm facade stops allocating a fresh handleSubmit per property read.
- Build-time: the 5 order-coupled template transforms fold into 1-2 with a substring
  prefilter (today ssr-accessed double-parses every .vue file on every HMR update).

## 9. API changes needing sign-off (the full list, judge-recommended)

1. **v-register delivery** (major): plugin users automatic via transforms; others call
   `installVRegister(app)` once; no stub. Recommended: approve.
2. **History import** (moderate): `useForm({ history: historyPlugin({...}) })` from
   `attaform/history`. Recommended: approve.
3. **Prod error prose -> AF codes + attaform.dev/e URLs** (moderate): docs pages first.
   Recommended: approve.
4. **parse absorbs validateAsync** (moderate). Recommended: approve.
5. **ValidationError drops per-entry formKey; single tagged error store** (moderate):
   observable three-channel behavior and schema-first order unchanged, gated by the
   error-order characterization suite. Recommended: approve.
6. **AbstractSchema SPI tightening** (major): node() added, arrayShapeAtPath +
   getSlimPrimitiveTypesAtPath required, services object gone, fingerprint kept but
   shared+lazy. Recommended: approve pre-1.0 with the adapter-authoring docs page.
7. **Zod strict-defaults via data-walk fix pass** (major): unknown constraint keys
   preserved instead of stripped; suites re-baselined. SEPARATE: stripAsyncChecks
   deletion (~0.5 kB more) changes SSR error-seed timing. Recommended: sign the first,
   decline the second (audit story).
8. **Callable reads stay; exotic-name schema fields and sucrase shims dropped**
   (cosmetic): REPL pinned first. Recommended: approve.
9. **SSR helpers move to attaform/ssr; hydration payload gains a version stamp**
   (cosmetic). Recommended: approve.
10. **Form-less affordance steps** (moderate): wizard.forms['intro'] undefined instead
    of a noop form; deletes a full FormStore per intro/review screen. Recommended:
    approve.
11. **Packaging** (moderate): no maps, no CJS, single .d.mts, ./types dropped.
    Recommended: approve.
12. **d.ts two-tier comment policy** (moderate): author's call on the Tier-A cap; hover
    DX is a deliberate craft feature.

## 10. Risk register (abridged; full text in the phase-2 journal)

Realization risk on the three rewrite-heavy budgets (every measured rewrite landed
60-75% of first estimate; mitigate with per-phase ratchet re-baselining). Write-funnel
phase-ordering correctness (blank/authored marks before identity short-circuit,
same-tick DU reshape, blur-dedup value equality, schema-first error order): pin
characterization suites before P5. The directive transform spike is unproven machinery
(component-host SSR parity, getSSRProps-fires-twice). Dual-dist flavor mixing in the
Nuxt runtime plugin. attaform.dev/e/\* becomes load-bearing for prod DX. The DU-aware
fix walk must be value-directed or it clobbers non-first-variant values. TS2589/Volar
defenses must survive the adapter and surface rewrites. Interned path nodes are
per-store; serialized boundaries keep one edge parser.

## 11. Sources

- Phase-1 digest (14 reports): session scratchpad `phase1-digest.md`; perf notes and
  open questions: `phase1-perf-and-questions.md`; phase-2 full results:
  `phase2-results.json`; verifier replacement sketches: `scratchpad/rep/`.
- Workflow journals: `subagents/workflows/wf_11c2b74f-a84/` and `wf_03202724-26e/`
  under the session directory (per-agent transcripts and structured results).
- Fleet cost: ~3.4M subagent tokens, 624 tool calls, ~45 min wall clock.

## 12. Landed (program close, 2026-08-24)

The program ran P0 through P10 on `experiment/size-teardown` (ledger and
per-phase addenda: `plans/size-teardown/00-program.md`). Final measured
state, in the four terms that matter, against the main fb532ad9 baseline:

| surface                               | baseline       | landed        | delta  |
| ------------------------------------- | -------------- | ------------- | ------ |
| eager (minimal useForm, zod-v4, prod) | 46,477 B gz    | 33,004 B gz   | -29.0% |
| barrel (`attaform` index, eager)      | 41,080 B gz \* | 36,587 B gz   | -10.9% |
| tarball (packed / files)              | 1.8 MB / 182   | 364.9 kB / 88 | -80%   |
| wizard when-used (over useForm)       | (not measured) | 5,175 B gz    | banked |
| async lazy chunks                     | --             | 1,327 B gz    | --     |

\* first recorded barrel figure (P7 entry); the pre-program barrel was
not captured. The v4-gap penalty (barrel minus minimal v4) closed from
6,104 to 3,583 B gz.

What the numbers cost and taught:

- The original 25,960 plan-of-record was superseded twice on evidence
  (post-P5 re-anchor, P8-boundary re-derivation). Landing at 33,004 is
  the honest number: every gap to the original target traces to a
  measured refusal recorded in an addendum, not to abandoned work.
- The pricing law that governed the tail of the program: unique code
  and prose delete near raw; structural-twin folds on this tree
  realize at ~2-15% of raw (measured exhibit: 467 raw chars of perfect
  twins bought -10 B gz). P9 closed with all four arms refused on that
  law; P10's four refusals confirmed it at when-used scope.
- The last real eager win was archaeology, not architecture: the June
  persist rip-out had orphaned the store's entire drain spine, and
  deleting it bought -124 B gz of pure dead machinery.
- Guardrails at close: eager ratchet BUDGET_GZ 33_430 (~0.43 kB
  headroom), 24 size-limit caps re-baselined to fresh actuals, tarball
  budget 450 kB (364.9 actual), attribution snapshots (v4, index, v3)
  regenerated in `plans/size-teardown/reference/`.
- Open rulings (Oswald): sign-off 12's d.ts Tier-A cap (options priced
  in addendum 10) and the sucrase-shim re-drop (P8 evidence stands).
- The do-not-do list in section 7 was reconfirmed at close; nothing on
  it was re-attempted.
