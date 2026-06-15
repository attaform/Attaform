import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import type { ValidationError } from '../../src/runtime/types/types-api'
import type { UseFormReturn } from '../../src/zod'

/**
 * Type surface for a discriminated-union ROOT (variant form): the whole
 * schema is a `z.discriminatedUnion`. The read views (`form.values`,
 * `form.fields`, `form.errors`) lift the top-level union exactly as they
 * do for an interior DU (see `discriminated-union-lift.test.ts`), variant
 * fields are addressable as root string paths (`form.register('cardNumber')`),
 * and `handleSubmit` receives the true, narrowable parsed union.
 */

const _paymentSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('card'), cardNumber: z.string(), cvc: z.string() }),
  z.object({ method: z.literal('bank'), iban: z.string() }),
  z.object({ method: z.literal('invoice'), poNumber: z.string(), netDays: z.number() }),
])

type PaymentForm = UseFormReturn<typeof _paymentSchema>

// Recursive Proxy stand-in (same pattern as discriminated-union-lift):
// the file never invokes useForm because there's no Vue app context;
// only the static types the checker sees matter.
const form: PaymentForm = (() => {
  const handler: ProxyHandler<() => unknown> = {
    get: () => proxy,
    apply: () => proxy,
  }
  const proxy: unknown = new Proxy(() => undefined, handler)
  return proxy as PaymentForm
})()

describe('DU root — form.values lift', () => {
  it('discriminator reads as in-flight string; per-variant keys lift to `T | undefined`', () => {
    expectTypeOf(form.values.method).toEqualTypeOf<string>()
    expectTypeOf(form.values.cardNumber).toEqualTypeOf<string | undefined>()
    expectTypeOf(form.values.cvc).toEqualTypeOf<string | undefined>()
    expectTypeOf(form.values.iban).toEqualTypeOf<string | undefined>()
    expectTypeOf(form.values.poNumber).toEqualTypeOf<string | undefined>()
    expectTypeOf(form.values.netDays).toEqualTypeOf<number | undefined>()
  })
})

describe('DU root — form.fields / form.errors lift', () => {
  it('per-variant field nodes are node-optional, reachable via `?.`', () => {
    expectTypeOf(form.fields.cardNumber?.value).toEqualTypeOf<string | undefined>()
    expectTypeOf(form.fields.netDays?.value).toEqualTypeOf<number | undefined>()
  })

  it('per-variant errors are reachable; leaf is ValidationError[] | undefined', () => {
    expectTypeOf(form.errors.cardNumber).toEqualTypeOf<readonly ValidationError[] | undefined>()
    expectTypeOf(form.errors.iban).toEqualTypeOf<readonly ValidationError[] | undefined>()
  })
})

describe('DU root — register accepts variant + discriminator string paths', () => {
  it('register(discriminator) and register(variant key) typecheck', () => {
    form.register('method')
    form.register('cardNumber')
    form.register('iban')
    form.register('netDays')
  })

  it('register rejects an unknown path', () => {
    // @ts-expect-error 'nope' is not a registrable path on any variant
    form.register('nope')
  })
})

describe('DU root — handleSubmit narrows the parsed union', () => {
  it('values is the true discriminated union, narrowable on the discriminator', () => {
    form.handleSubmit((values) => {
      expectTypeOf(values.method).toEqualTypeOf<'card' | 'bank' | 'invoice'>()
      if (values.method === 'card') {
        expectTypeOf(values.cardNumber).toEqualTypeOf<string>()
        expectTypeOf(values.cvc).toEqualTypeOf<string>()
      }
      if (values.method === 'invoice') {
        expectTypeOf(values.netDays).toEqualTypeOf<number>()
      }
    })
  })
})
