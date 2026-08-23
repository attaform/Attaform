# P5: store kernel (STUB, detail at boundary; the correctness core)

Delivers ~-2,700 B gz. Scope: create-form-store's closure becomes a plain FormState
record + store-first-arg module functions + ordered hook arrays; construction = reset
(one initialize sequence); single-walk write funnel (gate + strip-check + complete +
author + patch-emit) feeding patches straight to applyChangedKeys (deletes the
verified double diff at create-form-store.ts:2100 vs diff-apply.ts:309); ONE tagged
error store (src schema|user, blank derived at read) with three shared writers;
capability flags (hasDU/hasTransforms/hasArrays) skip pipeline stages; DU stack
(reshape + du-stubs + variant memory + ancestor guard) consolidated to one module +
one clone walk; activation/rehydrate lazy behind activate() with SYNC gating flips
(hydrating/activated/activationPromise published synchronously; onServerPrefetch
awaits the composed promise); SSR replay moves behind the registry payload path with
a version stamp; async-transform: bookkeeping STAYS EAGER, only the assigner
then-body commit orchestrator defers (see do-not-do list).
HARD GATE before starting: pin characterization suites green on BOTH majors for:
write-funnel phase ordering (blank/authored marks before identity short-circuit),
same-tick DU reshape (no flicker), blur-revalidation value-equality dedup, error
order schema-first, reset/resetField, transforms latching, hydration replay.
Perf gate: bench-arena mount + keystroke benches must not regress; expect improvement
(~115 closures + 32 Maps/Sets per form become shared functions + plain records).
Detail this file at the P4 boundary; re-slice using the fresh attribution map.
