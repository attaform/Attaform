/**
 * The Vuelidate field slice the bench binds. `$model` is Vuelidate's two-way
 * model: reading it subscribes to this field, assigning it writes the state and
 * marks the field dirty. `$error` is read in the template so Vuelidate's
 * lazy-computed validation actually runs each keystroke (and mirrors the
 * idiomatic error-display path).
 */
export interface VuelidateField {
  $model: string
  readonly $error: boolean
  $touch(): void
  $validate(): Promise<boolean>
}

/** The `v$.value` root the adapter reaches through. */
export interface VuelidateRoot {
  $validate(): Promise<boolean>
}
