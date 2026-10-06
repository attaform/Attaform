/**
 * The `v-register` modifiers a `useRegister` wrapper's parent wrote, so
 * `<MyField v-register.trim="...">` trims at the inner control that
 * `MyField` binds with `v-register="rv"`. The parent's binding lands on the
 * wrapper's root, which owns no value, while the inner binding carries only
 * the modifiers written inside the wrapper's own template.
 *
 * `useRegister` records the parent's modifiers against the RegisterValue it
 * hands the inner control. The directive and the host write channel read
 * them under the modifiers written at their own binding site.
 *
 * Keyed by the raw RegisterValue. `register()` hands out a readonly view of
 * it, the host channel receives the raw object, and `toRaw` reaches the raw
 * one from the view and from `useRegister`'s proxy, which forwards the read
 * to the RegisterValue it captured.
 */
import { toRaw } from 'vue'
import type { HostModifiers } from '../types/types-api'

const inherited = new WeakMap<object, HostModifiers>()

/**
 * Record `modifiers` as the ones a wrapper's parent wrote for `rv`. Only
 * `.lazy` / `.trim` / `.number` are kept: the parent binding also carries
 * Attaform's own marker modifiers, which describe the parent's element and
 * must not reach the inner control. A set with none of the three records
 * nothing, and so does a binding value that is not an object.
 */
export function recordInheritedModifiers(rv: unknown, modifiers: HostModifiers): void {
  const lazy = modifiers.lazy === true
  const trim = modifiers.trim === true
  const number = modifiers.number === true
  if ((lazy || trim || number) && typeof rv === 'object' && rv !== null) {
    inherited.set(toRaw(rv), { lazy, trim, number })
  }
}

/**
 * The modifiers in force for a binding of `rv`: `own` over any recorded for
 * it. Returns `own` itself when nothing is recorded, so a caller can tell a
 * merge happened by identity.
 */
export function withInheritedModifiers<M extends HostModifiers>(rv: unknown, own: M): M {
  const found = typeof rv === 'object' && rv !== null ? inherited.get(toRaw(rv)) : undefined
  return found === undefined ? own : { ...found, ...own }
}
