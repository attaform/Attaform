# P3: history plugin + arrays engine (detailed 2026-08-23, post-P2)

Status: DONE 2026-08-23. Measured eager 37,210 -> 35,776 B gz (-1,434:
~1,240 history un-weld exactly as verify-p3.mjs predicted at src level +
~195 arrays engine). Budget 37_700 -> 36_250. New `attaform/history`
entry capped at 1.5 KB (measured 1.02 — the ring buffer runs under half
the old delta-chain runtime). Execution findings below.

Delivers ~-1,650 B gz. Scope: (a) `attaform/history` entry exporting
`historyPlugin(config)` used as `useForm({ history: historyPlugin({ max }) })`
(sign-off 2); config-only `{ history: { max } }` form removed; form.history namespace
stubs remain for non-users; internals rewritten as a snapshot ring buffer (halves the
lazy chunk, faster keystrokes); diff-apply's applyPatchesForward/Inverse move into the
history chunk. (b) One arrays engine: array-identity + array-bookkeeping +
array-state-migrate + field-arrays collapse into one module with a single remapForOp/
relocateKeys/permuteList core; variant-memory and fresh-index switches derive from it.
Mutation half stays EAGER (do-not-do list: no chunk race).
Conditions to honor: history must subscribe synchronously at construction (no
missed-delta window); array/DU test matrix green on both majors before landing.
Entry criteria: P2 landed (patch appliers moved with clean seams). MET 2026-08-23.

Fresh anchor (2026-08-23, post-P2): eager 37,210 B gz. Per-module attribution
(gz-attributed, from reference/attribution-v4.txt regenerated on the P2 commit):
history.ts 1,105; diff-apply.ts 896 (only the applyPatchesForward/Inverse half
moves; the diff/apply writer stays eager); array-identity 493; array-state-migrate
477; array-bookkeeping 417; variant-memory 376; field-arrays 308. The (a) half's
credit is history minus the namespace stubs plus the movable diff-apply half; the
(b) half's credit is consolidation savings across the five array/variant modules,
NOT their removal (the mutation half stays eager per the do-not-do list). Expected
landing ~35,550 on the ledger's mid-realization estimate — treat the ratchet as the
only authority, and re-measure a per-module before/after with a verify script in
reference/scripts (pattern: verify-unweld.mjs, strip-aligned) before crediting.

P2 hand-off notes for (a): useForm's history option threading and the form.history
namespace live in build-form-api.ts (2,708 gz eager, the second-largest file) —
the P8 surface program claims build-form-api reductions, so per the byte-accounting
guards any history-namespace savings count HERE only if P8's plan is adjusted at
its boundary; record the split explicitly when detailing the PR. For (b): P2
already deleted array-bookkeeping's dead `elements` dep, so the consolidation
starts from a clean deps surface; the DomBinding seam means the arrays engine
never touches element records (they key by path in the lazily-armed binding and
re-register through the directive on identity changes — nothing to migrate).

## Execution findings (2026-08-23)

### (a) historyPlugin — what landed

- Spike first: `reference/scripts/verify-p3.mjs` (verify-unweld methodology)
  stubbed only the use-abstract-form weld and predicted -1,243 B at the
  src-strip level; post-landing the same script reads delta 0 and both
  src-strip and dist-prod measures agree at 35,776. The prediction covered
  the full (a) half in one stub because esbuild tree-shakes the orphaned
  appliers once history.ts leaves the graph.
- Protocol shape mirrors P2's DomBinding DI exactly: `HistoryKernel`
  (structural 8-member slice of FormStore, @internal, in types-api),
  `HistoryModule` (the attach result, moved to types-api so
  build-form-api / use-form-context type-import it without touching the
  module), and public `HistoryPlugin = { /** @internal */ attach }`.
  FormStore is structurally assignable — zero casts. `HistoryConfig`
  (`true | { max }`) is DELETED everywhere (no-back-compat).
- `historyPlugin(options?)` normalizes `max` ONCE at plugin creation
  (dev-warn source string is now 'historyPlugin({ max })'); `attach`
  subscribes synchronously inside useForm's fresh-state branch, so the
  no-missed-delta-window condition holds by construction. One plugin
  instance across N forms = N independent chains (covered by a new test;
  this is what makes `createAttaform({ defaults: { history } })` safe).
- Ring buffer: `positions: HistorySnapshot[]` + `cursor`. Append drops the
  redo tail, FIFO-evicts over capacity; undo/redo move the cursor and
  restore wholesale; `capacity = max(1, max)` preserves the max:0/max:1
  observable semantics (size floors at 1, canUndo stays false). Restore
  hands `applyFormReplacement` a fresh `structuralSnapshot` clone so a
  stored position can never alias the live form (the delta model leaned on
  copy-on-write successors for this; the ring must clone explicitly).
- DEAD with the delta model: applyPatchesForward/Inverse (diff-apply),
  deleteAtPath + deleteAtPathOffset (path-walker; history was the only
  consumer), errorsEqual/errorFieldsEqual/dataEqual + diffBlankPaths +
  applyDeltaForward/Inverse (history.ts). diff-apply keeps diffAndApply /
  applyChangedKeys / structuralSnapshot (store + build-form-api eager
  consumers). errors-equal.test.ts deleted; error-data.test.ts's equality
  describe replaced with a BEHAVIORAL both-majors undo/redo
  data-preservation round-trip (stronger: it pins what the equality
  helpers only approximated).
- Entry wiring cloned from P2's directive playbook: package.json exports
  (types/development/import), build.config RUNTIME_ENTRIES, aliases in
  vitest.config + vitest.nuxt-ui.config + apps/site nuxt.config (x2),
  exports.test both lists + condition-order list, dist-flavors
  RUNTIME_ENTRIES walk, dev-dce S4 UNWELDED_MODULES += history.ts (12
  modules now). The dist-flavor e2e fixture opts into
  `historyPlugin()` through the committed node_modules symlink and asserts
  the SSR-rendered chain size — the ./history export is probed through the
  REAL exports map end to end.
- REPL: shipment-demo uses history, so `attaform/history` joined the REPL
  bundle set properly (bundle-repl-deps context external:['vue'] — the
  entry pulls only pure helpers, no shared mutable state, so inlining is
  safe), import-map entry, dts bundle, meta.json listing, runtime stub,
  sidecar d.ts, and the branded-type unifier generalized to
  per-file expected lists (history.d.ts inlines PathKey via HistoryKernel;
  no Unset). Verified by running bundle:repl: history.d.ts emits with
  `import type { PathKey } from './index'`.
- Docs: undo-redo page reframed around the plugin (entry metaRow, import
  in every snippet, ring-buffer memory paragraph replacing the delta
  explanation, `history: false` disable snippet dropped — omission is the
  off state); app-defaults page's AttaformDefaults block + a new history
  paragraph; multistep patterns per-step undo; entry-points 15 -> 16 with
  an `attaform/history` section + job-table row; types.md row; Agent
  Skill imports section gains the history bullet.

### (b) arrays engine — what landed

- One module `array-engine.ts` (five files deleted): permutation core
  (remapForOp / changedIndices / permuteList), shared key walk
  (elementIndexUnder + collectKeysAtIndices + migrateMapSubtree /
  migrateSetSubtree / deleteKeysAtIndices), then the derived factories
  (createArrayIdentity, createVariantMemory + cloneVariantSnapshot,
  createArrayBookkeeping) and buildFieldArrayApi. ~2,071 gz attributed
  across the five -> 1,796 for the engine.
- `IndexRemap` gained `oldLen` / `newLen`, so no downstream consumer
  re-derives lengths from the op kind. `arrayIdentity.applyOp(path, remap)`
  replays via `permuteList` (the splice-per-kind switch died);
  `applyRemap` is two `migrateMapSubtree` calls; variant-memory's
  per-kind eviction switch became `dropAtIndices(path, changedIndices(remap))`
  (verified equal index sets for all five op kinds on reachable states);
  the store's `freshElementIndices` switch died (`remap.fresh`).
- The write funnel decodes ONE remap at entry (pre-op length read before
  any mutation) and every consumer shares it: the four fresh-slot scopes
  (symbol strip, slim gate, authored walk, mergeStructural) and the
  post-write pass. `ArrayBookkeeping` collapsed to a single
  `applyStructuralOp(path, remap)` orchestrator preserving the exact
  legacy order: migrate -> seed fresh -> drop schema verdicts at changed ->
  abort vacated validations -> evict variant memory -> replay identity.
  variantMemory joined its deps.
- Behavior-preservation notes: migrate's affected-filter now includes
  `fresh` uniformly (the identity tracker's relocate always did; on
  reachable states a fresh-only index can hold no prior entry, so the
  union is observationally identical). VM eviction bounded by the remap
  (vs the old unbounded `i >= index` scan) is also equal on reachable
  states: wholesale replaces clear memory under the path, so no key can
  outlive its array's length.
- Unit tests: array-state-migrate.test builds remaps only via remapForOp
  (import path swap only); array-identity.test's applyOp calls now pass
  `remapForOp(op, preLen)` with the pre-op length explicit per case.

### Measured results

- Eager 35,776 B gz (predicted (a) 1,243 + (b) ~195; the plan's ~35,550
  assumed a fatter (b) mid-realization — the ratchet is authority).
  Budget 37_700 -> 36_250 (474 B headroom, P2-convention).
- size-limit: 10 caps tightened (index/zod 57.5 -> 55.5 @54.95; zod-v4
  51.5 -> 49.5 @48.81; zod-v3 52.5 -> 50.75 @50.09; abstract 41.5 -> 39.75
  @39.24; zod{useForm} + index{useForm} 45 -> 43 @42.3; zod-v4{useForm}
  39 -> 37 @36.18; zod-v3{useForm} 40.5 -> 38.25 @37.62; zod{injectForm}
  16.5 -> 15.75 @15.15 — that graph never carried history, use-form-context
  only type-imported; abstract{useAbstractForm} 29.5 -> 27.5 @26.91).
  NEW dist/history.mjs cap 1.5 KB @1.02. Held: directive 8 @7.32 (grew
  ~0.15 from unbuild shared-chunk rebalancing after the module-graph
  change, not directive-side weight), useRegister 9.5 @9.05,
  createAttaform 1.5 @0.79.
- Tarball 379.2 kB / 88 files (was 380.1 / 83; +history artifacts, and
  the deleted modules shrank the runtime chunks).

### Deviations from the plan

- applyPatchesForward/Inverse did not MOVE into the history chunk — the
  ring buffer needs no patch machinery, so they were DELETED along with
  path-walker's deleteAtPath. Strictly better than planned.
- The (b) credit realized ~195 gz vs the fatter share of the ~1,650
  planning estimate; (a) over-delivered (~1,240 vs ~1,105 attributed)
  because the orphaned appliers rode out with it. Net -1,434 vs ~-1,650
  planned; landing 35,776 vs ~35,550 expected.
- P8 note stands: the form.history namespace stubs in build-form-api were
  NOT touched (no double-count risk introduced).
