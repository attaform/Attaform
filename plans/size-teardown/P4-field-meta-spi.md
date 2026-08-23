# P4: field-meta install + SPI probe delete (detailed 2026-08-23, post-P3)

Delivers ~-600 B gz. Scope: withMeta/fieldMeta registration module installs the
field-meta walker into the store slot (registration-side install;
`.describe()`/humanize fallback when uninstalled); delete the resolveArrayShape
1M-index probe fallback; make `arrayShapeAtPath` and `getSlimPrimitiveTypesAtPath`
required SPI members (sign-off 6). Adapter-authoring docs page updates land with
the SPI change. Both-majors tests for meta-driven labels.
Entry criteria: none hard; keep after P2/P3 for attribution clarity. MET.

Fresh anchor (2026-08-23, post-P3): eager 35,776 B gz. Per-module attribution
(reference/attribution-v4.txt regenerated on the P3 commit): walk-field-meta.ts
624 gz (the mover — imported eagerly by BOTH adapter entries:
zod-v4/adapter.ts:39 and zod-v3/index.ts:122 pull `getFieldMetaPathMap`);
humanize.ts 108 (stays eager — it is the uninstalled fallback);
field-meta-store.ts 31 (the install slot, stays); core field-meta.ts 29 +
zod-v4/field-meta.ts 17 (registration surface, becomes the installer). The
probe fallback is `resolveArrayShape`'s legacy branch in path-walker.ts
(TUPLE_PROBE_INDEX = 1_000_000 + the 1024-step tuple walk, ~line 290): today
`arrayShapeAtPath` is a REQUIRED member whose `undefined` return arms the
probe — sign-off 6 makes the contract definitive (`number | null`), so the
branch dies and the SchemaForFill docblocks simplify. Expected landing
~35,150 on mid realization; ratchet is the only authority.

P3 hand-off notes: the P2/P3 delivery playbook applies if a new entry were
needed — it is NOT: fieldMeta/withMeta already ship from the barrel, and the
walker install piggybacks on the consumer importing the registration surface
(same import-rides-the-consumer principle as historyPlugin, no new subpath,
no alias-map or REPL work). The DI seam precedent for the slot is
rv.ensureDomBinding (P2) / HistoryPlugin.attach (P3): a structural
kernel-facing type in types-api if the slot needs typing beyond what
field-meta-store already exposes. Both zod adapters must move in the same
commit (zod-v3/v4 parity); the abstract entry's SPI docblocks + the
custom-adapters docs page carry the required-member change; check the two
tolerated narrative-gap snippets in custom-adapters.md / abstract-schema.md
while editing that page (they predate P3 and may want the new members shown).
dev-dce S4's UNWELDED_MODULES gains walk-field-meta.ts when the un-weld
lands (13 modules).
