---
title: Register transforms
description: A per-field transforms array on register() composes sync write-time transformations left-to-right. Trim, lowercase, dashify, clamp, format; each transform reshapes the value before it lands in storage.
metaRows:
  - label: Category
    value: Register option
  - label: Signature
    value: register(path, { transforms: RegisterTransform[] })
    kind: code
  - label: Composition
    value: left-to-right
  - label: Type
    value: (value: unknown) => unknown
    kind: code
---

# Register transforms

> A sync pipeline that reshapes the incoming value before it lands in storage. Compose `trim`, `lowercase`, `clamp`, `format` per field.

::docs-meta-table
::

Type a mixed-case title with spaces into the slug field and watch the readout: the value lands as a lowercased, dashified, alphanumeric-only string. The first input has no transforms; the second composes two (`lowercase` then `dashify`) through the `transforms` array on `register`. The [Composition order](#composition-order) section unpacks why left-to-right composition makes a personal transform library easy to assemble.

::docs-demo{slug="transforms" label="Transforms Demo"}
::

## A transform is a function

```ts
import type { RegisterTransform } from 'attaform'

const lowercase: RegisterTransform = (v) => (typeof v === 'string' ? v.toLowerCase() : v)
const dashify: RegisterTransform = (v) => (typeof v === 'string' ? v.replace(/\s+/g, '-') : v)
```

`RegisterTransform` is `(value: unknown) => unknown`. The shape is intentionally generic, so a personal library of transforms plugs into any `register()` call site regardless of leaf type. Library authors defend against type mismatches by no-op'ing on the unexpected branch.

## Attach via `transforms: [...]`

```ts
form.register('slug', { transforms: [lowercase, dashify] })
```

Pass an ordered array on the `register` options. Every keystroke (or `change`/`blur` with `.lazy`) flows through the transforms left-to-right; the final value is what lands in storage.

## Composition order

Transforms run left-to-right:

```ts
form.register('slug', { transforms: [trim, lowercase, dashify] })
// 'Hello World ' → 'Hello World' → 'hello world' → 'hello-world'
```

Pick the order that matches the data flow you want. The [`.trim`](/docs/binding-inputs/modifiers) modifier runs before any transform, so a `[trim, ...]` transforms array would be redundant. Reach for the modifier when you want trimming and the transforms array when you want anything else.

## Sync only

Transforms MUST be sync. Returning a `Promise` aborts the write and logs to `console.error`. For canonicalize-before-write patterns that need async work (a server lookup, a database query), reach for **async refinements** in the schema; transforms are for fire-and-forget mechanical reshaping.

## Throws are caught

A transform that throws gets caught: the pipeline aborts, nothing writes, the directive's assigner returns `false`. Defensive shape:

```ts
const safeBigInt: RegisterTransform = (v) => {
  try {
    return typeof v === 'string' ? BigInt(v) : v
  } catch {
    return v // pass through; the slim gate will reject the bad value with a friendly message
  }
}
```

`BigInt('not-a-number')` throws; the catch lets the original value through, and the schema's leaf validator handles the rejection.

## Where to next

- [Modifiers](/docs/binding-inputs/modifiers): built-in `.lazy`, `.trim`, `.number` for the most common reshaping.
- [Schema-driven coercion](/docs/binding-inputs/coercion): what runs after the transforms array.
- [Custom assigners](/docs/binding-inputs/custom-assigners): `assignKey` for elements whose value surface isn't a DOM property.
