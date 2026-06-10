/**
 * The slices of TanStack Vue Form the bench adapter drives. The benchmark's
 * schema is built dynamically (`z.ZodTypeAny`), which collapses TanStack's
 * per-path generics and blows the instantiation depth, so the adapter binds
 * against these narrow shapes while the runtime calls stay the real ones.
 */
export interface TanstackForm {
  /** Validate every field with the given cause; the full-form pass. */
  validateAllFields(cause: string): Promise<unknown[]>
  /** Validate one field by path. */
  validateField(name: string, cause: string): unknown
  /** Set a path's value, including a whole object at the union path (the flip). */
  setFieldValue(name: string, value: unknown): void
  /** Append a row to the array field (the array add/remove dimension). */
  pushFieldValue(name: string, value: unknown): void
  /** Remove the row at `index` from the array field. */
  removeFieldValue(name: string, index: number): Promise<void>
  /** Swap the rows at `a` and `b` in the array field (the reorder dimension). */
  swapFieldValues(name: string, a: number, b: number): void
}

/**
 * What `useField` returns: a reactive value read plus the change/blur funnels.
 * `state` is a getter over a computed, so reading `field.state.value` in the
 * template subscribes granularly to this field alone.
 */
export interface TanstackField {
  readonly state: { readonly value: string }
  readonly api: { handleChange(value: string): void; handleBlur(): void }
}
