import { useRegle } from '@regle/core'
import { minLength } from '@regle/rules'
import { nativeRulesFor, nestRules, shapeFor } from '../../shared/scenarios'
import type { NativeRule } from '../../shared/scenarios'
import type { BenchAdapter } from '../contract'
import { mountRegle } from './shared'
import type { RegleRoot } from './types'

/** Map one scenario rule to Regle's native validator set. */
function toRegleRule(rule: NativeRule): Record<string, unknown> {
  return rule.minLength !== undefined ? { minLength: minLength(rule.minLength) } : {}
}

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
    const shape = shapeFor(opts.scenario, opts.params)
    // Object-leaf rules nest to mirror the value tree (Regle keys rules by
    // structure, not by dotted path), built from the scenario's flat rules.
    const rules = nestRules(nativeRulesFor(opts.scenario, opts.params), toRegleRule)
    // An array scenario adds a `$each` collection rule for the row field, the
    // field-granular path Regle validates a list through.
    if (shape.arrayPath && shape.arrayItemRules) {
      const each: Record<string, unknown> = {}
      for (const [field, rule] of Object.entries(shape.arrayItemRules))
        each[field] = toRegleRule(rule)
      rules[shape.arrayPath] = { $each: each }
    }
    return mountRegle(container, opts, (state) => {
      const { r$ } = useRegle(state as never, rules as never) as unknown as { r$: RegleRoot }
      return r$
    })
  },
}
