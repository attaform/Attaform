/**
 * The Regle field-status slice the bench binds. `$value` is the model reference
 * Regle exposes for v-model: reading it subscribes to this field alone, and
 * assigning it marks the field dirty and runs Regle's reactive validation.
 * Common to schema mode (whole Standard Schema re-parse) and rules mode (this
 * field's native rules only).
 */
export interface RegleField {
  $value: string
  $touch(): void
  $validate(): Promise<unknown>
  /** Present on nested-object field statuses; the children keyed by segment.
   *  The path walker descends through these to reach a deep leaf status. */
  readonly $fields?: Record<string, RegleField>
}

/** The `r$` root the adapter reaches through: its per-field status map + the
 *  whole-form validate. */
export interface RegleRoot {
  readonly $fields: Record<string, RegleField>
  $validate(): Promise<unknown>
}
