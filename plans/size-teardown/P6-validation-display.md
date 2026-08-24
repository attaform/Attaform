# P6: validation/display fold (STUB — GATED on the post-P5 re-anchor)

> **Do not detail or execute until Oswald rules on the post-P5
> re-anchor** (00-program.md ledger note): P5 measured +561 against a
> ~-2,700 promise, so every remaining phase's expected delta needs
> re-derivation with the split-overhead and semantics-preservation
> discounts P5 established. Anchor for any re-derivation: 35,768 B gz
> (reference/attribution-v4.txt regenerated on the P5 final commit).
> One scope item is already DONE: the sign-off-5 formKey drop shipped in
> P5 (commit 9c7ccf64). The invalid-submit focus-policy "lazy chunk"
> item must be re-judged against P5's finding that a new chunk costs
> ~0.5-1 kB of glue before it saves anything.

Original stub (pre-P5 expectations, stale): delivers ~-650 B gz. Scope: reactive validate() kickoff folds onto
runImperativeValidation (one shell); `parse(path?, { commit? })` absorbs
validateAsync (sign-off 4; parse stays async per the locked no-sync stance);
ValidationError drops per-entry formKey, wizard stamps at aggregation (sign-off 5);
display-state + display-engine merge with test hooks DEV-gated (behavior verbatim);
invalid-submit focus policy becomes a lazy chunk inside the async submit moment
(counted here once); shared groupByCanonicalKey helper.
Entry criteria: P5 tagged store landed. Error-order characterization suite is the gate.
