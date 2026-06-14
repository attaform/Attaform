import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormZ } from '../../src/zod'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import type { GetDisplayState } from '../../src/runtime/types/types-api'

/**
 * SF2 parity gate. v3-direct (`attaform/zod-v3`) historically carried
 * a hand-rolled `UseFormConfigurationWithZod` that listed every option
 * by hand and silently dropped fields v4 + the abstract
 * `UseFormConfiguration` accept: `getDisplayState`, `maxRecursionDepth`,
 * `autoAria`. Runtime already spread the full config through to
 * `useAbstractForm`, so the gap was purely type-level — v3-direct
 * callers got an excess-property error on options that worked at runtime.
 *
 * The dual-green proof: every typed entry point (`attaform/zod`,
 * `attaform/zod-v3`, `attaform/zod-v4`) accepts the same fields with no
 * excess-property errors. Runs at typecheck time only — the
 * `_neverInvoked` wrappers declare real calls so TypeScript exercises
 * call-site inference, but the functions are never invoked.
 */

const schemaV4 = z.object({ email: z.string() })
const schemaV3 = zV3.object({ email: zV3.string() })

const getDisplayState: GetDisplayState = () => ({ display: 'idle' })

describe('useForm — typed-config field surface (SF2)', () => {
  describe('attaform/zod-v3', () => {
    it('accepts getDisplayState', () => {
      function _neverInvoked() {
        const form = useFormV3({ schema: schemaV3, getDisplayState })
        expectTypeOf(form.key).toMatchTypeOf<string>()
      }
      void _neverInvoked
    })

    it('accepts maxRecursionDepth', () => {
      function _neverInvoked() {
        const form = useFormV3({ schema: schemaV3, maxRecursionDepth: 128 })
        expectTypeOf(form.key).toMatchTypeOf<string>()
      }
      void _neverInvoked
    })

    it('accepts autoAria', () => {
      function _neverInvoked() {
        const form = useFormV3({ schema: schemaV3, autoAria: false })
        expectTypeOf(form.key).toMatchTypeOf<string>()
      }
      void _neverInvoked
    })

    it('accepts all three together', () => {
      function _neverInvoked() {
        const form = useFormV3({
          schema: schemaV3,
          key: 'composed',
          getDisplayState,
          maxRecursionDepth: 96,
          autoAria: false,
        })
        expectTypeOf(form.key).toEqualTypeOf<'composed'>()
      }
      void _neverInvoked
    })
  })

  describe('attaform/zod-v4', () => {
    it('accepts all three together (reference)', () => {
      function _neverInvoked() {
        const form = useFormV4({
          schema: schemaV4,
          key: 'composed',
          getDisplayState,
          maxRecursionDepth: 96,
          autoAria: false,
        })
        expectTypeOf(form.key).toEqualTypeOf<'composed'>()
      }
      void _neverInvoked
    })
  })

  describe('attaform/zod (unified)', () => {
    it('accepts all three together on a v3 schema', () => {
      function _neverInvoked() {
        const form = useFormZ({
          schema: schemaV3,
          key: 'composed-v3',
          getDisplayState,
          maxRecursionDepth: 96,
          autoAria: false,
        })
        expectTypeOf(form.key).toEqualTypeOf<'composed-v3'>()
      }
      void _neverInvoked
    })

    it('accepts all three together on a v4 schema', () => {
      function _neverInvoked() {
        const form = useFormZ({
          schema: schemaV4,
          key: 'composed-v4',
          getDisplayState,
          maxRecursionDepth: 96,
          autoAria: false,
        })
        expectTypeOf(form.key).toEqualTypeOf<'composed-v4'>()
      }
      void _neverInvoked
    })
  })
})
