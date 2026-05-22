import type { ShouldShowErrors, ShouldShowErrorsConfig } from '../types/types-api'

/**
 * Library-default heuristic for `shouldShowErrors`. Drives
 * `field.showErrors` and `form.meta.showErrors` whenever the consumer
 * has not configured an override at either the plugin or per-form
 * level.
 *
 * Two clauses, both required to return true:
 *
 * 1. **Own-path filter.** The field must have at least one error whose
 *    path equals the field's own path. Leaves always satisfy this when
 *    they have errors. Containers (intermediate or root) only satisfy
 *    it for errors that point directly at them, so a UI rendering
 *    `field.showErrors` at a container never duplicates errors that a
 *    more-specific descendant will already render. Aggregate banners
 *    that want "any error anywhere passed the gate" should bind to
 *    `form.meta.errorCount > 0` (paired with whatever timing signal
 *    fits), not to `form.meta.showErrors`.
 *
 * 2. **Timing gate.** Show after the first submit attempt, OR once the
 *    user has touched the field (sticky-true after the first blur) AND
 *    is not currently focused on it. The not-focused half hides
 *    transient errors while the user is actively editing the field;
 *    they reappear when the user blurs (or focuses a sibling). This
 *    deliberately includes blur-without-typing on a required field
 *    (touched flips on blur regardless of `dirty`), so a user who
 *    visits an empty required field and moves on sees the error.
 *
 * The framework already gates on `errors.length > 0` before invoking
 * the predicate, so the body only decides *when* to surface existing
 * errors, not whether errors exist.
 *
 * Public re-export so adopters can compose with this without
 * copy-pasting the rule body. A layered predicate that adds a special
 * case but otherwise defers to the library default picks up future
 * heuristic refinements automatically:
 *
 * ```ts
 * import { defaultShouldShowErrors } from 'attaform'
 *
 * useForm({
 *   schema,
 *   shouldShowErrors: (field, formMeta) =>
 *     field.path[0] === 'urgent' || defaultShouldShowErrors(field, formMeta),
 * })
 * ```
 */
export const defaultShouldShowErrors: ShouldShowErrors = (field, formMeta) => {
  const hasOwnError = field.errors.some(
    (e) => e.path.length === field.path.length && e.path.every((s, i) => s === field.path[i])
  )
  if (!hasOwnError) return false
  return formMeta.submitCount > 0 || (field.touched === true && field.focused !== true)
}

const SHOW_ALWAYS: ShouldShowErrors = () => true
const SHOW_NEVER: ShouldShowErrors = () => false

/**
 * Resolve a `ShouldShowErrorsConfig` (function | boolean | undefined)
 * to a concrete `ShouldShowErrors` predicate. Boolean shorthand lifts
 * to a constant predicate; `undefined` falls back to the library
 * default. Called once at form construction; the resolved predicate
 * is then stored on `FormStore` for the field-state computeds.
 */
export function resolveShouldShowErrors(
  config: ShouldShowErrorsConfig | undefined
): ShouldShowErrors {
  if (config === undefined) return defaultShouldShowErrors
  if (config === true) return SHOW_ALWAYS
  if (config === false) return SHOW_NEVER
  return config
}
