/**
 * Path-addressed reads of a `FormStore`, for tests.
 *
 * The store keys its per-path maps by canonical `PathKey` and exposes
 * `*ByKey` accessors, because every runtime caller already holds the key
 * and a second `canonicalizePath` per read showed up on the field-state
 * hot path. It used to also carry path-taking wrappers, which nothing
 * but these assertions still called, shipped bytes kept alive by the
 * test suite. Canonicalising here instead keeps the assertions reading
 * in path terms without the store paying for it.
 */
import { canonicalizePath, type Path } from '../../src/runtime/core/paths'
import type { FormStore } from '../../src/runtime/core/create-form-store'
import type { GenericForm } from '../../src/runtime/types/types-core'

type AnyStore = Pick<FormStore<GenericForm>, 'originals' | 'isPristineAtPathByKey'>

/** The baseline value recorded for `path` at construction, if any. */
export function originalAt(store: AnyStore, path: Path): unknown {
  return store.originals.get(canonicalizePath(path).key)?.value
}

/** Whether `path` still matches the baseline recorded for it. */
export function pristineAt(store: AnyStore, path: Path): boolean {
  const { key, segments } = canonicalizePath(path)
  return store.isPristineAtPathByKey(key, segments)
}
