/**
 * Bundled-types guard for `ValidationError.data` and the exported
 * `Json` type through the published artifact, the way a real consumer
 * sees them: `useForm` from `attaform/zod`, the error types from the
 * `attaform` core entry.
 *
 * Pins three things against the bundled `.d.ts`:
 *   - `Json` is exported and admits every JSON arm recursively (a
 *     bundler that collapsed it to `any` / `unknown` or dropped the
 *     recursion fails the structural assignment below).
 *   - `ValidationError.data` types as `Json | null | undefined` — the
 *     opaque, optional payload slot.
 *   - `data` is reachable on the real read surface (`form.meta.errors`),
 *     not just on the standalone type — so an emit that drops the field
 *     from the surfaced error shape fails here.
 */
import { useForm } from '../../../dist/zod'
import type { Json, ValidationError } from '../../../dist/index'
import { z } from 'zod'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

// `Json` is exported and recursive: a value touching string, number,
// boolean, null, array, and nested-object arms must assign cleanly.
const sample: Json = { a: [1, 'two', true, null, { nested: [0, { deep: true }] }] }
void sample

// The standalone type carries an optional, opaque `data` slot.
declare const err: ValidationError
type _DataSlot = Expect<Equal<typeof err.data, Json | null | undefined>>

// And it is reachable on the real read surface.
const form = useForm({ schema: z.object({ email: z.string() }), key: 'error-data-fixture' })
const first = form.meta.errors[0]
if (first) {
  const payload: Json | null | undefined = first.data
  void payload
}

export { form }
