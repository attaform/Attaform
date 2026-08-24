import { computed, readonly, type Ref } from 'vue'
import { canonicalizePath, type Path } from 'CORE/paths'
import { getAtPath } from 'CORE/path-walker'
import { __DEV__ } from 'CORE/dev'

// Lean replacement for values-proxy: native readonly + one thin callable
// wrapper (keeps `form.values(path)` DX and JSON via toJSON).
export function buildValuesProxy<F>(form: Ref<F>): unknown {
  const inner = computed(() => readonly(form.value as object))
  const call = (path?: string | Path): unknown =>
    path === undefined ? inner.value : getAtPath(inner.value, canonicalizePath(path).segments)
  return new Proxy(call, {
    get: (t, key) =>
      typeof key === 'symbol'
        ? Reflect.get(t, key)
        : key === '__v_skip'
          ? true
          : key === 'toJSON'
            ? () => inner.value
            : (inner.value as Record<string, unknown>)[key],
    has: (t, key) =>
      typeof key === 'symbol' ? Reflect.has(t, key) : Reflect.has(inner.value as object, key),
    ownKeys: () => Reflect.ownKeys(inner.value as object),
    getOwnPropertyDescriptor: (_t, key) => {
      const d = Reflect.getOwnPropertyDescriptor(inner.value as object, key)
      if (d !== undefined) d.configurable = true
      return d
    },
    set: (_t, key) => {
      if (__DEV__)
        console.warn(`[attaform] form.values is read-only — write to "${String(key)}" was ignored.`)
      return true
    },
    deleteProperty: () => true,
    defineProperty: () => true,
  })
}
