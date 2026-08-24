# Size-teardown program: master plan

This file plus one phase file is everything a fresh context needs to execute a phase.
Read this first, then the phase file, then (for background) `SIZE-TEARDOWN.md` sections
4 and 5. Reference evidence lives in `plans/size-teardown/reference/` (fleet digests,
attribution tables, verifier measurement scripts, the P8 replacement sketches).

- Audit report: `SIZE-TEARDOWN.md` (repo root, commit f5be28a2)
- Artifact: https://claude.ai/code/artifact/e784bdb8-1c19-4c26-86ab-73e75ee6268a
- Baseline: main @ fb532ad9, v0.27.6. Ratchet metric 46,477 B gz
  (minimal useForm, zod-v4, prod; `scripts/check-eager-size.mjs`).
- Program target: plan-of-record 25,960 B gz, honest range 24.5-27.0 kB.
  Tarball: 1.8 MB packed to 330-430 kB.

## Status ledger

Update this table at every phase boundary. "eager after" is the measured ratchet
number on the phase's merge commit, not an estimate.

| phase | title                                 | status  | eager after (B gz) | date       | notes                                       |
| ----- | ------------------------------------- | ------- | ------------------ | ---------- | ------------------------------------------- |
| --    | baseline                              | --      | 46,477             | 2026-08-23 | main fb532ad9                               |
| P0    | packaging config                      | done    | 46,477 (unchanged) | 2026-08-23 | 282.2 kB packed, 60 files (was 1.8 MB, 182) |
| P1a   | dev/prod dual dist                    | done    | 43,741             | 2026-08-23 | 377.6 kB packed, 75 files; dev boot e2e ok  |
| P1b   | error codes + prose diet              | pending | ~42,800 exp.       |            | GATED on attaform.dev/e/\* pages            |
| P2    | directive un-weld                     | done    | 37,210             | 2026-08-23 | -6,531; caps tightened; delivery landed     |
| P3    | history plugin + arrays engine        | done    | 35,776             | 2026-08-23 | -1,434; attaform/history entry; ring buffer |
| P4    | field-meta install + SPI probe delete | done    | 35,207             | 2026-08-23 | -569; walk rides withMeta; probe deleted    |
| P5    | store kernel                          | done    | 35,768             | 2026-08-23 | **+561** — size promise refuted; perf phase |
| P6    | validation/display fold               | pending | RE-ANCHOR          |            | after P5                                    |
| P7    | zod-core + probe packs                | pending | ~30,500 exp.       |            | independent                                 |
| P8    | surface program                       | pending | ~27,850 exp.       |            | after P5                                    |
| P9    | paths + walkers + schema-io           | pending | ~26,350 exp.       |            | after P5                                    |
| P10   | sweep and lock                        | pending | ~25,870 exp.       |            | last                                        |

> **RE-ANCHOR REQUIRED (2026-08-23, post-P5).** P5 measured **+561** against
> a ~-2,700 promise: the kernel-record enabler, the semantics-preserving
> tagged-store machinery, and the capability flag cost more than the
> phase's deletions saved, and the activation lazy-chunk split proved
> gzip-NEGATIVE (~880 B of cross-chunk glue + per-chunk gzip loss vs
> ~570 B moved) — implemented, measured, reverted. Two consequences for
> P6-P10 before any further execution: (1) every remaining expectation
> column is stale — the true anchor is 35,768; (2) the audit's lazy-move
> credits need a split-overhead discount (~0.5-1 kB per new chunk) and
> its consolidation credits need a semantics-preservation discount.
> Oswald decides whether the remaining phases run as scoped, get
> re-audited, or the program closes with P5's perf/API wins banked. P5's
> full account: P5-store-kernel.md findings.

"exp." columns assume mid realization; they are planning aids, never authority.
Only the ratchet output is authority.

## Sign-off ledger (Oswald, 2026-08-23): 11/12 approved

Of the 12 API-change decisions in SIZE-TEARDOWN.md section 9, ELEVEN are APPROVED
and ONE is DECLINED, following the judge's recommendation in every case.

APPROVED (11):

1. v-register delivery: transforms inject registration; others `installVRegister(app)`;
   no replay stub. 2. History via `historyPlugin({...})` from `attaform/history`.
2. Prod error prose becomes AF codes + attaform.dev/e URLs (docs pages first).
3. `parse(path?, { commit? })` absorbs `validateAsync`. 5. Single tagged error store;
   ValidationError drops per-entry formKey; observable channel behavior unchanged.
4. AbstractSchema SPI tightening (node() added; arrayShapeAtPath + slim kinds required;
   services object gone; fingerprint kept, shared + lazy). 7. Zod strict defaults via
   the DU-aware data-walk fix pass. 8. Callable reads stay; exotic-name schema fields +
   sucrase shims dropped. 9. SSR helpers move to `attaform/ssr`; hydration payload
   version stamp. 10. Form-less wizard affordance steps. 11. Packaging (no maps, no
   CJS, single .d.mts, ./types + legacy main dropped). 12\*. d.ts two-tier comment
   policy (mechanism approved; Tier-A cap is Oswald's call at P10).

DECLINED (1): the stripAsyncChecks deletion (the separate ~500 B rider attached to
decision 7). SSR construction-seed parity is kept. Evidence-based revisit trigger
recorded in the P7 plan; do not re-propose without that evidence.

## Ratchet protocol

1. `scripts/check-eager-size.mjs` output is the sole byte authority. Ledger arithmetic
   and per-file attribution are planning aids (gzip superadditivity is real).
2. Before attributing any regression to a branch, measure its merge-base first.
3. At every phase boundary: run the ratchet; tighten `BUDGET_GZ` to lock the win with
   a recorded reason in the script comment (the file's convention); update the status
   ledger; regenerate the attribution map
   (`node plans/size-teardown/reference/scripts/attribution.mjs v4`); flesh out the
   next phase file from its stub using the fresh numbers.
4. From P1 onward the ratchet measures the shipped PROD FLAVOR (P1 re-points it).
   Until then it measures src with the prod define, as today.
5. `.size-limit.js` caps and the tarball ratchet (added in P0) move in the same commit
   as the win they lock.

## Byte-accounting guards (from the judge; do not undo)

- merge-hydration bytes live EAGER in the P9 reconcile engine; P5's activation move
  credits ~480, not 600.
- The invalid-submit focus-policy lazy move is counted once (in P6), not also in P5.
- assigner-pipeline savings are zeroed: that cluster leaves eager with P2.
- Error prose is counted once, in P1; P5/P6 must not re-claim errors.ts strings.
- The store DOM-binding move is part of P2 (public RegisterValue reshape, sign-off 1).

## Working agreements (restated so they survive compaction)

- Run tests as `pnpm test <files>` (webstorage flag wrapper), full `pnpm test` +
  `pnpm typecheck` (it covers test/\*\*) before any push; pre-push extras for type or
  demo changes: `pnpm check:bundled-types` and the demo-tracking smoke test.
- Every behavioral change is implemented AND tested against BOTH zod majors.
- Invariants that never move: error order schema -> blank -> user with authored schema
  messages leading firstError on submit; `field.blank` semantics; rememberVariants
  default-true; display-state behavior verbatim (anti-flash timing, earned success,
  reward-early gate); zero runtime dependencies; no uncaught exceptions into consumer
  apps; SSR cross-path parity (test matrix #378 extends to any new delivery path).
- One phase at a time; a phase lands as one PR (or a small stack) with the ratchet
  moved in the same PR. Commit messages via a wrapped `-F` file, body <=72 cols,
  never amend.
- Characterization-first for P5+: the suites named in each phase file are pinned green
  on both majors BEFORE the rewrite starts.
- Docs: pages that error codes point at (attaform.dev/e/AF##) land before P1b ships.

## Compaction protocol

At each phase boundary, in order: ratchet + ledger update, next-phase detail pass,
commit, THEN `/compact`. A fresh session starts by reading `00-program.md` + the
active phase file. Nothing needed to execute lives only in chat history or scratchpad.

## Do-not-do list (settled; do not relitigate without new evidence)

Runtime-lazy zod adapter selection; barrel v4-only flip; wizard subpath entry;
lazy array-mutation half; replay-stub directive delivery; unbuild replacement;
per-entry builds; minifying the published dist; async-transform bookkeeping deferral
(the #361 decline was re-verified: sync supersede + per-path counts + cancel inside
the write funnel stay eager; only the then-body commit orchestrator defers).
