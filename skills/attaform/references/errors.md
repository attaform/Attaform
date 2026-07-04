# Errors

Attaform holds three error layers (schema validation, blank-required, and user-set) and reads them back through one surface. Server and API errors go through the user-set layer via `form.setErrors`; you rarely touch the other two directly.

## Routing server errors

Inside the submit callback, clear the stale user layer, then route the failure through `setErrors`:

```ts
const onSubmit = form.handleSubmit(async (values) => {
  form.clearErrors()
  try {
    await save(values)
  } catch (err) {
    form.setErrors(normalizeErrors(err))
  }
})
```

- `setErrors(errors | updater | (path, errors))` is a **whole-layer replace**, so `clearErrors()` at the top of a fresh attempt drops errors a previous submit set. `clearErrors(path?)` scopes the clear.
- `handleSubmit` focuses the first offending field for user-set errors exactly as it does for client-invalid fields, so a `setErrors` call inside the callback needs no separate focus step.

## The `ValidationError` envelope

If your backend emits Attaform's `ValidationError` shape, it pipes straight into `setErrors` with no translation layer:

```ts
import type { ValidationError, Json } from 'attaform'

// { message: string; path: (string | number)[]; code?: string; data?: Json | null }
```

- One entry per message at `path: [field]`; a form-level error is `path: []`; a dotted key splits into segments.
- A structured non-field payload (a lockout timestamp, a challenge token) is **one form-level error** whose `.data` carries the payload, never exploded into phantom field errors.
- **Do not build a translation layer** to adapt a payload that already is Attaform's type. If the only friction is a type mismatch (your `data` typed `Record<string, unknown>` rather than Attaform's `Json`), fix the _type_, not with code: `data: z.custom<Json>().nullish()`. Messages come from one source (the server), not a frontend copy map.

A thrown `onSubmit` is also caught and surfaces as a single form-level error, so a bare `throw` is the shortcut when you have no per-field array to distribute. Reach for `setErrors` when the server hands you an array that should target individual fields.

## The own vs subtree axis

Every `FieldState` node (leaves, containers, and the form root) exposes two error axes:

| Accessor                                | Scope                                           |
| --------------------------------------- | ----------------------------------------------- |
| `node.ownErrors` / `node.firstOwnError` | errors at **this path exactly**, no descendants |
| `node.errors` / `form.errors(path)`     | the **subtree**: this path plus descendants     |

On a leaf the two axes coincide. They diverge on containers and on the form root.

## Banners

A form-level banner wants the root's **own** bucket, not the aggregate:

```ts
const banner = computed(() => form.meta.firstOwnError)
```

Do not use `form.errors([])` for a banner: `errors(path)` uniformly means "path plus descendants", so `errors([])` is the whole-form aggregate and would surface individual field errors in the summary. `form.meta.firstOwnError` is the correct root-only read. The same own axis surfaces a container-level `.refine()` error, for example `form.fields.address.firstOwnError`.

## One normalizer, always non-empty

Route every form's error handling through a single normalizer that sits at the error-reading layer, above the transport, and **always returns a non-empty error set**. The fallback is load-bearing: a network drop, a non-standard 500, or a contract violation whose error array came back empty should still yield one generic form-level error, so the user never sees a submit that silently no-ops. Keep this one chokepoint rather than digging the envelope at each call site.
