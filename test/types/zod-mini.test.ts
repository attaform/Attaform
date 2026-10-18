import { describe, expectTypeOf, it } from 'vitest'
import * as z from 'zod'
import * as zm from 'zod/mini'
import { z as zV3 } from 'zod-v3'
import { useForm } from '../../src'
import {
  useForm as useFormUnified,
  withMeta as withMetaUnified,
  type UseFormReturn,
  type UseFormReturnV3,
  type UseFormReturnV4,
} from '../../src/zod'
import {
  fieldMeta,
  useForm as useFormV4,
  withMeta,
  zodAdapter,
  type PathInput,
  type PathOutput,
} from '../../src/zod-v4'

/**
 * #703: a `zod/mini` schema binds `useForm` exactly as its classic twin
 * does. The v4 constraint is structural on Zod's core `_zod.def.type`,
 * which both builds carry, so each mini root below types its form the
 * same as the classic root beside it, through every entry and helper
 * that takes a v4 schema. A v3 schema still binds the v3 overload.
 *
 * Each twin comparison is anchored by a concrete type as well, so two
 * sides collapsing to the same `never` or `any` cannot pass. The whole
 * form compares by `toEqualTypeOf`, through the `UseFormReturnType`
 * arguments both sides share. TypeScript cannot identity-compare two
 * instantiations of a generic call signature, so `fields` compares by
 * assignability both ways, and `setValue`, whose overloads assign either
 * way whatever the schema, by the calls it accepts and rejects. The
 * `_neverInvoked` wrappers shape call-site inference without a Vue app
 * context.
 */

const classicProfile = z.object({
  name: z.string().check(z.minLength(1)),
  age: z.number().optional(),
  tags: z.array(z.string()).default([]),
  address: z.object({ city: z.string(), zip: z.string().nullable() }),
})
const miniProfile = zm.object({
  name: zm.string().check(zm.minLength(1)),
  age: zm.optional(zm.number()),
  tags: zm._default(zm.array(zm.string()), []),
  address: zm.object({ city: zm.string(), zip: zm.nullable(zm.string()) }),
})

const classicRoster = z.record(z.string(), z.object({ tier: z.number() }))
const miniRoster = zm.record(zm.string(), zm.object({ tier: zm.number() }))

const classicPayment = z.discriminatedUnion('method', [
  z.object({ method: z.literal('card'), cardNumber: z.string() }),
  z.object({ method: z.literal('bank'), iban: z.string(), days: z.number().default(30) }),
])
const miniPayment = zm.discriminatedUnion('method', [
  zm.object({ method: zm.literal('card'), cardNumber: zm.string() }),
  zm.object({ method: zm.literal('bank'), iban: zm.string(), days: zm._default(zm.number(), 30) }),
])

describe('#703: zod/mini object root', () => {
  it('types values, setValue and fields as the classic twin does', () => {
    function _neverInvoked() {
      const classic = useForm({ schema: classicProfile, key: 'profile' })
      const mini = useForm({ schema: miniProfile, key: 'profile' })

      expectTypeOf(mini).toEqualTypeOf(classic)
      expectTypeOf(mini.values).toEqualTypeOf(classic.values)
      expectTypeOf(mini.fields).toExtend<typeof classic.fields>()
      expectTypeOf(classic.fields).toExtend<typeof mini.fields>()

      expectTypeOf(mini.values.name).toEqualTypeOf<string>()
      expectTypeOf(mini.values.age).toEqualTypeOf<number | undefined>()
      expectTypeOf(mini.values.tags).toEqualTypeOf<string[]>()
      expectTypeOf(mini.values.address.zip).toEqualTypeOf<string | null>()
      expectTypeOf(mini.fields.address.city.value).toEqualTypeOf<string>()

      expectTypeOf(mini.fields.address.zip).toEqualTypeOf(classic.fields.address.zip)

      for (const form of [classic, mini]) {
        form.setValue('age', 3)
        form.setValue('address.city', 'Lusaka')
        // @ts-expect-error a number is not a string
        form.setValue('name', 3)
        // @ts-expect-error the schema has no such path
        form.setValue('nickname', 'x')
      }
    }
    void _neverInvoked
  })

  it('types handleSubmit data as the classic twin does', () => {
    function _neverInvoked() {
      const classic = useForm({ schema: classicProfile, key: 'profile' })
      const mini = useForm({ schema: miniProfile, key: 'profile' })
      classic.handleSubmit((classicData) => {
        mini.handleSubmit((miniData) => {
          expectTypeOf(miniData).toEqualTypeOf(classicData)
          expectTypeOf(miniData.tags).toEqualTypeOf<string[]>()
        })
      })
    }
    void _neverInvoked
  })
})

describe('#703: zod/mini record root', () => {
  it('types values, setValue and fields as the classic twin does', () => {
    function _neverInvoked() {
      const classic = useForm({ schema: classicRoster, key: 'roster' })
      const mini = useForm({ schema: miniRoster, key: 'roster' })

      expectTypeOf(mini).toEqualTypeOf(classic)
      expectTypeOf(mini.values).toEqualTypeOf(classic.values)
      expectTypeOf(mini.fields).toExtend<typeof classic.fields>()
      expectTypeOf(classic.fields).toExtend<typeof mini.fields>()

      expectTypeOf<ReturnType<typeof mini.values>['member-1']>().toEqualTypeOf<{ tier: number }>()

      for (const form of [classic, mini]) {
        form.setValue('member-1', { tier: 2 })
        // @ts-expect-error an entry's tier is a number
        form.setValue('member-1', { tier: 'gold' })
      }
    }
    void _neverInvoked
  })
})

describe('#703: zod/mini discriminated-union root', () => {
  it('types values, setValue and fields as the classic twin does', () => {
    function _neverInvoked() {
      const classic = useForm({ schema: classicPayment, key: 'payment' })
      const mini = useForm({ schema: miniPayment, key: 'payment' })

      expectTypeOf(mini).toEqualTypeOf(classic)
      expectTypeOf(mini.values).toEqualTypeOf(classic.values)
      expectTypeOf(mini.fields).toExtend<typeof classic.fields>()
      expectTypeOf(classic.fields).toExtend<typeof mini.fields>()

      expectTypeOf(mini.values.method).toEqualTypeOf<string>()
      expectTypeOf(mini.values.cardNumber).toEqualTypeOf<string | undefined>()
      expectTypeOf(mini.values.days).toEqualTypeOf<number | undefined>()
      expectTypeOf(mini.fields.iban?.value).toEqualTypeOf<string | undefined>()

      for (const form of [classic, mini]) {
        form.setValue('iban', 'ZM00')
        // @ts-expect-error an iban is a string
        form.setValue('iban', 7)
        form.register('cardNumber')
      }
    }
    void _neverInvoked
  })
})

describe('#703: every entry that takes a v4 schema', () => {
  it('binds a mini schema through attaform, attaform/zod and attaform/zod-v4 alike', () => {
    function _neverInvoked() {
      const viaBarrel = useForm({ schema: miniProfile, key: 'profile' })
      const viaUnified = useFormUnified({ schema: miniProfile, key: 'profile' })
      const viaV4 = useFormV4({ schema: miniProfile, key: 'profile' })
      expectTypeOf(viaUnified).toEqualTypeOf(viaBarrel)
      expectTypeOf(viaV4).toEqualTypeOf(viaBarrel)
      expectTypeOf(viaBarrel).toEqualTypeOf<UseFormReturnV4<typeof miniProfile, 'profile'>>()
    }
    void _neverInvoked
  })

  it('projects UseFormReturn and UseFormReturnV4 for each mini root as for its twin', () => {
    function _neverInvoked() {
      expectTypeOf<UseFormReturn<typeof miniProfile>>().toEqualTypeOf<
        UseFormReturn<typeof classicProfile>
      >()
      expectTypeOf<UseFormReturn<typeof miniRoster>>().toEqualTypeOf<
        UseFormReturn<typeof classicRoster>
      >()
      expectTypeOf<UseFormReturn<typeof miniPayment>>().toEqualTypeOf<
        UseFormReturn<typeof classicPayment>
      >()
      expectTypeOf<UseFormReturn<typeof miniProfile>['values']['name']>().toEqualTypeOf<string>()

      // Across two `UseFormReturnV4` arguments TypeScript compares member
      // by member, so the twin check goes by member here too.
      type MiniV4 = UseFormReturnV4<typeof miniProfile>
      type ClassicV4 = UseFormReturnV4<typeof classicProfile>
      expectTypeOf<MiniV4['values']>().toEqualTypeOf<ClassicV4['values']>()
      expectTypeOf<MiniV4['fields']>().toExtend<ClassicV4['fields']>()
      expectTypeOf<ClassicV4['fields']>().toExtend<MiniV4['fields']>()
      expectTypeOf<MiniV4['values']['tags']>().toEqualTypeOf<string[]>()
    }
    void _neverInvoked
  })

  it('reads PathInput and PathOutput off a mini schema', () => {
    expectTypeOf<PathInput<typeof miniProfile, 'tags'>>().toEqualTypeOf<
      PathInput<typeof classicProfile, 'tags'>
    >()
    expectTypeOf<PathOutput<typeof miniProfile, 'tags'>>().toEqualTypeOf<
      PathOutput<typeof classicProfile, 'tags'>
    >()
    expectTypeOf<PathInput<typeof miniProfile, 'tags'>>().toEqualTypeOf<string[] | undefined>()
    expectTypeOf<PathOutput<typeof miniProfile, 'tags'>>().toEqualTypeOf<string[]>()
  })

  it('keeps a mini schema its own type through withMeta and fieldMeta', () => {
    function _neverInvoked() {
      expectTypeOf(withMeta(zm.string(), { label: 'Name' })).toEqualTypeOf<
        zm.ZodMiniString<string>
      >()
      expectTypeOf(withMetaUnified(zm.string(), { label: 'Name' })).toEqualTypeOf<
        zm.ZodMiniString<string>
      >()
      expectTypeOf(zm.string().register(fieldMeta, { label: 'Name' })).toEqualTypeOf<
        zm.ZodMiniString<string>
      >()
    }
    void _neverInvoked
  })

  it('builds the adapter for a mini schema as for its twin', () => {
    function _neverInvoked() {
      expectTypeOf(zodAdapter(miniProfile)).toEqualTypeOf(zodAdapter(classicProfile))
    }
    void _neverInvoked
  })
})

describe('#703: what still does not bind', () => {
  it('rejects a mini schema that cannot be a form root', () => {
    function _neverInvoked() {
      // @ts-expect-error a string holds no keys
      useForm({ schema: zm.string(), key: 'leaf' })
      // @ts-expect-error a plain union has no discriminator to pick a variant by
      useForm({ schema: zm.union([zm.object({ a: zm.string() }), zm.object({ b: zm.number() })]) })
    }
    void _neverInvoked
  })

  it('sends a v3 schema to the v3 overload', () => {
    function _neverInvoked() {
      const schema = zV3.object({ name: zV3.string(), tags: zV3.array(zV3.string()) })
      const form = useForm({ schema, key: 'v3' })
      expectTypeOf(form).toEqualTypeOf<UseFormReturnV3<typeof schema, 'v3'>>()
      expectTypeOf(form.values.tags).toEqualTypeOf<string[]>()
    }
    void _neverInvoked
  })
})
