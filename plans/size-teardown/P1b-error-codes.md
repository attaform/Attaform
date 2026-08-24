# P1b: error codes + prose diet (detailed 2026-08-24 at the P7 boundary)

Anchor 33,999 B gz (P7 final). Expected ~-900 realized (the stub's
~1.0 kB expectation scaled by the standing rep-realization discount;
strings gzip well, so apply the discount to the RAW catalogue, not to
wishful math). The gate that kept this phase parked self-satisfies:
the attaform.dev/e/AF## pages are BUILT IN THE SAME PR (ledger
ordering note, re-anchor ruling item 2).

## Entry criteria (rep-first, before assigning a single code)

1. Extract the ACTUAL >=32-byte string literals surviving in the
   ratchet's eager output (`scripts/check-eager-size.mjs` bundles with
   the prod define — dump its minified text and catalogue the strings;
   the dev-flavor prose P1a already strips does NOT count). The stub's
   ~2.25 kB catalogue is from the audit tree — re-derive it on
   today's; P5-P8 deleted several of the cited sites (e.g.
   introspect's kind switch) and P7 added none.
2. Sort by site class: intentional throws (assertZodVersion,
   UnsupportedSchemaError, InvalidUseFormConfigError, root-kind
   assert, hydration version mismatch), invariant guards, and any
   unguarded warns the P1a fixture scan still shows.
3. The measured catalogue IS the phase budget. If it comes in under
   ~1.2 kB raw, re-scope the band down honestly before starting.

## Scope (sign-off 3, approved)

1. Assign AF## codes to the catalogued sites. Error CLASSES and
   `atta:` public codes are API; message TEXT is documented non-API.
2. Prod message shape: `[attaform] AF## attaform.dev/e/AF##`; the dev
   flavor keeps full prose (the dual dist routes it — no runtime
   branch, the flavor split IS the mechanism).
3. Gate genuinely unguarded warn sites (the P1a conversion worklist:
   dist-flavor invariants + dist-flavors.test.ts list).
4. Docs: one page per code under attaform.dev/e/ (generated stubs
   fine to start); nuxt-link-checker keeps them from rotting; the
   in-page 404 fallback convention per project_docs_404_safety.

## Acceptance

- Ratchet drops by the measured catalogue's realized value; BUDGET_GZ
  tightened with the recorded reason.
- Vite consumer fixture in prod mode: zero `[attaform]` dev prose
  outside the allowlist; dev mode shows full diagnostics (the P1a
  fixtures re-run as-is).
- Every AF## page resolves on the docs build (link-checker green);
  every prod throw/invariant message carries its code + URL.
- Full suite + typecheck green both majors; fresh unbuild before both
  dist-typed gates (standing rule).
