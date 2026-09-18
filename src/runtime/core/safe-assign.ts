/**
 * Own-property write, read and existence primitives for keys the consumer
 * controls. Together they keep a consumer-schema field literally named
 * `__proto__` (or `toString`, or `hasOwnProperty`) flowing end to end
 * without either poisoning `Object.prototype` or letting the prototype
 * chain leak into data flow.
 */
import { readConsumerIndex, readConsumerProp } from './consumer-code'

/**
 * Own-property write that lands a `__proto__` key as an own data property
 * rather than invoking `Object.prototype`'s inherited `__proto__` setter,
 * which would reassign the target's prototype chain: the original
 * prototype-pollution attack.
 *
 * Used by the path-walker, the merge, and the snapshot routines. It pairs
 * with object spread (`{ ...base }`) for the spreading case, spread using
 * `CreateDataProperty` per the spec and so bypassing the accessor already;
 * the explicit branch here is what marks the defense at every imperative
 * write site handling an untrusted key.
 *
 * For any other key the call is `target[key] = value`. `'prototype'` and
 * `'constructor'` are plain inherited data properties on
 * `Object.prototype`, so an own-property write at either name shadows the
 * inherited slot with no chain mutation.
 */
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
 * `toLocaleString`, the `__defineGetter__` / `__lookupGetter__` family).
 * For these names, and ONLY these, `target[key]` falls through to the
 * inherited member when no own slot exists and `key in target` answers
 * `true` for that inherited slot, both leaking the prototype chain into
 * data flow. Vue additionally shims `hasOwnProperty` on every reactive and
 * readonly proxy, so reading it off a tracked object returns Vue's
 * instrumentation rather than the stored datum. The own-property-safe read
 * and existence primitives branch on exactly this predicate.
 *
 * Answered from a Set built once from `Object.prototype`'s own property
 * names, which is exactly the set `key in Object.prototype` tests:
 * `Object.prototype`'s own prototype is `null`, so it inherits nothing
 * and its own names ARE the whole inherited surface. Derived from the
 * runtime rather than written out, so it cannot drift from the engine
 * the way a hand-kept list would.
 *
 * A Set rather than the `in` test because this sits in the diff's per-key
 * loop, which runs over every key of every object on every write. `in`
 * against a prototype is a megamorphic lookup there, measured at ~20% of a
 * 500-leaf keystroke; a hash lookup is not.
 */
const SHADOWED_KEYS: ReadonlySet<string> = new Set(Object.getOwnPropertyNames(Object.prototype))

export function isShadowedKey(key: string): boolean {
  return SHADOWED_KEYS.has(key)
}

/**
 * Own-property read that returns `undefined` for an absent key or for
 * a slot whose only source is the inherited prototype chain. Pairs
 * with `safeAssign` at every untrusted-key read site that's about to
 * descend into a subtree.
 *
 * The hazard it defends, at any prototype-shadowed key name
 * (`isShadowedKey`): `target[key]` resolves the inherited member when the
 * target has no own slot. `__proto__` returns `Object.prototype` through
 * the inherited getter, `hasOwnProperty` and `toString` return the
 * inherited methods, and through a Vue reactive proxy `hasOwnProperty`
 * returns Vue's instrumentation shim even WHEN an own data slot exists. A
 * naive caller then reads that as "the value at this path" and either
 * descends through it or writes it back. The own-descriptor read returns
 * the stored own value, or `undefined` when the slot is purely inherited,
 * and on a reactive proxy it forwards to the raw descriptor, sidestepping
 * the shim.
 *
 * Reads at any non-shadowed key fall through to `target[key]`, which on
 * a reactive proxy keeps Vue's per-key dependency tracking intact.
 *
 * Every read of the target routes through `readConsumerProp`, because the
 * consumer accessor this function already contemplates can also THROW and
 * an escape would surface out of `setValue` / `reset` in the host app
 * (#608). A throwing accessor reads as `undefined`, which every caller
 * already handles as an absent slot.
 */
export function safeOwnRead(target: Record<string, unknown>, key: string): unknown {
  if (isShadowedKey(key)) {
    const desc = Object.getOwnPropertyDescriptor(target, key)
    if (desc === undefined) return undefined
    // An own data property gives its stored value. An own accessor, never
    // minted by the runtime's own writes but possible from a consumer,
    // resolves through the target so the getter still runs.
    return 'value' in desc ? desc.value : readConsumerProp(target, key)
  }
  return readConsumerProp(target, key)
}

/**
 * Own-property existence check that treats the prototype chain as "not
 * present", the companion to `safeOwnRead`. It stands in for every
 * `key in target` test where `key` is untrusted and the surrounding code
 * reads "this key is present" as "the consumer wrote at this slot".
 *
 * The hazard: `'__proto__' in target` is `true` for every regular object,
 * the inherited accessor on `Object.prototype` answering `[[HasProperty]]`
 * affirmatively. A naive check would declare every consumer to have
 * "already written at `__proto__`" and skip default-fill and variant-merge
 * logic that should run.
 *
 * Routes through `Object.prototype.hasOwnProperty.call` so a consumer who
 * shadowed `hasOwnProperty` on the target cannot break the check.
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
 * whole spread down. The fast path IS the spread and the guarded copy runs
 * only after it has already failed, which keeps the common case at spread
 * speed (this sits on the per-write merge path) and pays the slow copy
 * only for the object that misbehaved.
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
