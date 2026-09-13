/**
 * Own-property write that lands a `__proto__` key as an own data
 * property instead of invoking `Object.prototype`'s inherited
 * `__proto__` setter (which would reassign the target's prototype
 * chain — the original prototype-pollution attack).
 *
 * Used by the path-walker, merge, snapshot, and persistence routines
 * to keep a consumer-schema field literally named `__proto__` flowing
 * end-to-end without poisoning `Object.prototype`. Pairs with object
 * spread (`{ ...base }`) for the spreading case: spread uses
 * `CreateDataProperty` per the spec, which already bypasses the
 * accessor, so spreading is safe on a regular target. The explicit
 * branch here documents "this is the defense" at every imperative
 * write site that handles an untrusted key.
 *
 * For non-`__proto__` keys the call is equivalent to
 * `target[key] = value` — `'prototype'` and `'constructor'` are plain
 * inherited data properties on `Object.prototype`, so own-property
 * writes at those names shadow the inherited slot without any chain
 * mutation.
 */
import { readConsumerIndex, readConsumerProp } from './consumer-code'

export function safeAssign<T>(target: Record<string, T>, key: string, value: T): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    })
    return
  }
  target[key] = value
}

/**
 * A string key whose name is shadowed by a member inherited from
 * `Object.prototype` (`__proto__`, `hasOwnProperty`, `toString`,
 * `valueOf`, `constructor`, `isPrototypeOf`, `propertyIsEnumerable`,
 * `toLocaleString`, the `__defineGetter__` / `__lookupGetter__`
 * family). For these names — and ONLY these — `target[key]` falls
 * through to the inherited member when no own slot exists, and
 * `key in target` answers `true` for the inherited slot; both leak the
 * prototype chain into data flow. (`hasOwnProperty` is additionally
 * shimmed by Vue on every reactive / readonly proxy, so reading it off
 * a tracked object returns Vue's instrumentation rather than the stored
 * datum.) The own-property-safe read / existence primitives branch on
 * exactly this predicate.
 *
 * `key in Object.prototype` is a membership test against a single
 * constant object: `true` for every inherited member name, `false` for
 * every ordinary data key — so the common path pays nothing.
 */
export function isShadowedKey(key: string): boolean {
  return key in Object.prototype
}

/**
 * Own-property read that returns `undefined` for an absent key or for
 * a slot whose only source is the inherited prototype chain. Pairs
 * with `safeAssign` at every untrusted-key read site that's about to
 * descend into a subtree.
 *
 * The hazard this defends, for any prototype-shadowed key name
 * (`isShadowedKey`): `target[key]` resolves the inherited member when
 * the target has no own slot — `__proto__` returns `Object.prototype`
 * via the inherited getter, `hasOwnProperty` / `toString` / … return
 * the inherited methods (and, through a Vue reactive proxy,
 * `hasOwnProperty` returns Vue's instrumentation shim even WHEN an own
 * data slot exists). Naive callers then treat that result as "the value
 * at this path" and either descend through it or write it back. The
 * own-descriptor read returns the stored own value (or `undefined` when
 * the slot is purely inherited), and on a reactive proxy it forwards to
 * the raw descriptor — sidestepping the shim.
 *
 * Reads at any non-shadowed key fall through to `target[key]`, which on
 * a reactive proxy keeps Vue's per-key dependency tracking intact.
 *
 * Every read of the target routes through `readConsumerProp`, because
 * the consumer accessor this function already contemplates can also
 * THROW, and an escape here surfaces from `setValue` / `reset` in the
 * host app. A throwing accessor reads as `undefined`, which every
 * caller already handles as an absent slot.
 */
export function safeOwnRead(target: Record<string, unknown>, key: string): unknown {
  if (isShadowedKey(key)) {
    const desc = Object.getOwnPropertyDescriptor(target, key)
    if (desc === undefined) return undefined
    // Own data property → its stored value. Own accessor (never minted
    // by the runtime's own writes, but a consumer could hand one in) →
    // resolve through the target so the getter still runs.
    return 'value' in desc ? desc.value : readConsumerProp(target, key)
  }
  return readConsumerProp(target, key)
}

/**
 * Own-property existence check that treats the prototype chain as
 * "not present". The companion to `safeOwnRead`. Pairs with every
 * `key in target` test where `key` is untrusted and the surrounding
 * code reads "this key is present" as "consumer wrote at this slot".
 *
 * The hazard: `'__proto__' in target` is `true` for every regular
 * object (the inherited accessor on `Object.prototype` answers
 * `[[HasProperty]]` affirmatively). A naive existence check would
 * declare every consumer "already wrote at `__proto__`" and skip
 * default-fill / variant-merge logic that should run.
 *
 * Routes through `Object.prototype.hasOwnProperty.call` so a consumer
 * who shadowed `hasOwnProperty` on the target doesn't break the
 * check.
 */
export function safeOwnHas(target: object, key: string): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(target, key)
  } catch {
    // `hasOwnProperty` invokes a Proxy's `getOwnPropertyDescriptor`
    // trap, so an existence check on a consumer value is no safer than
    // a read. `false` reads as "no own slot here", the same answer a
    // genuinely absent key gives.
    return false
  }
}

/**
 * Copy a consumer record's own enumerable string keys into a fresh
 * plain object, tolerating accessors that throw.
 *
 * `{ ...src }` invokes every getter, so one throwing accessor takes the
 * whole spread down. The fast path here IS the spread, and the guarded
 * copy only runs after it has already failed. That keeps the common
 * case at spread speed, which matters because this sits on the
 * per-write merge path, and pays the slow copy only for the object that
 * actually misbehaved.
 *
 * The fallback matches the spread it stands in for on both points that
 * are easy to get wrong. Every key is assigned even when its value is
 * `undefined`, because an explicit `undefined` at a key is a signal the
 * runtime reads (the consumer named the slot empty) and dropping it
 * would change the shape. And writes go through `safeAssign`, because
 * the spread's `CreateDataProperty` semantics land a literal
 * `__proto__` key as an own data property while a plain `out[key] = v`
 * would invoke the inherited setter and reassign the prototype chain.
 *
 * Symbol keys are dropped, matching how form values are string-keyed
 * everywhere else.
 */
export function spreadConsumerRecord(src: Record<string, unknown>): Record<string, unknown> {
  try {
    return { ...src }
  } catch {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(src)) {
      safeAssign(out, key, readConsumerProp(src, key))
    }
    return out
  }
}

/**
 * Copy a consumer array's elements into a fresh array, tolerating
 * indices that throw.
 *
 * The array counterpart of `spreadConsumerRecord`, and the same
 * fast-path-first shape: `slice()` reads every index, so one accessor
 * that throws takes the whole copy down, and the guarded per-index copy
 * runs only after that has already happened. A throwing index reads as
 * `undefined`, matching how a throwing key reads elsewhere.
 */
export function copyConsumerArray(src: readonly unknown[]): unknown[] {
  try {
    return src.slice()
  } catch {
    const out = new Array<unknown>(src.length)
    for (let i = 0; i < src.length; i++) out[i] = readConsumerIndex(src, i)
    return out
  }
}
