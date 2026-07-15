import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { useForm } from '../../src/zod-v4'
import { gate, lazy, useWizard } from '../../src'
import type { AnyForm } from '../../src'

/**
 * Type-level contract for `gate(step)`: a gate is transparent to the
 * compiled step's type. It changes runtime reachability, never the static
 * shape, so `wizard.forms` and the `currentStep` non-empty narrowing must
 * both see through it. The payoff is commutativity — `gate(lazy(s))` and
 * `lazy((ctx) => gate(s))` type identically, mirroring the runtime.
 *
 * `_neverInvoked` wrappers exercise call-site inference without a Vue app
 * context; the assertions live in the types, checked by `pnpm typecheck`.
 */

const consentSchema = z.object({ accepted: z.boolean() })
const shippingSchema = z.object({ addr: z.string() })

describe('gate() type transparency', () => {
  it('keeps a gated form contributing its key + concrete type to wizard.forms', () => {
    function _neverInvoked() {
      const consent = useForm({ schema: consentSchema, key: 'consent' as const })
      const shipping = useForm({ schema: shippingSchema, key: 'shipping' as const })

      const wizard = useWizard({ steps: [gate(consent), shipping] })

      // gate(form) is a guaranteed step, so currentStep is non-undefined.
      expectTypeOf(wizard.currentStep).toEqualTypeOf<string>()
      // Transparency: the gated form's schema-derived field types still
      // drill through `wizard.forms`.
      expectTypeOf(wizard.forms.consent.values.accepted).toEqualTypeOf<boolean>()
      expectTypeOf(wizard.forms.shipping.values.addr).toEqualTypeOf<string>()
    }
    void _neverInvoked
  })

  it('keeps a gated affordance string contributing its key as AnyForm', () => {
    function _neverInvoked() {
      const shipping = useForm({ schema: shippingSchema, key: 'shipping' as const })

      const wizard = useWizard({ steps: [gate('welcome'), shipping] })

      // A guaranteed step (string) is present, so currentStep narrows.
      expectTypeOf(wizard.currentStep).toEqualTypeOf<string>()
      expectTypeOf(wizard.forms.welcome).toMatchTypeOf<AnyForm>()
    }
    void _neverInvoked
  })

  it('stays maybe-absent when the only step is gate(lazy(fn))', () => {
    function _neverInvoked() {
      const consent = useForm({ schema: consentSchema, key: 'consent' as const })

      const wizard = useWizard({ steps: [gate(lazy(() => consent))] })

      // A lazy slot may resolve to nothing; a gate around it is transparent,
      // so the tuple is not statically non-empty → honest `| undefined`.
      expectTypeOf(wizard.currentStep).toEqualTypeOf<string | undefined>()
    }
    void _neverInvoked
  })

  it('types gate(lazy(fn)) and lazy(ctx => gate(fn)) identically (commutativity)', () => {
    function _neverInvoked() {
      const consent = useForm({ schema: consentSchema, key: 'consent' as const })

      const gateOfLazy = useWizard({ steps: [gate(lazy(() => consent))] })
      const lazyOfGate = useWizard({ steps: [lazy(() => gate(consent))] })

      // Both compositions collapse to the same maybe-absent shape.
      expectTypeOf(gateOfLazy.currentStep).toEqualTypeOf<string | undefined>()
      expectTypeOf(lazyOfGate.currentStep).toEqualTypeOf<string | undefined>()
      expectTypeOf(gateOfLazy.currentStep).toEqualTypeOf(lazyOfGate.currentStep)
    }
    void _neverInvoked
  })

  it('sees through a doubly-wrapped gate(gate(form))', () => {
    function _neverInvoked() {
      const consent = useForm({ schema: consentSchema, key: 'consent' as const })

      const wizard = useWizard({ steps: [gate(gate(consent))] })

      // Nested gates unwrap recursively: still a guaranteed form step.
      expectTypeOf(wizard.currentStep).toEqualTypeOf<string>()
      expectTypeOf(wizard.forms.consent.values.accepted).toEqualTypeOf<boolean>()
    }
    void _neverInvoked
  })
})
