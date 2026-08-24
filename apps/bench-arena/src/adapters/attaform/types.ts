/**
 * The slice of Attaform's form surface the bench adapter drives. The benchmark
 * builds the schema dynamically (`z.ZodTypeAny`), which erases the static
 * per-path generics, so the precise `FlatPath` types collapse; this narrow
 * shape keeps the binding honestly typed against the methods it actually calls.
 */
export interface AttaformForm {
  /** register(path).displayValue is the granular string the compile-time
   *  :value injection reads; used here purely for the per-field read. */
  register(path: string): { readonly displayValue: { readonly value: string } }
  /** The public write funnel (the same one v-register's input listener drives,
   *  and the render-isolation lock test exercises) - it updates displayValue
   *  reactively and validates per `validateOn`, so the edited field re-renders. */
  setValue(path: string, value: unknown): unknown
  /** Reactive validation status accessor; drives the blur-trigger keystroke. */
  validate(path?: string): unknown
  /** Awaitable whole-form (or subtree) validation that resolves when the pass
   *  completes - the parity with the cohort's awaited validate() for the
   *  validation-throughput dimension. */
  parse(path?: string | { commit?: boolean }, options?: { commit?: boolean }): Promise<unknown>
  /** Append a fresh row to the array at `path` (the array add/remove dimension). */
  append(path: string, value: unknown): unknown
  /** Remove the row at `index` from the array at `path`. */
  remove(path: string, index: number): unknown
  /** Swap the rows at `a` and `b` in the array at `path` (the reorder dimension). */
  swap(path: string, a: number, b: number): unknown
  /** The array at `path` as one entry per element, each carrying a stable `key`
   *  that follows its element across reorders. Reading it tracks the array
   *  length, so the rendered list reflows when a row is added or removed. */
  list(path: string): ReadonlyArray<{ readonly key: string | number }>
}
