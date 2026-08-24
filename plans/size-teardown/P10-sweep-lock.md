# P10: sweep and lock (detailed 2026-08-24 at the P9 boundary)

Anchor 33,124 B gz. The stub's ~-480 eager claim predates the P7-P9
realization data; re-derived eager expectation is **-50..-150**, and
the phase's real value is the tarball (~-80 kB packed claimed), the
wizard when-used path (~-2.9 kB claimed; re-price at entry), and
program close-out. P9's pricing law governs every item: dedup-shaped
work realizes at ~2-15% of raw on this tree; only unique deletions
and never-bundled hygiene realize fully. Measure-first applies to
every eager claim below.

## Re-derived scope (verified against today's tree, 2026-08-24)

1. Dead-module deletion (tarball + hygiene, 0 eager by construction):
   assertions.ts and extract-schema-fields.ts have ZERO src importers
   and no attribution rows (verified). zod-shape.ts IS still imported
   (unified/use-form.ts); prune dead exports only. The stub's
   "orphaned persistence constants" no longer exist in
   serialize/registry (the persist rip-out took them); re-grep at
   entry before claiming the item.
2. Registry fusion (eager, measure-first): registry 496 + plugin 39 +
   ssr 26 gz today. Realizable core = module glue + one makeTracker.
   The guard()/emitAll listener-isolation pattern is 3 twin sites, so
   P9-exhibit pricing applies (expect -10s of B; refuse if the sketch
   lands there). "Wizard surface lazy-installed": wizard has NO rows
   in the minimal-eager attribution); re-measure on the plugin-full
   scenario before claiming bytes; likely already lazy.
3. DEVTOOLS_WINDOW_KEY off the runtime barrel: no minimal-scenario
   attribution row (treeshaken). Re-measure on the barrel scenario;
   execute only if it prices > 0 there.
4. d.ts two-tier comment policy + audience split: tarball only. The
   Tier-A cap is Oswald's call (sign-off 12): present options with
   measured packed sizes, do not pre-decide.
5. Wizard internal program at zero eager delta (when-used -2.9 kB
   claimed; re-price at entry): liveRecord proxy via the shared
   callableTree, form-less affordance steps (sign-off 10),
   import-gated gate spine, guard-inside-helper DCE fix, activeForm
   handleSubmit allocation fix, next/tryNext/back/goTo on one guarded
   navigation core, URL-sync consolidation. Battery first: the full
   wizard suite + wizard-hydration-restore pinned green on both
   majors before any of it.
6. Build-transform consolidation (5 -> 1 with substring prefilter +
   shared safeExpr) and the one attaform/plugin bundler entry (thin
   per-bundler aliases stay, per judge): build-time only, 0 runtime
   bytes; do for maintenance value, not the ratchet.
7. Sucrase-shim re-drop ruling (Oswald's standing item): surface the
   P8 evidence and decide together before touching it.

## Entry criteria

1. Wizard battery pinned green (item 5's suites) on both majors.
2. Bench reference = reference/p9-bench-baseline/\*.json (same
   machine); re-run the four files at entry and diff against it
   before any eager-touching item. Treat keystroke array N=100 as
   known-noisy.
3. Each eager item (2, 3) gets a measured sketch BEFORE its rewrite;
   refuse below ~+3x integration risk, record in the addendum.

## Final acts (program close)

- Full re-baseline: ratchet + every size-limit cap to fresh actuals +
  check:tarball + attribution regen, both majors.
- SIZE-TEARDOWN.md gets the closing "landed" appendix; status ledger
  completed; do-not-do list reconfirmed.
- Landing estimate re-derived: ~33,000 eager (the program's ~32.4 kB
  assumed P9/P10 eager wins that refused on measurement); the honest
  program total is told in eager + barrel + tarball + when-used
  terms, not eager alone.

## CLOSED 2026-08-24: program complete at 33,004 B gz

Entry criteria: wizard battery green (32 files / 274 tests; dual-major
explicit in wizard-gate + wizard-gate-seed, adapter-agnostic elsewhere
by design). Bench re-run vs reference/p9-bench-baseline: within noise
at 46 of 50 points; the three first-run dropouts (blank-flat F=50,
refined F=50, deep D=16) all recovered at 0.98-1.00x on a same-tree
re-run. keystroke array N=100 [v4] is BISTABLE (2,607 / ~247,000 /
447 hz across three same-tree runs while N=10 and N=1000 hold steady);
parked beside the flat-F200 slope point, excluded from within-noise
verdicts. Since P9 landed zero code, this diff measured the noise
floor itself.

Item verdicts (full arithmetic in 00-program.md addendum 10):

1. EXECUTED, expanded. Dead modules deleted (assertions.ts,
   extract-schema-fields.ts), zod-shape.ts pruned to the live v4
   detector: 0 eager by construction. The entry re-grep surfaced the
   real find: the June persist rip-out had orphaned the store's whole
   drain spine (registerDrain / drainHooks / always-immediate
   awaitPendingWrites) plus the registry's drain-then-dispose eviction
   choreography and a shutdown() awaiting nothing, zero callers
   anywhere. Deleted: measured -124 B gz (33,128 -> 33,004).
2. REFUSED at sketch: in-bundle fusion ~0; tracker twins diverge at
   the eviction tail; -0..-25 B after parameterization cost.
3. REFUSED at measurement: zero attribution rows on both scenarios.
4. TO OSWALD (sign-off 12), options measured: A keep (364.9 kB packed
   vs 450 budget); B strip 37 @internal docblocks (-4.6 kB gz);
   C strip all shared-chunk docblocks (-104 kB gz, deletes the hover
   surface). Shared chunks ARE the public hover surface; entries are
   re-export shims.
5. REFUSED at re-price: when-used cost measured 5,175 B gz eager
   (async 0); use-wizard.ts is 84% and unique; gate ground is 25 B;
   the -2.9k claim had no ground on today's tree.
6. REFUSED at inventory: 7 transforms with commons already extracted;
   ordering contracts are public API; bundler entries already thin.
7. TO OSWALD: sucrase re-drop evidence unchanged from P8 (+131 B keeps
   the docs playground alive).

Final acts: BUDGET_GZ 33_550 -> 33_430; 11 size-limit caps re-baselined
to fresh actuals; attribution regenerated (v4, index, new v3 snapshot);
tarball green (364.9 kB packed / 88 files). Full suite 369 files /
4,683 tests, size-limit, bundled-types, doc-snippets, typecheck: all
green. Program totals: eager 46,477 -> 33,004 (-29.0%); barrel 36,587
at close; tarball 1.8 MB -> 364.9 kB (-80%); wizard when-used 5,175 B
gz banked; async lazy 1,327 B gz. SIZE-TEARDOWN.md carries the landed
appendix.

Rulings (Oswald, 2026-08-24): item 4 = Option A, keep every docblock
(the two-tier mechanism is not exercised); item 7 = keep the shims
(+131 B stands). Nothing in the program remains open.
