import type { GetDisplayState } from 'CORE/../types/types-api'
import type { GenericForm } from 'CORE/../types/types-core'
import type { FormStore } from 'CORE/create-form-store'
import { __DEV__ } from 'CORE/dev'
import { buildFieldStateAccessor, type FormMetaBaseGetter } from 'CORE/field-state-api'
import { getAtPath } from 'CORE/path-walker'
import { canonicalizePath, type Path, type Segment } from 'CORE/paths'

// Lean replacement for field-state-proxy + surface-proxy: one recursive
// dot-drill proxy. Leaf terminal = the plain FieldState object from the
// per-path computed (no leaf-view proxy, no coercion quartet, no
// call/apply/bind shims, no schema-authority arbitration). Keeps:
// truthful absence (fixed-object schema gate + live-key gate), array
// targets so Array.isArray / v-for renderList work, live enumeration,
// Vue sigil skip, toJSON materialisation, warn-and-noop writes.
const INT = /^(?:0|[1-9]\d*)$/
const toSeg = (k: string): Segment => (INT.test(k) ? Number(k) : k)

export function buildFieldStateProxy<F extends GenericForm>(
  state: FormStore<F, GenericForm>,
  formInstanceId: string,
  getFormMetaBase: FormMetaBaseGetter,
  options?: { readonly getDisplayState?: GetDisplayState }
): unknown {
  const at = buildFieldStateAccessor(
    state,
    formInstanceId,
    getFormMetaBase,
    options?.getDisplayState !== undefined
      ? { getDisplayState: options.getDisplayState }
      : undefined
  )
  const fieldAt = (path: readonly Segment[]): unknown => at(path as Path).value
  const cache = new Map<string, unknown>()

  const liveAt = (segs: readonly Segment[]): unknown => getAtPath(state.form.value, segs)
  const liveKeys = (segs: readonly Segment[]): string[] => {
    const v = liveAt(segs)
    if (v === null || v === undefined || typeof v !== 'object') return []
    if (Array.isArray(v)) {
      const keys = new Array<string>(v.length)
      for (let i = 0; i < v.length; i += 1) keys[i] = String(i)
      return keys
    }
    return Object.keys(v as Record<string, unknown>)
  }
  const liveHas = (segs: readonly Segment[], key: string): boolean => {
    const v = liveAt(segs)
    if (v === null || v === undefined || typeof v !== 'object') return false
    if (Array.isArray(v)) {
      const i = Number(key)
      return Number.isInteger(i) && i >= 0 && i < v.length && String(i) === key
    }
    return Object.hasOwn(v as Record<string, unknown>, key)
  }

  // Dense JSON materialisation (same contract as today's materializeFields).
  const materialize = (segs: readonly Segment[]): unknown => {
    if (state.schema.isLeafAtPath(segs as Path)) return fieldAt(segs)
    const v = liveAt(segs)
    if (v === null || v === undefined || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.map((_, i) => materialize([...segs, i]))
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>)) out[k] = materialize([...segs, k])
    return out
  }

  const node = (segs: readonly Segment[]): unknown => {
    if (state.schema.isLeafAtPath(segs as Path)) return fieldAt(segs)
    const isArr = Array.isArray(liveAt(segs))
    const cacheKey = `${JSON.stringify(segs)}${isArr ? 'A' : 'O'}`
    const hit = cache.get(cacheKey)
    if (hit !== undefined) return hit
    const isFixed = state.schema.isFixedObjectAtPath(segs)
    const target = isArr ? [] : {}
    const proxy = new Proxy(target, {
      get(_, key) {
        if (typeof key === 'symbol') return Reflect.get(target, key)
        if (key === '__v_skip') return true
        if (
          key === '__v_isReactive' ||
          key === '__v_isReadonly' ||
          key === '__v_isShallow' ||
          key === '__v_isRef' ||
          key === '__v_raw'
        ) {
          return undefined
        }
        const arrNow = isArr || Array.isArray(liveAt(segs))
        if (key === 'length' && arrNow) return liveKeys(segs).length
        if (key === 'toJSON') return () => materialize(segs)
        if (arrNow && !INT.test(key) && key in Array.prototype)
          return Reflect.get(Array.prototype, key)
        const child = [...segs, toSeg(key)]
        if (
          (isFixed && state.schema.getSlimPrimitiveTypesAtPath(child as Path).size > 0) ||
          liveHas(segs, key)
        ) {
          return node(child)
        }
        return undefined
      },
      has: () => true,
      ownKeys: () => (isArr ? ['length', ...liveKeys(segs)] : liveKeys(segs)),
      getOwnPropertyDescriptor(_, key) {
        if (typeof key !== 'string') return undefined
        if (isArr && key === 'length') {
          return {
            configurable: false,
            enumerable: false,
            value: liveKeys(segs).length,
            writable: true,
          }
        }
        if (!liveHas(segs, key)) return undefined
        return {
          configurable: true,
          enumerable: true,
          value: node([...segs, toSeg(key)]),
          writable: false,
        }
      },
      set: (_, key) => {
        if (__DEV__)
          console.warn(
            `[attaform] form.fields is read-only — write to "${String(key)}" was ignored.`
          )
        return true
      },
      deleteProperty: () => true,
      defineProperty: () => true,
    })
    cache.set(cacheKey, proxy)
    return proxy
  }

  // Call-form successor (`form.field(path)`): a plain function, counted
  // here so the replacement's byte cost is honest.
  const field = (path: string | Path): unknown => fieldAt(canonicalizePath(path).segments)
  const root = node([])
  return Object.assign(field, { root })
}
