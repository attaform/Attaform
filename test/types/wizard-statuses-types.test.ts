import { describe, expectTypeOf, it } from 'vitest'
import type {
  WizardAggregateError,
  FormStatus,
  WizardStatusesProxy,
} from '../../src/runtime/types/types-wizard'

/**
 * Type-level checks for the wizard's status surface. `FormStatus` is
 * the per-form summary derived from `form.meta`. `wizard.statuses` and
 * the `defaultStatuses` seed option are loosely keyed
 * (`Record<string, FormStatus>`) — cross-component graphs threaded
 * through `injectWizard` lose lexical key knowledge, so the public
 * surface settles on the loose shape. `WizardAggregateError` is the
 * flattened shape returned by `wizard.allErrors`. `WizardStatusesProxy`
 * mirrors the call-or-read pattern from `form.values` but at a single
 * depth.
 */

describe('wizard status types', () => {
  it('FormStatus has valid / dirty / submitted / errorCount / locked / gate fields', () => {
    expectTypeOf<FormStatus>().toEqualTypeOf<{
      readonly valid: boolean
      readonly dirty: boolean
      readonly submitted: boolean
      readonly errorCount: number
      readonly locked: boolean
      readonly gate: 'cleared' | 'uncleared' | null
    }>()
  })

  it('WizardAggregateError carries formKey / path / message / optional code', () => {
    expectTypeOf<WizardAggregateError>().toEqualTypeOf<{
      readonly formKey: string
      readonly path: ReadonlyArray<string | number>
      readonly message: string
      readonly code?: string
    }>()
  })

  it('WizardStatusesProxy carries both call and read surfaces', () => {
    type StatusMap = Record<string, FormStatus>
    type Proxy = WizardStatusesProxy<StatusMap>
    function _neverInvoked() {
      const proxy = ((..._args: unknown[]) => ({})) as Proxy
      const _status = proxy['a']
      expectTypeOf<typeof _status>().toMatchTypeOf<FormStatus | undefined>()
      const _fromCall = proxy('a')
      expectTypeOf<typeof _fromCall>().toMatchTypeOf<FormStatus | StatusMap>()
      const _all = proxy()
      expectTypeOf<typeof _all>().toMatchTypeOf<FormStatus | StatusMap>()
    }
    void _neverInvoked
  })
})
