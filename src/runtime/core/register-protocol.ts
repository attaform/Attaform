import { isRef } from 'vue'
import type { InternalRegisterValue, RegisterValue } from '../types/types-api'

// Shared register-protocol primitives: the markers and value guards that
// the v-register directive, its file / lifecycle satellites, and
// useRegister all build on. They live in this leaf (depending only on vue
// and the types module) so those modules don't import directive.ts back,
// which would form an import cycle.

/**
 * Marker installed on the v-register directive object so consumers
 * (notably `useRegister`) can identify it in a child vnode's
 * directive list even when the consumer's bundler hasn't installed
 * attaform's compile-time transforms. `Symbol.for(...)` round-trips
 * across duplicate bundle copies: `attaform` and `attaform/zod` can
 * land on different `vRegister` references in the playground or
 * under pnpm-hoist edge cases, but both carry the same marker.
 */
export const V_REGISTER_MARKER: unique symbol = Symbol.for('attaform:v-register-directive')

/**
 * Marker on the rendered root DOM element. Set by `useRegister`'s
 * `onMounted` hook; read by the directive's deferred warn check to
 * skip the "is a no-op" warn for components that handle binding via
 * an inner v-register.
 *
 * `Symbol.for(...)` so the marker round-trips across duplicate copies
 * of attaform — see `assignKey` in core/directive.ts for the same
 * reasoning. `useRegister` and the directive are typically loaded
 * from the same module copy, but a consumer importing from
 * `attaform/zod` (Vite-optimized bundle) and the Nuxt
 * plugin's relative-path import (live ESM) can land on different
 * copies; a global symbol means the marker check still works.
 */
export const REGISTER_OWNER_MARKER: unique symbol = Symbol.for('attaform:register-owner-marker')

/**
 * Directive modifier the `componentBridgeTransform` stamps onto a
 * `v-register` that lands on a component host (or kebab custom element).
 * It is the compile-time -> runtime signal the directive's `getSSRProps`
 * reads under compiled SSR, where Vue passes a `null` vnode and the host
 * is otherwise indistinguishable from a native control. autoAria then
 * suppresses its attrs on the host root (the inner control the component
 * re-binds via useRegister carries them). Namespaced to avoid collision
 * with any author-written modifier. (#404)
 */
export const SSR_COMPONENT_HOST_MODIFIER = 'attaformComponentHost'

/**
 * Type guard for a `RegisterValue`. Returns `true` when `val` looks
 * like the object returned from `form.register(path)`.
 *
 * ```ts
 * if (isRegisterValue(slotValue)) {
 *   // slotValue.innerRef is now a Ref<unknown>
 * }
 * ```
 *
 * Useful when building wrapper components that accept either a
 * `RegisterValue` or a plain ref via the same prop.
 */
export function isRegisterValue<Value = unknown>(val: unknown): val is RegisterValue<Value> {
  if (typeof val !== 'object' || val === null) return false
  if (!('innerRef' in val)) return false
  if (!isRef(val.innerRef)) return false
  if (!('registerElement' in val)) return false
  if (typeof val.registerElement !== 'function') return false
  if (!('setValueWithInternalPath' in val)) return false
  if (typeof val.setValueWithInternalPath !== 'function') return false
  return true
}

/**
 * `true` while a deferred async transform is in flight at this path.
 * `beginTransform` flips it synchronously inside the assigner, so a
 * listener's post-write force-sync block reads it (right after the
 * assigner returns) to skip snapping the DOM back to stale storage —
 * the resolved value is painted in by the orchestrator's `syncDom`
 * once the run lands.
 */
export function isTransforming(value: unknown): boolean {
  return isRegisterValue(value) && (value as InternalRegisterValue).transforming
}
