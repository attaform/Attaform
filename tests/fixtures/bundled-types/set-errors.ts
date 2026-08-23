/**
 * Bundled-types guard for `setErrors` / `clearErrors` through the
 * published artifact, the way a real consumer sees them: `useForm` from
 * `attaform/zod`, the error types from the `attaform` core entry.
 *
 * Pins against the bundled `.d.ts`:
 *   - `ErrorInput` is exported and lenient: an `Error`, a partial object,
 *     or an array of either, with message / path / code / data optional.
 *   - All three `setErrors` call forms type-check (whole-layer replace,
 *     functional updater, path-scoped), including the path-scoped updater.
 *   - The updater's `prev` is a firm `ValidationError[]`.
 *   - `formKey` is accepted but ignored (the form stamps its own), so
 *     `ValidationError` is a subtype of `ErrorInput` and read-back errors
 *     round-trip as input.
 *   - `clearErrors` accepts no arg, a string path, or a segment array.
 */
import { useForm } from 'attaform/zod'
import type { ErrorInput, Json, ValidationError } from 'attaform'
import { z } from 'zod'

const form = useForm({
  schema: z.object({ email: z.string(), name: z.string() }),
  key: 'set-errors-fixture',
})

// Whole-layer: an array, a single object, and an Error all accept.
form.setErrors([{ path: ['email'], message: 'taken', code: 'api:dup' }])
form.setErrors({ message: 'service down' })
form.setErrors(new Error('boom'))

// Lenient: every field optional; `data` is the exported `Json | null`.
const payload: Json = { unlocksAt: '2026-01-01T00:00:00Z', attempts: 3 }
const lenient: ErrorInput = { data: payload }
form.setErrors(lenient)
form.setErrors([{}])

// Functional update: `prev` is the firm ValidationError[].
form.setErrors((prev: ValidationError[]) => [...prev, { message: 'one more' }])

// Path-scoped: string or segment array, with errors or an updater.
form.setErrors('email', [{ message: 'taken' }])
form.setErrors(['email'], { message: 'taken' })
form.setErrors('email', (prev: ValidationError[]) => prev.slice(0, 1))

// clearErrors: no arg, string path, segment array (the root [] included).
form.clearErrors()
form.clearErrors('email')
form.clearErrors(['email'])
form.clearErrors([])

// formKey is accepted but ignored — the form stamps its own. A
// ValidationError read off the form is therefore valid input: the output
// type is a subtype of the input type, no excess-property friction.
form.setErrors([{ message: 'x', formKey: 'nope' }])
const roundTrip: ValidationError = {
  message: 'taken',
  path: ['email'],
  code: 'api:dup',
  formKey: 'set-errors-fixture',
}
const asInput: ErrorInput = roundTrip
form.setErrors([roundTrip])
form.setErrors(asInput)

export { form }
