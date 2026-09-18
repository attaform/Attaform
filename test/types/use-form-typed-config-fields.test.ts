import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormZ } from '../../src/zod'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'

/**
 * SF2 parity gate. v3-direct (`attaform/zod-v3`) historically carried
 * a hand-rolled `UseFormConfigurationWithZod` that listed every option
 * by hand and silently dropped fields v4 + the abstract
 * `UseFormConfiguration` accept. Runtime already spread the full config
 * through to `useAbstractForm`, so the gap was purely type-level,
 * v3-direct callers got an excess-property error on options that worked
 * at runtime.
 *
 * Every entry point now derives its config from the shared
 * `UseFormConfiguration` by `Omit`, so the drift is structurally
 * impossible; this gate stands against a hand-rolled list coming back.
 * The fields below are the ones a hand-rolled list is most likely to
 * miss: cross-cutting behaviour options rather than the four
 * (`schema` / `defaultValues` / `validateOn` / `debounceMs`) each entry
 * point re-declares for itself.
 *
 * The dual-green proof: every typed entry point (`attaform/zod`,
 * `attaform/zod-v3`, `attaform/zod-v4`) accepts the same fields with no
 * excess-property errors. Runs at typecheck time only: the
 * `_neverInvoked` wrappers declare real calls so TypeScript exercises
 * call-site inference, but the functions are never invoked.
 */

const schemaV4 = z.object({ email: z.string() })
const schemaV3 = zV3.object({ email: zV3.string() })

describe('useForm: typed-config field surface (SF2)', () => {
  describe('attaform/zod-v3', () => {
    it('accepts disabled', () => {
      function _neverInvoked() {
        const form = useFormV3({ schema: schemaV3, disabled: true })
        expectTypeOf(form.key).toMatchTypeOf<string>()
      }
      void _neverInvoked
    })

    it('accepts rememberVariants', () => {
      function _neverInvoked() {
        const form = useFormV3({ schema: schemaV3, rememberVariants: false })
        expectTypeOf(form.key).toMatchTypeOf<string>()
      }
      void _neverInvoked
    })

    it('accepts coerce', () => {
      function _neverInvoked() {
        const form = useFormV3({ schema: schemaV3, coerce: false })
        expectTypeOf(form.key).toMatchTypeOf<string>()
      }
      void _neverInvoked
    })

    it('accepts all three together', () => {
      function _neverInvoked() {
        const form = useFormV3({
          schema: schemaV3,
          key: 'composed',
          disabled: true,
          rememberVariants: false,
          coerce: false,
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
          disabled: true,
          rememberVariants: false,
          coerce: false,
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
          disabled: true,
          rememberVariants: false,
          coerce: false,
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
          disabled: true,
          rememberVariants: false,
          coerce: false,
        })
        expectTypeOf(form.key).toEqualTypeOf<'composed-v4'>()
      }
      void _neverInvoked
    })
  })
})
