import { useRegle } from '@regle/core'
import { minLength } from '@regle/rules'
import { nativeRulesFor, nestRules } from '../../shared/scenarios'
import type { BenchAdapter } from '../contract'
import { mountRegle } from './shared'
import type { RegleRoot } from './types'

/**
 * Regle in rules mode: native validators ride on each field, so a keystroke
 * runs only the changed field's rules (the field-granular fast path), not a
 * whole-tree parse. Shown next to schema mode so neither is strawmanned: same
 * library, same binding, different validation strategy.
 */
export const regleRulesAdapter: BenchAdapter = {
  meta: {
    id: 'regle-rules',
    displayName: 'Regle (rules)',
    layer: 'headless-validation-only',
    schemaLib: 'native',
    ownsInputs: false,
    capabilities: {
      flat: 'native',
      nested: 'native',
      arrays: 'native',
      grid: 'native',
      'discriminated-union': 'hand-rolled',
      massive: 'native',
      wizard: 'hand-rolled',
    },
  },

  mount(container, opts) {
    // Native rules nest to mirror the value tree (Regle keys rules by structure,
    // not by dotted path), built from the scenario's flat rule description.
    const rules = nestRules(nativeRulesFor(opts.scenario, opts.params), (rule) =>
      rule.minLength !== undefined ? { minLength: minLength(rule.minLength) } : {}
    )
    return mountRegle(container, opts, (state) => {
      const { r$ } = useRegle(state as never, rules as never) as unknown as { r$: RegleRoot }
      return r$
    })
  },
}
