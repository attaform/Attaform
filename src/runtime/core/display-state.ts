import type { GetDisplayState } from '../types/types-api'

/**
 * Library-default `getDisplayState` heuristic. Resolves every path's
 * `field.displayState` — and thus `field.show*` and the `form.meta`
 * rollups — whenever the consumer has not configured an override at the
 * per-form or plugin level.
 *
 * One timing gate, then precedence:
 *
 * 1. **Timing gate.** `gateOpen` once the form has been submitted
 *    (`submissionAttempts > 0`) OR the field has been edited and then
 *    left (`blurredAfterInteraction === true`). Before the gate opens
 *    the verdict is `'idle'` regardless of errors. This is the "reward
 *    early, punish late" rule:
 *      - A clean tab-through never engages. `blurredAfterInteraction`
 *        only flips on a blur that follows an edit, so visiting a field
 *        and moving on without editing it stays quiet until a submit
 *        forces the issue, even if the field was tabbed through before.
 *      - The first pass stays quiet. Editing alone (`interacted`) does
 *        not open the gate; the error reveals only once the user
 *        finishes that pass and leaves the field, never mid-entry.
 *      - Recovery is live. The bit is sticky and carries no not-focused
 *        term, so once a field has been revealed it stays open through a
 *        re-focus: a shown error clears (or greens) the instant the
 *        value becomes valid, without forcing another blur.
 *
 *    The submit arm covers `form.handleSubmit` directly and
 *    `wizard.handleSubmit` (which bumps `submissionAttempts` on the
 *    active form at intermediate steps and on every form at the final
 *    step, lighting up the whole flow at once).
 *
 * 2. **Pending.** With the gate open, a per-field run in flight
 *    (`validating === true`) wins: the verdict in `errors` is stale by
 *    definition, so surface `'pending'` (a spinner) rather than a
 *    possibly-wrong error or success. Containers roll `validating` up as
 *    a disjunction, so any descendant under revalidation reads
 *    `'pending'` at the container too.
 *
 * 3. **Error.** An own-path error (one whose path equals the field's own
 *    path) resolves to `'error'`. The own-path filter means a container
 *    never duplicates an error a more-specific descendant already
 *    renders; aggregate banners bind to `form.meta.errorCount` instead.
 *
 * 4. **Success.** No error, `valid === true`, and the green check is
 *    earned: the field is non-blank and `dirty` (its value diverges from
 *    the hydration original). Gating success on `dirty && !blank` keeps
 *    the check meaningful — an empty field that happens to pass, a
 *    pre-filled field merely tabbed through, and the post-submit flood of
 *    every valid field all stay `'idle'` rather than greening for free.
 *    `valid` already gates async schemas on the form-wide first
 *    validation pass, so success never fires before the first verdict
 *    lands.
 *
 * 5. **Idle.** Anything else — gate open but not validating, no own-path
 *    error, and either not yet `valid` or valid-but-unearned (blank or
 *    unchanged) — stays `'idle'`.
 *
 * Public re-export so adopters can compose with this without
 * copy-pasting the rule body — a layered predicate that special-cases a
 * subtree but otherwise defers picks up future refinements
 * automatically:
 *
 * ```ts
 * import { defaultDisplayState } from 'attaform'
 *
 * useForm({
 *   schema,
 *   getDisplayState: (field, formMeta) => {
 *     const state = defaultDisplayState(field, formMeta)
 *     return field.path[0] === 'username' && state === 'success' ? 'idle' : state
 *   },
 * })
 * ```
 */
export const defaultDisplayState: GetDisplayState = (field, formMeta) => {
  const gateOpen = formMeta.submissionAttempts > 0 || field.blurredAfterInteraction === true
  if (!gateOpen) return 'idle'
  if (field.validating === true) return 'pending'
  const hasOwnError = field.errors.some(
    (e) => e.path.length === field.path.length && e.path.every((s, i) => s === field.path[i])
  )
  if (hasOwnError) return 'error'
  if (field.valid === true && field.blank !== true && field.dirty === true) return 'success'
  return 'idle'
}

/**
 * Resolve a `getDisplayState` config (function | undefined) to a
 * concrete predicate. `undefined` falls back to the library default.
 * Called once at form construction; the resolved predicate is then
 * stored on `FormStore` for the field-state computeds to read directly.
 */
export function resolveGetDisplayState(config: GetDisplayState | undefined): GetDisplayState {
  return config ?? defaultDisplayState
}
