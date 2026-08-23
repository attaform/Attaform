# P6: validation/display fold (STUB, detail at boundary)

Delivers ~-650 B gz. Scope: reactive validate() kickoff folds onto
runImperativeValidation (one shell); `parse(path?, { commit? })` absorbs
validateAsync (sign-off 4; parse stays async per the locked no-sync stance);
ValidationError drops per-entry formKey, wizard stamps at aggregation (sign-off 5);
display-state + display-engine merge with test hooks DEV-gated (behavior verbatim);
invalid-submit focus policy becomes a lazy chunk inside the async submit moment
(counted here once); shared groupByCanonicalKey helper.
Entry criteria: P5 tagged store landed. Error-order characterization suite is the gate.
