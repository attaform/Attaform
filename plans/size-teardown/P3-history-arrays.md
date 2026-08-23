# P3: history plugin + arrays engine (STUB, detail at boundary)

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
Entry criteria: P2 landed (patch appliers moved with clean seams). Detail this file
at the P2 boundary using the fresh attribution map.
