import type { ShouldShowErrors, ShouldShowErrorsConfig } from '../types/types-api'

/**
 * Library-default heuristic for `shouldShowErrors`. Drives
 * `field.showErrors` and `form.meta.showErrors` whenever the consumer
 * has not configured an override at either the plugin or per-form
 * level.
 *
 * Four clauses: the first two are hard gates; clause 3 is an
 * aggressive override after the first submit attempt; clause 4 is
 * the pre-submit timing gate.
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
 * 2. **Not currently validating.** While the field is mid-revalidation
 *    (`field.validating === true`) the verdict in `field.errors` is
 *    stale by definition. The error itself stays in the store under
 *    the stale-while-revalidate contract so the surface doesn't
 *    flicker to empty, but the UX gate hides it: the application is
 *    actively re-checking, so the message would mis-narrate the
 *    state of the world. Containers roll up `validating` as a
 *    disjunction, so any descendant under revalidation hides the
 *    container's `showErrors` too. The error returns the moment the
 *    new verdict lands and `validating` flips back to false.
 *
 * 3. **Post-submit override.** Two arms both surface every own-path
 *    error unconditionally on the field axis (subject only to the two
 *    gates above):
 *
 *    The `submissionAttempts` arm fires when the consumer ran
 *    `handleSubmit`: they asked the form to commit, so transient
 *    mid-edit hiding is no longer appropriate. Covers focused,
 *    pristine, and untouched fields alike.
 *
 *    The `departAttempts` arm fires when wizard navigation
 *    (`wizard.next`, `wizard.back`, `wizard.goTo`) actually left this
 *    form AND the user has interacted with at least one field on it
 *    (`formMeta.touched === true`). The touched gate guards against
 *    lateral exploration: a rail-click across an untouched form and
 *    back shouldn't surface errors the user never triggered. Once
 *    they engage with a field (focus + blur is enough), departing the
 *    form reveals every error on the next visit — including
 *    never-touched siblings. Covers the review-surface UX cleanly:
 *    by the time the user reaches a later step, every prior touched
 *    step lights up.
 *
 * 4. **Pre-submit timing gate.** Before the first submit attempt,
 *    show once the user has touched the field (sticky-true after the
 *    first blur) AND is not currently focused on it. The not-focused
 *    half hides transient errors while the user is actively editing
 *    the field; they reappear when the user blurs (or focuses a
 *    sibling). This deliberately includes blur-without-typing on a
 *    required field (touched flips on blur regardless of `dirty`), so
 *    a user who visits an empty required field and moves on sees the
 *    error.
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
  if (field.validating === true) return false
  if (formMeta.submissionAttempts > 0) return true
  if (formMeta.departAttempts > 0 && formMeta.touched === true) return true
  return field.touched === true && field.focused !== true
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
