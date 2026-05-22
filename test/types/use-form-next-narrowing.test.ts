import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormZ } from '../../src/zod'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import type { NormalizedNext } from '../../src/runtime/types/types-wizard'

/**
 * Type-level tests for `useForm({ next })` narrowing.
 *
 *  - `pick`'s `parsed` argument is the schema's `z.output` shape.
 *  - `pick`'s return type narrows to `(typeof forms)[number] | undefined`
 *    when `forms` is declared with `as const`; widens to `AnyForm` when
 *    `as const` is missing.
 *  - `form.next` on the return surface is `NormalizedNext | undefined`
 *    regardless of which entry point produced the form.
 *
 * All three entry points (`attaform/zod`, `attaform/zod-v3`,
 * `attaform/zod-v4`) get the same coverage. Tests run at typecheck
 * time — the wrapper functions are never invoked.
 */

const schemaV4 = z.object({
  role: z.enum(['admin', 'user']),
})

const schemaV3 = zV3.object({
  role: zV3.enum(['admin', 'user']),
})

describe('useForm({ next }) — type narrowing', () => {
  describe('attaform/zod (unified)', () => {
    it('typing pick(parsed) against the schema output', () => {
      function _neverInvoked() {
        const admin = useFormZ({ schema: schemaV4, key: 'admin' })
        const user = useFormZ({ schema: schemaV4, key: 'user' })
        useFormZ({
          schema: schemaV4,
          key: 'account',
          next: {
            pick: (parsed) => {
              expectTypeOf(parsed).toEqualTypeOf<{ role: 'admin' | 'user' }>()
              return parsed.role === 'admin' ? admin : user
            },
            forms: [admin, user] as const,
          },
        })
      }
      void _neverInvoked
    })

    it('exposes `form.next` as `NormalizedNext | undefined`', () => {
      function _neverInvoked() {
        const form = useFormZ({ schema: schemaV4 })
        expectTypeOf(form.next).toEqualTypeOf<NormalizedNext | undefined>()
      }
      void _neverInvoked
    })

    it('accepts an identity ref as `next`', () => {
      function _neverInvoked() {
        const target = useFormZ({ schema: schemaV4, key: 'target' })
        useFormZ({ schema: schemaV4, key: 'source', next: target })
      }
      void _neverInvoked
    })
  })

  describe('attaform/zod-v4', () => {
    it('typing pick(parsed) against the schema output', () => {
      function _neverInvoked() {
        const admin = useFormV4({ schema: schemaV4, key: 'admin' })
        const user = useFormV4({ schema: schemaV4, key: 'user' })
        useFormV4({
          schema: schemaV4,
          key: 'account',
          next: {
            pick: (parsed) => {
              expectTypeOf(parsed).toEqualTypeOf<{ role: 'admin' | 'user' }>()
              return parsed.role === 'admin' ? admin : user
            },
            forms: [admin, user] as const,
          },
        })
      }
      void _neverInvoked
    })

    it('exposes `form.next` as `NormalizedNext | undefined`', () => {
      function _neverInvoked() {
        const form = useFormV4({ schema: schemaV4 })
        expectTypeOf(form.next).toEqualTypeOf<NormalizedNext | undefined>()
      }
      void _neverInvoked
    })
  })

  describe('attaform/zod-v3', () => {
    it('typing pick(parsed) against the schema output', () => {
      function _neverInvoked() {
        const admin = useFormV3({ schema: schemaV3, key: 'admin' })
        const user = useFormV3({ schema: schemaV3, key: 'user' })
        useFormV3({
          schema: schemaV3,
          key: 'account',
          next: {
            pick: (parsed) => {
              expectTypeOf(parsed).toEqualTypeOf<{ role: 'admin' | 'user' }>()
              return parsed.role === 'admin' ? admin : user
            },
            forms: [admin, user] as const,
          },
        })
      }
      void _neverInvoked
    })

    it('exposes `form.next` as `NormalizedNext | undefined`', () => {
      function _neverInvoked() {
        const form = useFormV3({ schema: schemaV3 })
        expectTypeOf(form.next).toEqualTypeOf<NormalizedNext | undefined>()
      }
      void _neverInvoked
    })
  })
})
