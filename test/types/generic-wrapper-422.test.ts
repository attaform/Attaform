import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormUnified } from '../../src/zod'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'

/**
 * Regression test for #422 — wrapping `useForm` in a generic helper that
 * forwards a schema-derived `defaultValues`. Before the fix this tripped
 * TS2589 ("excessively deep") / TS2769 ("no overload matches") because the
 * `defaultValues` slot was a `DefaultValuesInput` conditional cascade that
 * TS cannot relate to a free schema type parameter `S`.
 *
 * The `AcceptableDefaults` slot now carries the schema's own input
 * (`z.input<S>`) as a reflexive escape arm: a forwarded `z.input<S>` is
 * assignable to it even under a generic, while the arm is redundant at
 * concrete call sites (so per-field checking and the intentional
 * `defaultValues` widening are unchanged). Covered for all three entries
 * and both Zod majors. `_neverInvoked` wrappers exercise call-site
 * inference without a Vue app context.
 */

describe('#422 — generic form wrappers forwarding defaultValues', () => {
  it('compiles a generic wrapper over the unified entry (v4 schema)', () => {
    function _neverInvoked() {
      function makeForm<S extends z.ZodObject<z.ZodRawShape>>(
        schema: S,
        defaultValues: z.input<S>
      ) {
        return useFormUnified({ schema, key: 'unified', defaultValues })
      }
      const form = makeForm(z.object({ email: z.string(), age: z.number() }), { email: '', age: 0 })
      // inference flows through the wrapper, no annotations
      expectTypeOf(form.values.email).toEqualTypeOf<string>()
      expectTypeOf(form.values.age).toEqualTypeOf<number>()
    }
    void _neverInvoked
  })

  it('compiles a generic wrapper over the v4-direct entry', () => {
    function _neverInvoked() {
      function makeForm<S extends z.ZodObject<z.ZodRawShape>>(
        schema: S,
        defaultValues: z.input<S>
      ) {
        return useFormV4({ schema, key: 'v4', defaultValues })
      }
      const form = makeForm(z.object({ name: z.string() }), { name: '' })
      expectTypeOf(form.values.name).toEqualTypeOf<string>()
    }
    void _neverInvoked
  })

  it('compiles a generic wrapper over the v3 entry (full v3 parity)', () => {
    function _neverInvoked() {
      function makeForm<S extends zV3.ZodObject<zV3.ZodRawShape>>(
        schema: S,
        defaultValues: zV3.input<S>
      ) {
        return useFormV3({ schema, key: 'v3', defaultValues })
      }
      const form = makeForm(zV3.object({ email: zV3.string(), age: zV3.number() }), {
        email: '',
        age: 0,
      })
      expectTypeOf(form.values.email).toEqualTypeOf<string>()
      expectTypeOf(form.values.age).toEqualTypeOf<number>()
    }
    void _neverInvoked
  })

  it('forwards sync and async defaultValues factories through a generic wrapper', () => {
    function _neverInvoked() {
      function makeSync<S extends z.ZodObject<z.ZodRawShape>>(
        schema: S,
        defaults: () => z.input<S>
      ) {
        return useFormUnified({ schema, key: 'sync', defaultValues: defaults })
      }
      function makeAsyncV3<S extends zV3.ZodObject<zV3.ZodRawShape>>(
        schema: S,
        defaults: () => Promise<zV3.input<S>>
      ) {
        return useFormV3({ schema, key: 'async', defaultValues: defaults })
      }
      void makeSync
      void makeAsyncV3
    }
    void _neverInvoked
  })

  it('still rejects a wrongly-typed default at concrete call sites (both majors)', () => {
    function _neverInvoked() {
      const v4Schema = z.object({ email: z.string() })
      const v3Schema = zV3.object({ email: zV3.string() })
      // The directive sits on the call: the unified entry surfaces a bad
      // default as TS2769 (no overload matches) anchored at the call, not at
      // the `defaultValues` property.
      // @ts-expect-error number is not assignable to the string input slot
      useFormV4({ schema: v4Schema, key: 'neg-v4', defaultValues: { email: 123 } })
      // @ts-expect-error number is not assignable to the string input slot
      useFormV3({ schema: v3Schema, key: 'neg-v3', defaultValues: { email: 123 } })
      // @ts-expect-error number is not assignable to the string input slot
      useFormUnified({ schema: v4Schema, key: 'neg-unified', defaultValues: { email: 123 } })
    }
    void _neverInvoked
  })

  it('preserves the intentional defaultValues widening (input shape, not parsed)', () => {
    function _neverInvoked() {
      // z.email() input is `string`; an invalid-but-string default is accepted —
      // defaultValues reflects an in-progress form, sharp types land at submit.
      useFormV4({
        schema: z.object({ email: z.email() }),
        key: 'wide',
        defaultValues: { email: 'oz' },
      })
      // partial defaults stay allowed (DefaultValuesInput is partial + Unset-widened)
      useFormV3({
        schema: zV3.object({ email: zV3.string(), age: zV3.number() }),
        key: 'partial',
        defaultValues: { email: 'a' },
      })
    }
    void _neverInvoked
  })
})
