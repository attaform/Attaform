/**
 * Dependency-free deep clone for freshly built Zod v3 schema instances.
 *
 * Replaces the former `lodash-es/cloneDeep` call in the discriminated-
 * union slim path (`getSlimSchema`). Each slimmed option is cloned to
 * de-share its structural `_def` graph before it is handed to
 * `z.discriminatedUnion`. Without that de-sharing, options that reference
 * the same nested schema object can form cyclic `_def` links that later
 * tree-walks (fingerprint, default derivation) recurse on indefinitely.
 *
 * The behaviour is matched to `cloneDeep` for this input shape:
 *
 *  - Plain objects, arrays, and class instances (the Zod schema nodes
 *    themselves) are recreated with their prototype preserved, so a
 *    cloned `ZodObject` stays a real `ZodObject`. Own enumerable string-
 *    and symbol-keyed properties are copied recursively.
 *  - Functions are carried by reference rather than cloned. A Zod v3
 *    schema holds functions in `_def` (the lazy `shape` thunk, refinement
 *    and transform callbacks) and binds its own methods (`parse`,
 *    `safeParse`, and the rest) as own properties in the constructor. A
 *    closure cannot be cloned, and carrying the reference is what
 *    `cloneDeep` does. The de-sharing that breaks the cycle is of the
 *    `_def` data tree, which is copied.
 *  - `RegExp` and `Date` (present in string and date check descriptors)
 *    are reconstructed so two cloned options never share a mutable
 *    instance.
 *  - Primitives are returned as-is.
 *
 * Cycles are handled with a `WeakMap` seen-cache, so a self-referential
 * schema clones without overflowing the stack.
 */
export function cloneSchemaDeep<T>(value: T): T {
  return clone(value, new WeakMap()) as T
}

function clone(value: unknown, seen: WeakMap<object, unknown>): unknown {
  // Primitives and functions: carry by reference. `typeof` is 'function'
  // for callables, so they fall through here before the object branch.
  if (value === null || typeof value !== 'object') return value

  if (seen.has(value)) return seen.get(value)

  if (value instanceof RegExp) {
    const copy = new RegExp(value.source, value.flags)
    copy.lastIndex = value.lastIndex
    seen.set(value, copy)
    return copy
  }

  if (value instanceof Date) {
    const copy = new Date(value.getTime())
    seen.set(value, copy)
    return copy
  }

  if (Array.isArray(value)) {
    const copy: unknown[] = []
    seen.set(value, copy)
    for (let i = 0; i < value.length; i++) {
      copy[i] = clone(value[i], seen)
    }
    return copy
  }

  // Plain object or class instance: preserve the prototype, then copy
  // own enumerable string- and symbol-keyed properties recursively.
  const copy = Object.create(Object.getPrototypeOf(value)) as Record<PropertyKey, unknown>
  seen.set(value, copy)
  const source = value as Record<PropertyKey, unknown>
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor?.enumerable !== true) continue
    copy[key] = clone(source[key], seen)
  }
  return copy
}
