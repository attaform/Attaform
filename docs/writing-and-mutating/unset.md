---
title: unset — the absent sentinel
description: The unset sentinel writes "actually absent" at an optional path — distinct from the empty string or 0 that blank values produce. For schemas where presence carries meaning.
metaRows:
  - label: Category
    value: Export
  - label: From
    value: attaform · attaform/zod · attaform/zod-v3 · attaform/zod-v4
    kind: code
  - label: Use
    value: setValue(path, unset)
    kind: code
  - label: Guard
    value: isUnset(value): value is Unset
    kind: code
---

# `unset` — the absent sentinel

> The escape hatch for optional fields where "absent" must be distinguishable from "blank".

::docs-meta-table
::

Type a value into the middle name field, then click `setValue('middleName', '')` to write an empty string. Click `setValue('middleName', unset)` to write the absent sentinel. Watch the panel: `isUnset(values.middleName)` flips true only for the unset write. Both are valid for an `.optional()` schema, but downstream consumers can tell them apart.

::docs-demo{slug="unset" label="Unset Demo"}
::

## When presence matters

For `.optional()` schemas, three states exist at the path:

| State              | Storage value    | Meaning                                                 |
| ------------------ | ---------------- | ------------------------------------------------------- |
| Present, non-empty | `'Alex'`         | User supplied a value.                                  |
| Present, blank     | `''`             | User cleared the field.                                 |
| Absent             | `unset` sentinel | Field was never written or has been deliberately unset. |

Most consumers don't need to distinguish blank from absent — both fail a `.min(1)` refinement the same way. But some shapes do:

- **PATCH-style APIs** that should only send fields the user actually edited.
- **Discriminated unions** where the discriminator is `undefined` on the "no choice yet" variant.
- **Partial updates** where blanking a field deletes it server-side and you need a third option.

`unset` is the escape hatch for those cases.

## Writing absent

```ts
import { unset } from 'attaform/zod'

form.setValue('middleName', unset)
```

The sentinel is a symbol — typed as `Unset`. `setValue` accepts it at primitive leaves typed as optional in the schema. The slim-type gate rejects it at required leaves (a required string can't be absent).

## Guarding with `isUnset`

```ts
import { isUnset } from 'attaform/zod'

if (isUnset(form.values.middleName)) {
  // skip; the field is absent, not just empty
} else {
  // values.middleName is narrowed to string
}
```

`isUnset(v): v is Unset` narrows to the `Unset` brand type. Use the guard before any read of the path's value when the absent-state matters.

## Distinct from `clear` and `reset`

- `clear('middleName')` writes `''` — the schema-slim blank.
- `reset()` puts the path back to its default (often `''` too).
- `setValue('middleName', unset)` writes the absent sentinel.

The first two go through the same blank-value pipeline; only `setValue(path, unset)` produces the third state.

## Cross-entry availability

`unset` and `isUnset` are exported from every entry — `attaform`, `attaform/zod`, `attaform/zod-v3`, `attaform/zod-v4`. The `Unset` type is exported alongside for explicit annotations:

```ts
import { unset, isUnset, type Unset } from 'attaform/zod'

function pickOptional(v: string | Unset): string | undefined {
  return isUnset(v) ? undefined : v
}
```

## Where to next

- [`setValue` patterns](/docs/writing-and-mutating/set-value) — the write API `unset` plugs into.
- [`clear`](/docs/writing-and-mutating/clear) — the blank-value counterpart.
- [Showing errors at the right time](/docs/validation/showing-errors) — the `blank` field-state bit and how it interacts with absence.
