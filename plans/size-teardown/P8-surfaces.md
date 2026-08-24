# P8: surface program — DONE 2026-08-24

**OUTCOME: measured 34,530 B gz, -1,091 against the -1,400..-2,200 band.**
All four slices shipped; full suite 4,755 green both majors; typecheck
clean; both dist-typed gates green against a fresh unbuild; REPL
playground verified live (5/5 pages incl. both third-party demos);
perf gate PASSED (keystroke/submit/array within noise, errors
stringify +82%, cold-init -2..-5% residual recorded). Commits:
9b555785 (8a pin), fd3e5b77 (8b callable-tree), 40f77b0c (8c forests),
3f52fe63 (8d pickDefined), 163fdc89 (shim restore), e254703c (metaBase
perf fix), + the boundary gates commit.

## Findings

- **Delta -1,091 vs the -1,400..-2,200 band (61% mid-realization).**
  The rep's -1,937 was the LEAN-semantics ceiling; the pin battery
  (8a, 24 new tests) forced back the real contract — `[]` clean-leaf
  reads, live-union enumeration, leaf-view identity, the values
  materializer, per-container error trees — and the restored invoke
  shims cost +131. Slice deltas: 8b -704, 8c -365, 8d -193, shims
  +131, metaBase fix +40.
- **The sucrase finding (flagged for Oswald's re-ruling).** Sign-off
  8's "sucrase shims dropped" was implemented, then REVERSED on new
  evidence: @vue/repl's transformTS calls sucrase WITHOUT
  disableESTransforms, so the docs playground downlevels the
  documented `surface(path)?.x` idiom into a `_optionalChain` helper
  that reads `.call` off the surface and invokes it — post-drop that
  threw "target.call is not a function" in our own playground (and
  under any consumer toolchain targeting below ES2020).
  No-uncaught-exceptions outranks the size sign-off, so
  callableInvokeShim is restored at the ROOT only, with a new
  never-throws contract for absent fields (frozen empty descent).
  Re-dropping stays available at P10 with eyes open. The exotic-name
  half of sign-off 8 (toString/valueOf/hasOwnProperty arbitration)
  stayed dropped: those names now always resolve their built-in
  handlers by dot; the call form addresses any path; `form.values`
  keeps native dot semantics.
- **Unifications beyond the audit's list**: fields leaf views and
  call-form terminals are now ONE cached per-path view, so
  `fields('email') === fields.email`; the fields surface reads through
  the SAME field-state accessor `meta` / register use (one computed
  per path instead of two parallel caches — the register docblock's
  "same memoised identity" claim is now actually true); errors toJSON
  trees memoise in per-container computeds (rebuilt on store change,
  not per stringify — the +82% stringify win).
- **The 8c forest loop initially regressed cold init -4..-9%**:
  getFormMetaBase ran 30 defineProperty calls per field-state
  evaluation (~1,500 per 50-field first-read sweep) where the literal
  bag was one shape-cached op. Fixed by restructuring, not reverting:
  one shared per-form FormMetaBase bag (literal scalar getters +
  loop-defined mirrors over a per-form computed rollup), with
  getFormMetaBase eagerly touching the five lifecycle refs per eval to
  preserve the documented tracking contract (clear-on-submit reveal
  depends on `submitting` being a tracked dep of every field).
  Residual cold-init -2..-5% on the tight arms (~15 µs/mount) recorded
  against the mount-perf capability-tax closure; keystroke unaffected.
- **Refused with measurement, no code motion** (the rep-first rule
  working): the leaf/container field-state builder fold (only twin is
  the tail literal — P6 gzip discount — against real risk to the P3
  blank-reactivity fast path); the activation-getter loop (implemented,
  measured +15 B, reverted — gzip had fully pre-discounted the nine
  getter twins, and the loop costs the literal's member-completeness
  type-check); the useForm/useAbstractForm layer collapse (the skins
  are ~20 runtime lines; their weight is type-level and never ships;
  folding would make core import adapters).
- **Also fixed en route**: the stale `bundle-repl-deps` expectation
  (history.d.ts now emits PathKey as an import from './index' — the
  unified end state — so the warn was a false positive); the perf
  benches' one-run artifact class re-confirmed (deep D=8 collapsed to
  -91% in batch runs, +0.2% solo — positional GC interference, both
  trees).
- Module inventory after 8b: callable-tree.ts (2,142 gz attributed)
  replaces surface-proxy + errors-proxy + field-state-proxy +
  values-proxy (deleted); callable-readonly-snapshot-proxy stays for
  wizard.statuses and left the eager graph; proxy-live-keys +
  proxy-readonly-helpers stay as shared imports. build-form-api
  2,659 -> 2,081 gz; use-abstract-form 1,001 -> 802 gz.
- Gates moved: BUDGET_GZ 36_050 -> 34_950; 10 size-limit caps
  tightened with P8 notes (index/zod 55.25, zod-v4 49, zod-v3 50.25,
  abstract 39.25, scoped 41.5/35.5/36.75, barrel 41.5, abstract-scoped
  26.5).

The original detail plan (2026-08-23, superseded by execution) follows
for the record.

---

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
  api-surface-contract, errors materialization/order suites, the
  display-state and display-reducer suites, own-errors/first-error,
  docs-demos smoke. These are the enumeration/tojson/identity contracts
  the rewrite must hold.
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
