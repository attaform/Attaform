/**
 * Bundled-types guard for a discriminated-union ROOT (variant form)
 * through the published unified `attaform/zod` artifact, with both Zod
 * majors installed (the normal consumer case). The v4 overload must
 * match a `z.discriminatedUnion` root via `SupportedRootSchema &
 * ZodV4Internals` and project the lifted read shape.
 *
 * This pins the v4 path deterministically against the bundled `.d.mts`,
 * independent of the in-repo `UseFormReturn` helper: a bound regression
 * or a depth bail that collapses the read slot to `never` fails here.
 * The v3-only sibling fixture guards the same root through the v3 path.
 */
import { z } from 'zod'
import { useForm } from 'attaform/zod'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const paymentSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('card'), cardNumber: z.string(), cvc: z.string() }),
  z.object({ method: z.literal('bank'), iban: z.string() }),
  z.object({ method: z.literal('invoice'), poNumber: z.string(), netDays: z.number() }),
])

const payment = useForm({ schema: paymentSchema, key: 'payment-v4' })

// Read slot must lift the union (not collapse to `never`/`any`): the
// discriminator widens to `string`, per-variant keys read `T | undefined`.
type _Method = Expect<Equal<typeof payment.values.method, string>>
type _Card = Expect<Equal<typeof payment.values.cardNumber, string | undefined>>
type _Net = Expect<Equal<typeof payment.values.netDays, number | undefined>>

// A per-variant key is addressable as a root register path.
payment.register('cardNumber')

// handleSubmit narrows to the active variant.
payment.handleSubmit((values) => {
  if (values.method === 'invoice') {
    type _PO = Expect<Equal<typeof values.poNumber, string>>
    void values.poNumber
  }
  void values
})

export { payment }
