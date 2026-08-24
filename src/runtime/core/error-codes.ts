import type { Path } from './paths'
import type { ValidationError } from '../types/types-api'

/**
 * Stable identifiers for library-emitted `ValidationError` codes.
 *
 * Convention: `<scope>:<kebab-case-identifier>`. Three scopes are
 * recognised by the library:
 *
 * - `atta:` — emitted by the framework-agnostic core (this map).
 * - `zod:` — emitted by the Zod adapter; computed inline from
 *   `issue.code` (e.g. `zod:too_small`). No enum here because
 *   Zod's code list evolves.
 * - consumer-defined — anything the consumer's backend / app stamps
 *   onto a `ValidationError` (a server response handed to `setErrors`,
 *   or a code passed inline). Pick a scope (`api:`, `auth:`, etc.) and
 *   stay consistent.
 *
 * Use these constants in tests and error-routing UI:
 *
 * ```ts
 * if (error.code === AttaformErrorCode.NoValueSupplied) {
 *   // user hasn't filled this field
 * }
 * ```
 */
export const AttaformErrorCode = {
  /** A required field is in the blank set — user hasn't supplied a value. */
  NoValueSupplied: 'atta:no-value-supplied',
  /** The schema adapter's `validateAtPath` threw synchronously. */
  AdapterThrew: 'atta:adapter-threw',
  /**
   * User code inside a `z.preprocess`, `.refine`, or `.transform`
   * threw (sync or async). The adapter caught the throw and surfaced
   * it as a `ValidationError` at the field path so the form's normal
   * error pipeline handles it instead of leaking as an unhandled
   * rejection or routing through `submitError`.
   */
  ValidatorThrew: 'atta:validator-threw',
  /**
   * A function-form `defaultValues` factory threw or its promise
   * rejected. The runtime captures the raw error on `form.hydrateError`
   * and ALSO surfaces a form-level `ValidationError` (path `[]`) so
   * the standard error pipeline carries the signal. Critical for the
   * SSR round-trip: `hydrateError` itself does not ride the wire
   * payload, but `schemaErrors` does, so the client sees the failure
   * after rehydration without an extra channel.
   */
  HydrationFailed: 'atta:hydration-failed',
  /** The supplied path didn't resolve to any node in the schema. */
  PathNotFound: 'atta:path-not-found',
  /**
   * A walked form's `activate()` (async `defaultValues` factory) threw
   * during `wizard.handleSubmit`'s path walk. Surfaced as a synthetic
   * `ValidationError` at the form-level path (`[]`) so the wizard's
   * aggregate error pipeline can carry the failure alongside ordinary
   * validation errors. The raw factory error remains on
   * `form.hydrateError` for retry UX.
   */
  ActivationFailed: 'atta:activation-failed',
  /**
   * Default code stamped on a manual error set through `form.setErrors`
   * when the caller omits an explicit `code`. The `setErrors` input is
   * lenient (`code` optional), so this is the fallback that keeps every
   * produced `ValidationError` carrying a stable, branchable identifier.
   * Override it per error by passing your own `code` (`api:…`, `auth:…`).
   */
  UserError: 'atta:user-error',
  /**
   * Stamped on a `ValidationError` synthesized from a throw or rejection
   * out of a `handleSubmit` `onSubmit` callback. The raw error also lands
   * on `form.meta.submitError` (a raw-`Error` inspection channel); this
   * code marks the copy piped into the user-error layer so the failure
   * also surfaces on `form.errors` / `meta.ownErrors` / `firstOwnError`
   * where the UI already reads. A throw carrying its own `path` / `code`
   * keeps them; a bare `Error` or a non-Error throw defaults here at the
   * form-level path `[]`.
   */
  SubmitError: 'atta:submit-error',
  /**
   * Synthesized by `wizard.handleSubmit` when the whole-wizard submit
   * would otherwise succeed but a `gate()` step is still uncleared. A
   * gate clears only on its member form's clean submit (confirmation), so
   * a downstream step that happens to be valid-by-default must not let the
   * wizard finish past an unconfirmed prerequisite. Emitted at the gate
   * form's key (path `[]`) so the aggregate error pipeline routes focus to
   * the gate, and `done` never latches.
   */
  GateNotCleared: 'atta:gate-not-cleared',
} as const

export type AttaformErrorCode = (typeof AttaformErrorCode)[keyof typeof AttaformErrorCode]

/**
 * The canonical "No value supplied" error for a required field currently in
 * the blank set. Single source of truth so the reactively-aggregated form
 * (`derivedBlankErrors`, create-form-store.ts) and the per-leaf field-state
 * synthesis (field-state-api.ts) emit a byte-identical entry — they read
 * different reactive channels (the whole-form blank Map vs. a leaf's own
 * `blankPaths.has(key)`) but must produce the same `ValidationError`.
 */
export function makeBlankRequiredError(segments: Path): ValidationError {
  return {
    message: 'No value supplied',
    path: [...segments],
    code: AttaformErrorCode.NoValueSupplied,
  }
}

/**
 * The shared frozen empty error list. An `ErrorCell` side with no
 * entries references this single array, so cell writers never allocate
 * for absence and readers can `length === 0` / spread it freely.
 */
export const NO_ERRORS: readonly ValidationError[] = Object.freeze([])
