import { computed } from 'vue'
import type { ValidationError } from 'CORE/../types/types-api'
import type { GenericForm } from 'CORE/../types/types-core'
import type { FormStore } from 'CORE/create-form-store'
import { aggregateErrorsAt } from 'CORE/field-state-api'
import { getAtPath, hasAtPath } from 'CORE/path-walker'
import {
  ROOT_PATH_KEY,
  canonicalizePath,
  segmentsForPathKey,
  type PathKey,
  type Path,
  type Segment,
} from 'CORE/paths'
import { safeAssign, safeOwnRead } from 'CORE/safe-assign'
import { __DEV__ } from 'CORE/dev'

// Lean replacement for errors-proxy: a memoized computed sparse tree
// (built by the SAME materializeErrors logic, run once per store change
// instead of per stringify) behind one thin callable wrapper so both
// `form.errors.a.b` (plain data reads) and `form.errors(path)` survive.
export function buildErrorsProxy<F extends GenericForm>(state: FormStore<F, GenericForm>): unknown {
  const tree = computed(() => materializeErrors(state, []))
  const call = (path?: string | Path): readonly ValidationError[] =>
    aggregateErrorsAt(state, path === undefined ? [] : (canonicalizePath(path).segments as Path))
  return new Proxy(call, {
    get: (t, key) =>
      typeof key === 'symbol'
        ? Reflect.get(t, key)
        : key === '__v_skip'
          ? true
          : key === 'toJSON'
            ? () => tree.value
            : (tree.value as Record<string, unknown>)[key],
    has: (t, key) =>
      typeof key === 'symbol' ? Reflect.has(t, key) : Object.hasOwn(tree.value as object, key),
    ownKeys: () => Reflect.ownKeys(tree.value as object),
    getOwnPropertyDescriptor: (_t, key) => {
      const d = Reflect.getOwnPropertyDescriptor(tree.value as object, key)
      if (d !== undefined) d.configurable = true
      return d
    },
    set: (_t, key) => {
      if (__DEV__)
        console.warn(`[attaform] form.errors is read-only — write to "${String(key)}" was ignored.`)
      return true
    },
    deleteProperty: () => true,
    defineProperty: () => true,
  })
}

// ---- copied verbatim from errors-proxy.ts (the tree builder survives) ----
function materializeErrors<F extends GenericForm>(
  state: FormStore<F, GenericForm>,
  containerSegments: readonly Segment[]
): Record<string, unknown> | unknown[] {
  const liveContainer = getAtPath(state.form.value, containerSegments)
  const tree: Record<string, unknown> | unknown[] = Array.isArray(liveContainer) ? [] : {}

  const collect = (
    store: ReadonlyMap<PathKey, ValidationError[]>,
    applyActivePathFilter: boolean
  ): void => {
    entries: for (const [pathKey, errors] of store) {
      if (errors.length === 0) continue
      const fullPath = segmentsForPathKey(pathKey)
      if (fullPath === null) continue

      if (fullPath.length === 0) {
        if (containerSegments.length === 0) placeAt(tree, [ROOT_PATH_KEY], errors)
        continue
      }

      if (fullPath.length < containerSegments.length) continue
      for (let i = 0; i < containerSegments.length; i++) {
        if (fullPath[i] !== containerSegments[i]) continue entries
      }

      if (applyActivePathFilter && !hasAtPath(state.form.value, fullPath)) continue

      const relativePath = fullPath.slice(containerSegments.length)
      let placePath: readonly Segment[]
      if (relativePath.length === 0) {
        placePath = ['']
      } else if (state.schema.isLeafAtPath(fullPath as Path)) {
        placePath = relativePath
      } else if (state.schema.getSlimPrimitiveTypesAtPath(fullPath as Path).size > 0) {
        placePath = [...relativePath, '']
      } else {
        placePath = relativePath
      }

      placeAt(tree, placePath, errors)
    }
  }

  collect(state.schemaErrors, true)
  collect(state.derivedBlankErrors.value, true)
  collect(state.userErrors, false)
  return tree
}

function placeAt(
  tree: Record<string, unknown> | unknown[],
  path: readonly Segment[],
  errors: ValidationError[]
): void {
  if (path.length === 0) return
  let cursor: Record<string, unknown> | unknown[] = tree
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i] as Segment
    const nextSeg = path[i + 1] as Segment
    const key = typeof seg === 'number' ? String(seg) : seg
    const cursorRecord = cursor as Record<string, unknown>
    let child = safeOwnRead(cursorRecord, key)
    if (child === null || child === undefined || typeof child !== 'object') {
      child = typeof nextSeg === 'number' ? [] : {}
      safeAssign(cursorRecord, key, child)
    }
    cursor = child as Record<string, unknown> | unknown[]
  }
  const lastSeg = path[path.length - 1] as Segment
  const lastKey = typeof lastSeg === 'number' ? String(lastSeg) : lastSeg
  const cursorRecord = cursor as Record<string, unknown>
  const existing = safeOwnRead(cursorRecord, lastKey)
  safeAssign(cursorRecord, lastKey, Array.isArray(existing) ? [...existing, ...errors] : errors)
}
