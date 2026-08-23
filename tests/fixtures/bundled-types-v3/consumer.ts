/**
 * Bundled-types regression fixture — Zod v3 consumer (single-major
 * install). Compiled with `zod` remapped to a v3 install via the
 * sibling tsconfig's `paths`, recreating what a consumer who installs
 * only `zod@3` sees through the unified `attaform/zod` entry's bundled
 * `.d.mts`.
 *
 * Standing guard for the read-slot regression: with one Zod major
 * installed, the bundled `import { z } from 'zod'` inside
 * `dist/zod.d.mts` collapses to that major, so the unified entry's v4
 * overload must NOT greedily match a v3 schema. When it does, the read
 * slot (`form.values` / `form.fields`) projects through the v4
 * `StorageShape` (structural on the v4-only `_zod` brand, which a v3
 * schema lacks) and collapses to `never`, while the input/output slots
 * keep resolving — so `register` / `handleSubmit` compile but every
 * read is poisoned.
 *
 * In-repo type tests can't catch this: the repo installs both majors,
 * so `zod` and `zod-v3` stay distinct and the v4-vs-v3 discrimination
 * always works. The collapse only happens in a one-major consumer —
 * which is exactly what the `paths` remap recreates here.
 */
import { z } from 'zod' // remapped to a v3 install via tsconfig `paths`
import { useForm } from 'attaform/zod'

// Strict type equality — distinguishes `never` and `any` from the real
// type, so a fix can't regress the read slot to either.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const schema = z.object({
  urls: z.array(z.string()).min(1),
  name: z.string(),
})

const form = useForm({ schema, key: 'signup-v3' })

// Read slot — the regression. These were `never` for a v3 consumer.
type _ValuesUrls = Expect<Equal<typeof form.values.urls, string[]>>
type _ValuesName = Expect<Equal<typeof form.values.name, string>>

// Field handles must descend to a real FieldState, not collapse.
type _FieldValue = Expect<Equal<typeof form.fields.name.value, string>>

// Input / submit slots stayed correct even under the bug — pin them so
// the fix can't regress them in the other direction.
form.register('name')
form.handleSubmit((data) => {
  type _SubmitUrls = Expect<Equal<typeof data.urls, string[]>>
  type _SubmitName = Expect<Equal<typeof data.name, string>>
  void data
})

// Record-root form — a `z.record` schema as the root (dictionary form),
// the new surface this guards. Same single-major hazard as the object
// root: the v4 overload must not greedily match this v3 record, or the
// read slot collapses to `never`. The `z.ZodRecord` arm of the v4
// SupportedRootSchema carries argument defaults, so it stays a concrete
// type; this pins that it keeps discriminating in a one-major install.
const rosterSchema = z.record(z.string(), z.object({ tier: z.number() }))
const roster = useForm({ schema: rosterSchema, key: 'roster-v3' })

// Read slot must resolve to the record map (not `never`, not `any`).
type _RosterEntry = Expect<Equal<ReturnType<typeof roster.values>['member-1'], { tier: number }>>

// Variant-root form — a `z.discriminatedUnion` schema as the root
// (variant form), the other new non-object root. Same single-major
// hazard: the v4 overload must not greedily match this v3 DU, or the
// read slot collapses to `never`. The v4 SupportedRootSchema's DU arm
// is written fully applied (v3 requires both arguments, in the reverse
// order of v4), so it stays concrete and keeps discriminating here.
const paymentSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('card'), cardNumber: z.string() }),
  z.object({ method: z.literal('bank'), iban: z.string() }),
])
const payment = useForm({ schema: paymentSchema, key: 'payment-v3' })

// Read slot must lift the union (not collapse to `never`/`any`): the
// discriminator widens to `string`, per-variant keys read `T | undefined`.
type _PayMethod = Expect<Equal<typeof payment.values.method, string>>
type _PayCard = Expect<Equal<typeof payment.values.cardNumber, string | undefined>>
type _PayIban = Expect<Equal<typeof payment.values.iban, string | undefined>>

// A per-variant key must be addressable as a root register path.
payment.register('cardNumber')

export { form, roster, payment }
