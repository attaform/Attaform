# P3: history plugin + arrays engine (detailed 2026-08-23, post-P2)

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
