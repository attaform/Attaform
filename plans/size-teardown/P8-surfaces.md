# P8: surface program (detailed 2026-08-23 at the P6 boundary)

Anchor 35,621 B gz (P6 final). Expected band **-1,400..-2,200 B gz** on the
ratchet metric. This is the program's largest remaining credit and the only
one with prototype evidence: re-running
`reference/rep/measure-claims.mjs` against the CURRENT tree (post-P5/P6)
measures the proxy-zoo replacement at **-1,937 B gz** on its broader
scenario (values + errors + fields + register + handleSubmit touched;
baseline 37,818 -> 35,881). The forest-loops arm of that script is STALE
(its `build-form-api-mod.ts` predates P3's array-engine consolidation and
imports the deleted field-arrays.ts) — re-sketch it BEFORE building, per
the program's standing rep-first rule. Behavior verbatim except sign-off 8's
approved drops. Both zod majors. Perf gate: keystroke + mount vs
reference/p5-bench-after.json (proxy work sits on the read path — watch
field-read and errors-materialization benches specifically).

## Scope (sign-off 8: callable reads STAY)

1. **ONE callableTree factory** replacing the seven-module proxy zoo
   (surface-proxy, callable-readonly-snapshot-proxy, values-proxy,
   errors-proxy, field-state-proxy, proxy-live-keys,
   proxy-readonly-helpers): function target, apply trap, array-target swap
   for v-for/renderList, memoized computed toJSON trees, live-key
   enumeration, `[]` leaf reads, child cache on interned nodes. The rep
   modules (errors-rep/fields-rep/values-rep) are LEAN semantics sketches —
   the real factory must add back enumeration parity and leaf-view
   referential stability; both clawbacks are budgeted (~100 B and covered
   in the band above).
2. **Getter forests via FIELD_STATE_KEYS defineProperty loops** for the two
   build-form-api forests (audit claim ~350, refuted down from 650; the
   field-state builder literals canNOT be loop-generated). STALE SKETCH:
   re-make `build-form-api-mod.ts` from today's file (the helper
   `make-mod-bfa.mjs` scripts the transformation) and re-measure before
   committing to it.
3. **One field-state builder**: leaf = degenerate container, O(1) leaf
   error fast path, memoized identity.
4. **pickDefined helper** for the conditional-spread archetype.
5. **Activation getters folded into store entry points**;
   **useForm/useAbstractForm layer collapse** into one createForm core.
6. **Sign-off 8 drops**: exotic-name schema fields + sucrase shims deleted.

## Non-negotiable conditions (from the audit + judge)

- Leaf-view referential stability if `:field`-prop identity matters.
- Enumeration parity on all three surfaces (Object.keys, v-for, spread).
- `toJSON` must survive on values/errors/fields — 107
  `JSON.stringify(form.values)` sites in apps/site are the canary.
- Error order schema -> blank -> user unchanged at every read site.
- Display-state behavior verbatim (field-state builder carries the
  displayState computed wiring).

## Entry criteria / characterization gate

- P5 kernel + P6 shells in place (done).
- Pin FIRST (test-only commit): surface-proxy, values-storage-shape,
  api-surface-contract, errors materialization/order suites, display-state
  - display-reducer, own-errors/first-error, docs-demos smoke. These are
    the enumeration/tojson/identity contracts the rewrite must hold.
- REPL playground pinned + verified per
  reference_playground_repl_debugging (the in-browser Volar worker is
  separate from CLI types — `bundle:repl` + Playwright on localhost).
- Re-run `reference/rep/measure-claims.mjs` at start to re-anchor the
  proxy delta on the day's tree; re-sketch the forest arm.

## Execution order inside the phase

8a pin -> 8b callableTree factory + the three read surfaces (biggest,
rep-validated) -> 8c field-state builder + forests (re-sketch first) ->
8d layer collapse + activation getters + pickDefined + sign-off-8 drops ->
phase-final gates (ratchet, caps, attribution, bench, ledger, P7 detail).
Slice commits with the pin battery green between each.
