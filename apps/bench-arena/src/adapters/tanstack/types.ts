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
