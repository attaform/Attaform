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
 * Own-property read that returns `undefined` for an absent key or for
 * a slot whose only source is the inherited prototype chain. Pairs
 * with `safeAssign` at every untrusted-key read site that's about to
 * descend into a subtree.
 *
 * The hazard this defends: `target[key]` for `key === '__proto__'`
 * invokes `Object.prototype`'s inherited `__proto__` getter and
 * returns `Object.prototype` itself when the target has no own
 * `__proto__` slot. Naive callers then treat that result as "the
 * value we have at this path" and either descend through it (writing
 * inherited properties into the descendant flow) or, worse, write
 * back at the same key — landing the next mutation on
 * `Object.prototype` directly.
 *
 * Reads at any other key fall through to `target[key]`; non-
 * `__proto__` inherited slots (`toString`, `constructor`, …) on a
 * fresh `{}` are non-enumerable and never inhabit a payload-key path
 * that's about to be descended into.
 */
export function safeOwnRead(target: Record<string, unknown>, key: string): unknown {
  if (key === '__proto__') {
    const desc = Object.getOwnPropertyDescriptor(target, '__proto__')
    return desc?.value
  }
  return target[key]
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
  return Object.prototype.hasOwnProperty.call(target, key)
}
