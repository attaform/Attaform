# P8: surface program (STUB, detail at boundary)

Delivers ~-2,650 B gz (verifier-measured band; real replacement sketches in
reference/rep/ with their measurement script). Scope: ONE callableTree factory
(function target, apply trap, array-target swap for v-for/renderList, memoized
computed toJSON trees, live-key enumeration, [] leaf reads, child cache on interned
nodes) replaces surface-proxy, callable-readonly-snapshot-proxy, values-proxy,
errors-proxy, field-state-proxy, proxy-live-keys, proxy-readonly-helpers; callable
reads KEPT (sign-off 8; exotic-name schema fields + sucrase shims dropped, REPL
playground pinned + verified first); FIELD_STATE_KEYS defineProperty loops for the
two build-form-api getter forests (~350, refuted down from 650; the field-state
builder literals canNOT be loop-generated); one field-state builder (leaf =
degenerate container, O(1) leaf error fast path, memoized identity); pickDefined
helper for the conditional-spread archetype; activation getters folded into store
entry points; useForm/useAbstractForm layer collapse into one createForm core.
Conditions: leaf-view referential stability if :field-prop identity matters
(~100 clawback budgeted); enumeration parity budgeted; toJSON must survive on all
three surfaces (107 JSON.stringify(form.values) sites in apps/site).
Entry criteria: P5 kernel entry points. Playground/REPL verification per
reference (in-browser Volar worker is separate from CLI types).
