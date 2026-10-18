/**
 * Bundled-types guard for #703: a `zod/mini` schema through the
 * published artifact. The first block is the issue's reproduction, which
 * failed with TS2589 and TS2769 while the v4 constraint named classic
 * `z.ZodObject`, `z.ZodRecord` and `z.ZodDiscriminatedUnion`. The rest
 * pins a mini form's read slot to its classic twin's through each entry
 * that takes a v4 schema, so a collapse to `never` or `any` in the
 * bundled `.d.mts` fails here rather than in a consumer's editor.
 */
import { useForm } from 'attaform'
import { useForm as useFormUnified } from 'attaform/zod'
import { useForm as useFormV4, withMeta, zodAdapter } from 'attaform/zod-v4'
import * as zm from 'zod/mini'
import * as z from 'zod'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

// The issue's reproduction.
const classic = z.object({ name: z.string().check(z.minLength(1)) })
const mini = zm.object({ name: zm.string().check(zm.minLength(1)) })

export function classicForm() {
  return useForm({ schema: classic, key: 'classic' })
}
export function miniForm() {
  return useForm({ schema: mini, key: 'mini' })
}

type _MiniName = Expect<Equal<ReturnType<typeof miniForm>['values']['name'], string>>
type _Twin = Expect<
  Equal<ReturnType<typeof miniForm>['values'], ReturnType<typeof classicForm>['values']>
>

// Record and discriminated-union roots, through the other two entries.
const roster = zm.record(zm.string(), zm.object({ tier: zm._default(zm.number(), 1) }))
const payment = zm.discriminatedUnion('method', [
  zm.object({ method: zm.literal('card'), cardNumber: zm.string() }),
  zm.object({ method: zm.literal('bank'), iban: zm.string() }),
])

export function rosterForm() {
  return useFormUnified({ schema: roster, key: 'roster' })
}
export function paymentForm() {
  return useFormV4({ schema: payment, key: 'payment' })
}

type _RosterEntry = Expect<
  Equal<ReturnType<ReturnType<typeof rosterForm>['values']>['member-1'], { tier: number }>
>
type _PayMethod = Expect<Equal<ReturnType<typeof paymentForm>['values']['method'], string>>
type _PayIban = Expect<Equal<ReturnType<typeof paymentForm>['values']['iban'], string | undefined>>

// `withMeta` keeps the mini type, and the adapter takes a mini root.
const labelled = withMeta(zm.string(), { label: 'Name' })
type _Labelled = Expect<Equal<typeof labelled, zm.ZodMiniString<string>>>
export const miniAdapter = zodAdapter(mini)
