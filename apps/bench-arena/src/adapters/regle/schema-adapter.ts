import { useRegleSchema } from '@regle/schemas'
import { zodSchemaFor } from '../../shared/scenarios'
import type { BenchAdapter } from '../contract'
import { mountRegle } from './shared'
import type { RegleRoot } from './types'

/**
 * Regle in schema mode: a Standard Schema (zod v3) drives validation over the
 * harness-owned reactive state. Every keystroke re-parses the whole schema, the
 * trade-off for a single source of truth; the keystroke latency captures it.
 * Shown alongside rules mode so the field-granular fast path is never strawmanned.
 */
export const regleSchemaAdapter: BenchAdapter = {
  meta: {
    id: 'regle-schema',
    displayName: 'Regle (schema)',
    layer: 'headless-validation-only',
    schemaLib: 'zod3',
    ownsInputs: false,
    capabilities: {
      flat: 'native',
      nested: 'native',
      arrays: 'native',
      grid: 'native',
      'discriminated-union': 'native',
      massive: 'native',
      wizard: 'hand-rolled',
    },
  },

  mount(container, opts) {
    const schema = zodSchemaFor(opts.scenario, opts.params)
    return mountRegle(container, opts, (state) => {
      const { r$ } = useRegleSchema(state as never, schema as never) as unknown as { r$: RegleRoot }
      return r$
    })
  },
}
