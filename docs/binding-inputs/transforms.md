---
title: Register transforms
description: A per-field transforms array on register() composes write-time transformations left-to-right. Trim and dashify in the same tick, or return a Promise to normalize asynchronously while the field reads busy.
metaRows:
  - label: Category
    value: Register option
  - label: Signature
    value: register(path, { transforms: RegisterTransform[] })
    kind: code
  - label: Composition
    value: left-to-right
  - label: Type
    value: (value, ctx?) => unknown | Promise<unknown>
    kind: code
---

# Register transforms

> A write-time pipeline that reshapes each value before it lands in storage. Compose `trim`, `lowercase`, `clamp`, `format` per field, and return a Promise when the reshape needs a round trip first.

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

## Async transforms

Hand a transform a `Promise` and Attaform shifts into async mode on its own. The chain stays fully synchronous, landing the value in the same tick, right up until a transform returns a thenable. From there Attaform defers the write, flips the field to `busy`, and commits the resolved value the moment it arrives.

```ts
const normalize: RegisterTransform = async (value, ctx) => {
  const res = await fetch(`/api/normalize?q=${value}`, { signal: ctx?.signal })
  return res.text()
}

form.register('handle', { transforms: [normalize] })
```

Mix sync and async freely in one array. The pipeline runs synchronously until the first `Promise` shows up, so a `[trim, normalize, lowercase]` chain trims in the same tick, waits on `normalize`, then lowercases the result before it lands.

### Watch the busy state

While an async transform settles, the field reports it:

```ts
form.fields.handle.busy // true while the chain is in flight
form.fields.handle.transforming // true specifically for transform work
```

`transforming` is the transform-only signal; `busy` unions it with validation, so one read covers every reason the field is working. Both roll up to `form.meta`, and on a revealed field they drive `displayState` to `'pending'` and set `aria-busy`, the same anti-flash timing a pending validation rides. Bind `busy` directly when you want a spinner the instant work starts, even before the field has been revealed.

### Latest edit wins

Edit faster than the work settles and only the most recent run commits. Earlier in-flight runs are discarded the moment a newer value supersedes them, so the field never stutters back to a stale result or commits two answers out of order.

### Failures land on `transformError`

An async transform that rejects routes its error to a dedicated channel instead of throwing into your app or logging to the console:

```ts
form.fields.handle.transformError // Error | null
```

This is a separate surface from validation `errors`: a normalization that could not finish is a different story from a value the schema rejected. The field keeps its prior committed value, and a later successful run clears the error.

### Cancel stale work with `ctx.signal`

Every transform receives a `ctx` whose `signal` is an `AbortSignal`. Attaform aborts it when a newer edit supersedes the run, or when `reset()` or unmount tears the field down. Thread it into cancellable I/O and a superseded request drops instead of racing the live one:

```ts
const normalize: RegisterTransform = async (value, ctx) => {
  const res = await fetch(`/api/normalize?q=${value}`, { signal: ctx?.signal })
  return res.text()
}
```

A purely synchronous chain never touches `signal` and never allocates a controller, so the fast path stays allocation-free.

### Submit waits for transforms to settle

[`handleSubmit`](/docs/submitting/handle-submit) drains every in-flight transform before it validates, so a submit fired one keystroke after an edit validates the resolved value, not the one mid-flight. Need the same guarantee by hand? `await form.settleTransforms()` resolves once the field (or the whole form) is quiet, and it resolves rather than rejects even when a transform failed.

## From a dropped file to clean data

Here is where async transforms earn their keep: point one at an `<input type="file">` and a file the visitor picks becomes finished form state. No upload handler, no change listener to wire, just a `transforms` array doing the work.

Download the sample below (or write your own), then pick it in the demo. Each line becomes a URL, the lines that are not web addresses get dropped, and a busy indicator runs the whole time the file is being read and tidied.

::docs-demo{slug="transforms-async" label="Async file transform"}
::

Two transforms compose the result. The first reads the file and reshapes its lines; the second lowercases what survives:

```ts
const schema = z.object({ links: z.array(z.string()).nullable() })

const linesToUrls: RegisterTransform = async (value) => {
  if (!(value instanceof File)) return []
  const urls: string[] = []
  for (const line of (await value.text()).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    try {
      const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
      if (url.protocol === 'http:' || url.protocol === 'https:') urls.push(url.href)
    } catch {
      // a line that cannot become a URL is dropped
    }
  }
  return urls
}

const lowercase: RegisterTransform = (value) =>
  Array.isArray(value) ? value.map((url) => String(url).toLowerCase()) : value

const form = useForm({ schema })
```

```vue
<input
  v-register="form.register('links', { transforms: [linesToUrls, lowercase] })"
  type="file"
  accept=".txt,text/plain"
/>
```

Because `linesToUrls` reads the file with `await value.text()`, the chain goes async the instant a file is picked: `form.fields.links.busy` flips true, the resolved `string[]` commits when the read finishes, and an unreadable file lands its message on `form.fields.links.transformError`.

## Throws are caught

A _synchronous_ throw gets caught: the pipeline aborts, nothing writes, and the directive's assigner returns `false`, so a buggy transform never crashes the host app. (An async rejection takes the `transformError` channel above instead, never a throw.) Defensive shape:

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

- [File inputs](/docs/binding-inputs/file): the `File` and `File[]` leaves an async transform reshapes into finished data.
- [Modifiers](/docs/binding-inputs/modifiers): built-in `.lazy`, `.trim`, `.number` for the most common reshaping.
- [Schema-driven coercion](/docs/binding-inputs/coercion): what runs after the transforms array.
- [Custom assigners](/docs/binding-inputs/custom-assigners): `assignKey` for elements whose value surface isn't a DOM property.
