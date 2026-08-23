# P7: zod-core + probe packs (STUB, detail at boundary)

Delivers ~-900 B gz central on minimal-v4, PLUS shrinks the plugin-less barrel
penalty from +5.4 kB to ~+2.5-3 kB (both-majors stack ~6.5-7.5 kB vs 12.3 today).
Scope: shared zod-core (walkTree over pack.children powering async/container
predicates + path-labeled assert; peel/required/DU/issue-map/withMeta once; one
shared lazy fingerprint walker; lazy 3-method sub-schema stubs + a direct
pathNeedsAsync store query) + per-major probe packs (~28 two-line accessors, kind
table as data, safeParse glue, UNSUPPORTED list) + prototype ZodSchemaAdapter
absorbing abstract-schema-factory (services object deleted). Strict defaults:
getSlimSchema/stripRefinements DELETED in favor of the DU-aware value-directed
data-walk fix pass (sign-off 7; unknown constraint keys now preserved; suites
re-baselined; the fix walk must discriminate by VALUE at DU nodes, never
first-candidate).
stripAsyncChecks: KEPT (declined sign-off), preserving SSR construction-seed parity.
REVISIT TRIGGER (evidence-based, agreed 2026-08-23): during P7, add a
characterization test answering "are construction-time sync-check error seeds ever
USER-VISIBLE under default display-state gating on SSR first paint (incl. aria and
form.meta consumers)?" If provably invisible in all default configurations, the
~500 B deletion may be re-proposed with that evidence; until then it stays.
Entry criteria: sign-offs done (they are). Both-majors adapter characterization
suites re-baselined first. v3 alignment details (catch-under-useDefault:false to v4
semantics, slim-root projection deletion, lax fix loop unification) get their own
section at detail time.
