import type { z } from 'zod'
import { UnsupportedSchemaError } from './errors'
import {
  getArrayElement,
  getDiscriminatedOptions,
  getIntersectionLeft,
  getIntersectionRight,
  getLazyGetter,
  getObjectShape,
  getRecordValueType,
  getSetValueType,
  getTupleItems,
  getUnionOptions,
  kindOf,
  unwrapInner,
  unwrapLazy,
  unwrapPipe,
  type ZodKind,
} from './introspect'

/**
 * Kinds the adapter does not implement.
 *
 * - `z.promise(...)`, `z.custom(...)`, and `z.templateLiteral(...)` carry
 *   no form-representable initial value: Promise-valued fields have no
 *   meaningful starting state, custom predicates have no derivable
 *   default, and template-literal schemas parse strings against a
 *   pattern that has no obvious "empty" form.
 * - `z.map(...)`, `z.symbol()`, and `z.function(...)` are equally
 *   unrepresentable: Maps have no obvious form encoding, symbols are
 *   not JSON-serialisable so persistence and SSR round-trip would
 *   silently drop them, and functions have no meaningful initial state.
 *   Matches the v3 adapter's symmetric rejection list.
 *
 * The adapter rejects all six at construction so the failure surfaces
 * at `useForm(...)` rather than as a mystery `undefined` at render time.
 */
const UNSUPPORTED: readonly ZodKind[] = [
  'promise',
  'custom',
  'template-literal',
  'map',
  'symbol',
  'function',
]

function labelPath(path: readonly string[]): string {
  return path.length === 0 ? '<root>' : path.join('.')
}

/**
 * Walk the schema tree and fail fast on unsupported kinds.
 *
 * Recursive `z.lazy(...)` is detected (via getter identity on the
 * descent stack) and the descent stops at the second encounter — but
 * does NOT throw. Recursive schemas are supported: downstream walks
 * (default derivation, slim-primitive gate, path resolution) cap their
 * own descent via `maxRecursionDepth`. The assert step exists only to
 * surface kinds the adapter has no semantics for (`z.promise`, etc.);
 * recursive lazies are a fine shape.
 *
 * This runs once, at adapter construction time, so the cost is paid
 * at app startup rather than per keystroke.
 */
export function assertSupportedKinds(
  schema: z.ZodType,
  path: readonly string[] = [],
  lazyGetters: readonly (() => unknown)[] = []
): void {
  const kind = kindOf(schema)

  if (UNSUPPORTED.includes(kind)) {
    throw new UnsupportedSchemaError(
      `[attaform/zod] unsupported kind '${kind}' at '${labelPath(path)}'`
    )
  }

  switch (kind) {
    case 'object': {
      const shape = getObjectShape(schema as z.ZodObject)
      for (const [key, sub] of Object.entries(shape)) {
        assertSupportedKinds(sub, [...path, key], lazyGetters)
      }
      return
    }
    case 'array':
      assertSupportedKinds(getArrayElement(schema as z.ZodArray), [...path, '*'], lazyGetters)
      return
    case 'set':
      assertSupportedKinds(getSetValueType(schema), [...path, '*'], lazyGetters)
      return
    case 'record':
      assertSupportedKinds(getRecordValueType(schema), [...path, '*'], lazyGetters)
      return
    case 'tuple': {
      const items = getTupleItems(schema)
      items.forEach((item, i) => assertSupportedKinds(item, [...path, String(i)], lazyGetters))
      return
    }
    case 'union': {
      const options = getUnionOptions(schema)
      options.forEach((opt, i) => assertSupportedKinds(opt, [...path, `|${i}`], lazyGetters))
      return
    }
    case 'discriminated-union': {
      const options = getDiscriminatedOptions(schema)
      options.forEach((opt, i) => assertSupportedKinds(opt, [...path, `|${i}`], lazyGetters))
      return
    }
    case 'optional':
    case 'nullable':
    case 'default':
    case 'readonly':
    case 'catch': {
      const inner = unwrapInner(schema)
      if (inner !== undefined) assertSupportedKinds(inner, path, lazyGetters)
      return
    }
    case 'pipe': {
      const inner = unwrapPipe(schema)
      if (inner !== undefined) assertSupportedKinds(inner, path, lazyGetters)
      return
    }
    case 'lazy': {
      const getter = getLazyGetter(schema)
      // Stop descending on the second encounter of a getter — that's
      // a recursive `z.lazy()`. The construction-time walk only needs
      // to verify the *shape* (kinds) of the schema; downstream walks
      // handle recursion via `maxRecursionDepth`. Returning here leaves
      // recursive schemas free to mount.
      if (getter !== undefined && lazyGetters.includes(getter)) return
      const inner = unwrapLazy(schema)
      if (inner !== undefined) {
        assertSupportedKinds(
          inner,
          path,
          getter === undefined ? lazyGetters : [...lazyGetters, getter]
        )
      }
      return
    }
    case 'intersection': {
      const left = getIntersectionLeft(schema)
      const right = getIntersectionRight(schema)
      if (left !== undefined) assertSupportedKinds(left, [...path, 'left'], lazyGetters)
      if (right !== undefined) assertSupportedKinds(right, [...path, 'right'], lazyGetters)
      return
    }
    // Leaves: nothing to descend into.
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'date':
    case 'enum':
    case 'literal':
    case 'null':
    case 'undefined':
    case 'nan':
    case 'any':
    case 'unknown':
    case 'void':
    case 'never':
    case 'promise':
    case 'custom':
    case 'template-literal':
    case 'transform':
    case 'file':
    case 'map':
    case 'symbol':
    case 'function':
      return
    default: {
      const _exhaustive: never = kind
      throw new Error(`assertSupportedKinds: unhandled ZodKind '${_exhaustive as string}'`)
    }
  }
}
