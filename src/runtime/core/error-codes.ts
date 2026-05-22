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
 *   onto a `ValidationError` (via the `parseApiErrors` wire payload
 *   or `setFieldErrors` directly). Pick a scope (`api:`, `auth:`,
 *   etc.) and stay consistent.
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
} as const

export type AttaformErrorCode = (typeof AttaformErrorCode)[keyof typeof AttaformErrorCode]
