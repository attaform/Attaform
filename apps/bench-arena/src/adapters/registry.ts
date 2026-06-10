import { attaformAdapter } from './attaform/adapter'
import type { BenchAdapter } from './contract'
import { formischAdapter } from './formisch/adapter'
import { formkitAdapter } from './formkit/adapter'
import { regleRulesAdapter } from './regle/rules-adapter'
import { regleSchemaAdapter } from './regle/schema-adapter'
import { tanstackAdapter } from './tanstack/adapter'
import { veeValidateAdapter } from './vee-validate/adapter'
import { vuelidateAdapter } from './vuelidate/adapter'

/**
 * Static adapter registry. The harness mounts exactly one adapter per page
 * load, selected by the `?adapter` query param, so no two libraries ever share
 * a heap. The full June 2026 cohort across all three fairness layers:
 * headless-form-state, headless-validation-only, and batteries-included.
 */
export const adapters: Record<string, BenchAdapter> = {
  [attaformAdapter.meta.id]: attaformAdapter,
  [veeValidateAdapter.meta.id]: veeValidateAdapter,
  [tanstackAdapter.meta.id]: tanstackAdapter,
  [formischAdapter.meta.id]: formischAdapter,
  [regleSchemaAdapter.meta.id]: regleSchemaAdapter,
  [regleRulesAdapter.meta.id]: regleRulesAdapter,
  [formkitAdapter.meta.id]: formkitAdapter,
  [vuelidateAdapter.meta.id]: vuelidateAdapter,
}
