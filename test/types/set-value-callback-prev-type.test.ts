import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { useForm } from '../../src/zod-v4'

/**
 * Type-level regression for the `setValue` callback's `prev` parameter.
 *
 * `setValue('count', x => x + 2)` against a `z.number()` schema must
 * give the callback a `prev: number`. After widening
 * `DefaultValuesShape<T>` to admit `Unset` at every position, the
 * `PathSetValuePayload` composition needs to keep the callback's
 * `Read` arg strict so consumers can do arithmetic on `prev` without
 * tripping on the `Unset` sentinel that's exclusively an INPUT
 * symbol (storage never holds it).
 *
 * Mirrors the playground report at PR #211's review.
 */

describe('setValue callback `prev` stays strict against the schema slim', () => {
  it('plain z.number() leaf: prev is number, arithmetic compiles', () => {
    function _neverInvoked() {
      const form = useForm({
        schema: z.object({ count: z.number() }),
        key: 'set-value-callback-plain-number',
      })
      // Should compile cleanly: prev is `number`, not `number | Unset`.
      form.setValue('count', (prev) => {
        expectTypeOf(prev).toEqualTypeOf<number>()
        return prev + 2
      })
    }
    void _neverInvoked
  })

  it('z.number().default(N) leaf: prev is still number, arithmetic compiles', () => {
    function _neverInvoked() {
      const form = useForm({
        schema: z.object({ count: z.number().default(10) }),
        key: 'set-value-callback-default-number',
      })
      // `.default(N)` makes the input shape `number | undefined`, but
      // the callback's prev still narrows to the slim/non-nullable
      // type — `+ 2` must compile without casts.
      form.setValue('count', (prev) => {
        expectTypeOf(prev).toEqualTypeOf<number>()
        return prev + 2
      })
    }
    void _neverInvoked
  })

  it('z.string() leaf: prev is string', () => {
    function _neverInvoked() {
      const form = useForm({
        schema: z.object({ email: z.string() }),
        key: 'set-value-callback-plain-string',
      })
      form.setValue('email', (prev) => {
        expectTypeOf(prev).toEqualTypeOf<string>()
        return prev.toUpperCase()
      })
    }
    void _neverInvoked
  })

  it('z.boolean() leaf: prev is boolean', () => {
    function _neverInvoked() {
      const form = useForm({
        schema: z.object({ notify: z.boolean() }),
        key: 'set-value-callback-plain-boolean',
      })
      form.setValue('notify', (prev) => {
        expectTypeOf(prev).toEqualTypeOf<boolean>()
        return !prev
      })
    }
    void _neverInvoked
  })

  it('mixed-default schema (matches the playground report)', () => {
    function _neverInvoked() {
      const schema = z.object({
        notify: z.boolean().default(true),
        count: z.number().default(10),
        tag: z.string().default('untitled'),
      })
      const bare = useForm({ schema, key: 'docs-demo-schema-defaults-bare' })
      // All three callbacks must compile against the schema's slim
      // type without `| Unset` leaking into the prev parameter.
      bare.setValue('count', (x) => {
        expectTypeOf(x).toEqualTypeOf<number>()
        return x + 2
      })
      bare.setValue('notify', (x) => {
        expectTypeOf(x).toEqualTypeOf<boolean>()
        return !x
      })
      bare.setValue('tag', (x) => {
        expectTypeOf(x).toEqualTypeOf<string>()
        return x.toUpperCase()
      })
    }
    void _neverInvoked
  })
})
