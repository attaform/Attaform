import { makeReadonlyCoercion, warnReadOnly } from './proxy-readonly-helpers'

/**
 * Shape of the callable readonly-snapshot Proxy: a function target
 * that doubles as a Record of `string`-keyed values. Callers cast to
 * a narrower surface-specific type (`ValuesProxy<F>`,
 * `WizardStatusesProxy<S>`) at the consumer-facing boundary.
 */
export type CallableReadonlySnapshotProxy<T> = ((...args: unknown[]) => unknown) & Readonly<T>

/**
 * Options for `buildCallableReadonlySnapshotProxy`. Each surface
 * supplies the four pure-data hooks the trap layer needs; the trap
 * topology (apply / get / has / ownKeys / set+delete+define
 * warn-and-noop) is fixed and shared across surfaces.
 *
 * Reactivity contract: each hook is invoked inside the corresponding
 * trap, which fires inside the consumer's active effect — every
 * reactive read inside the hook (a Ref, a computed, the form value)
 * is tracked at access time. The factory caches nothing; callers
 * that need expensive snapshots should memoise inside `snapshot`.
 */
export interface CallableReadonlySnapshotOptions<T> {
  /**
   * Human-readable surface name for the warn-and-noop trap messages
   * (`'form.values'`, `'wizard.statuses'`). Threaded straight into
   * `warnReadOnly`.
   */
  readonly surface: string
  /**
   * Build the full snapshot the proxy represents. Powers no-arg
   * `apply()`, `toJSON` / `toString` / `Symbol.toPrimitive` coercion,
   * and (when no custom `describeKey` is supplied) the
   * `getOwnPropertyDescriptor` value field. Should be cheap or
   * pre-memoised — `Symbol.toPrimitive` calls may stack inside Vue's
   * stringification path.
   */
  readonly snapshot: () => T
  /**
   * Optional snapshot used SOLELY by the coercion handlers (`toJSON`,
   * `toString`, `valueOf`, `Symbol.toPrimitive`) when serialising the
   * surface. Defaults to `snapshot`.
   *
   * The split exists because `snapshot()` may return a Vue reactive /
   * readonly proxy (so `proxy()` hands consumers a live, tracked view),
   * but Vue shims `hasOwnProperty` on such proxies — so a data field
   * literally named `hasOwnProperty` would serialise as Vue's function
   * shim (and `JSON.stringify` would drop it). A surface whose snapshot
   * is reactive supplies a raw (`toRaw`'d) snapshot here so
   * stringification reflects the stored data faithfully. Reactivity is
   * still tracked: the handler reads the reactive source before
   * unwrapping, inside the consumer's active effect.
   */
  readonly coercionSnapshot?: () => T
  /**
   * Resolve a `string` property access against the underlying source.
   * Called from the `get` trap (after the coercion-key / symbol
   * branches) so consumer-supplied logic can decide what each key
   * resolves to — usually `(snapshot() as Record<string, unknown>)[key]`
   * or a per-key unwrap of a `ComputedRef`.
   *
   * Returning `undefined` is the natural "not present" reply; the
   * `has` predicate decides whether enumeration / `in` reports the
   * key.
   */
  readonly resolveKey: (key: string) => unknown
  /**
   * Resolve a call-form invocation (`proxy(arg)`). Receives the first
   * argument as-is (the surface decides whether to support strings,
   * arrays, or its own bespoke shape). When omitted, the call form
   * delegates to `resolveKey` after stringifying the argument.
   *
   * No-arg calls (`proxy()`) bypass this hook and return the full
   * `snapshot()` so consumers grab the whole record with one call.
   */
  readonly resolveCall?: (arg: unknown) => unknown
  /**
   * The enumerable own keys of this surface (drives `Object.keys`,
   * `for…in`, `{...spread}`, `v-for`). Read inside the `ownKeys` trap
   * so any reactive source the surface tracks (the form Ref, a per-
   * form statuses record) re-enumerates on the next render.
   */
  readonly ownKeys: () => readonly string[]
  /**
   * Whether a key is "owned" by this surface (drives the `in`
   * operator and `getOwnPropertyDescriptor`). Required because some
   * surfaces lie about descent semantics (`form.values.unknown`
   * returns `undefined` but is not in the snapshot's own keys).
   */
  readonly hasKey: (key: string) => boolean
  /**
   * Custom `getOwnPropertyDescriptor` builder. When omitted, the
   * default descriptor is `{ configurable: true, enumerable: true,
   * writable: false, value: resolveKey(key) }` for any key in
   * `ownKeys`. Surfaces that need a different shape (e.g. `values`
   * forwarding through `Reflect.getOwnPropertyDescriptor` on the
   * underlying readonly proxy) supply their own.
   */
  readonly describeKey?: (key: string) => PropertyDescriptor | undefined
}

/**
 * Build the shared callable readonly Proxy that powers `form.values`
 * and `wizard.statuses` — and any future surface that follows the
 * "callable, readonly, snapshot-backed" shape (a Ref + a couple of
 * coercion / enumeration hooks).
 *
 * Trap topology (shared, fixed):
 *
 * - **`apply(_, _, args)`** — `proxy()` returns `snapshot()` whole;
 *   `proxy(arg)` returns `resolveCall?.(arg) ?? resolveKey(String(arg))`.
 * - **`get(_, key)`** — `Symbol.toPrimitive` returns the coercion
 *   handler; other symbols pass through to `Reflect.get(target, key)`
 *   so Vue's reactivity sigils (`__v_isRef`, `__v_isReadonly`, …) and
 *   iteration symbols resolve against the function target. `toJSON`,
 *   `toString`, `valueOf` return the coercion handlers. Any other
 *   `string` key returns `resolveKey(key)`.
 * - **`has(_, key)`** — symbols pass through to the function target;
 *   strings route through `hasKey`.
 * - **`ownKeys`** — `ownKeys()`. The arrow-function target carries no
 *   non-configurable own properties, so the Proxy invariant is satisfied
 *   by whatever the surface returns.
 * - **`getOwnPropertyDescriptor(_, key)`** — `describeKey?.(key)` when
 *   supplied; otherwise the default value-from-`resolveKey` descriptor.
 * - **`set` / `deleteProperty` / `defineProperty`** — `warnReadOnly` +
 *   return `true`. Strict-mode callers don't throw; the readonly
 *   contract is enforced by the absence of any actual mutation.
 *
 * Target shape: arrow function so `typeof === 'function'` (the `apply`
 * trap only fires on function targets) without the non-configurable
 * `prototype` slot a regular `function` declaration would impose on
 * the Proxy invariant for `ownKeys`.
 */
export function buildCallableReadonlySnapshotProxy<T>(
  opts: CallableReadonlySnapshotOptions<T>
): CallableReadonlySnapshotProxy<T> {
  const target = (() => {}) as unknown as CallableReadonlySnapshotProxy<T>

  const { toString, valueOf, toJSON, toPrimitive } = makeReadonlyCoercion(
    opts.coercionSnapshot ?? opts.snapshot
  )
  const callResolve = opts.resolveCall ?? ((arg: unknown): unknown => opts.resolveKey(String(arg)))

  return new Proxy(target, {
    apply(_, __, args: unknown[]): unknown {
      const arg = args[0]
      if (arg === undefined) return opts.snapshot()
      return callResolve(arg)
    },
    get(_, key: string | symbol): unknown {
      if (typeof key === 'symbol') {
        if (key === Symbol.toPrimitive) return toPrimitive
        return Reflect.get(target, key)
      }
      if (key === 'toJSON') return toJSON
      if (key === 'toString') return toString
      if (key === 'valueOf') return valueOf
      return opts.resolveKey(key)
    },
    has(_, key: string | symbol): boolean {
      if (typeof key === 'symbol') return Reflect.has(target, key)
      return opts.hasKey(key)
    },
    ownKeys: () => opts.ownKeys() as ArrayLike<string>,
    getOwnPropertyDescriptor(_, key: string | symbol): PropertyDescriptor | undefined {
      if (typeof key !== 'string') return undefined
      if (opts.describeKey !== undefined) return opts.describeKey(key)
      if (!opts.hasKey(key)) return undefined
      return {
        configurable: true,
        enumerable: true,
        writable: false,
        value: opts.resolveKey(key),
      }
    },
    set: (_, key) => {
      warnReadOnly(opts.surface, 'write', key)
      return true
    },
    deleteProperty: (_, key) => {
      warnReadOnly(opts.surface, 'delete', key)
      return true
    },
    defineProperty: (_, key) => {
      warnReadOnly(opts.surface, 'define', key)
      return true
    },
  })
}
