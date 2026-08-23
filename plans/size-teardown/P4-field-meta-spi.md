# P4: field-meta install + SPI probe delete (STUB, detail at boundary)

Delivers ~-600 B gz (walk-field-meta 486 measured + ~120 probe delete). Scope:
withMeta/fieldMeta registration module installs the field-meta walker into the store
slot (registration-side install; `.describe()`/humanize fallback when uninstalled);
delete the resolveArrayShape 1M-index probe fallback; make `arrayShapeAtPath` and
`getSlimPrimitiveTypesAtPath` required SPI members (sign-off 6). Adapter-authoring
docs page updates land with the SPI change. Both-majors tests for meta-driven labels.
Entry criteria: none hard; keep after P2/P3 for attribution clarity.
