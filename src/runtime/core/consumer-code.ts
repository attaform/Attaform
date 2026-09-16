/**
 * Containment for code the CONSUMER wrote that Attaform has to run.
 *
 * A schema is not inert data. `z.lazy(() => ...)`, `.default(() => ...)`
 * and `.catch(() => ...)` all hold consumer functions, and Attaform
 * invokes them during its own walks: deriving blanks at mount,
 * resolving a recursive node, filling a structural gap on a write. A
 * throw from any of them
 * lands in the middle of a walk, which means it comes out of
 * `useForm(...)` or `setValue(...)` and takes the host component with
 * it. Attaform must never be the reason a third-party page goes down.
 *
 * Two things make this worth a shared helper rather than a try/catch at
 * each site. The first is that there were nine such call sites and one
 * of them was guarded, which is how the gap survived: a guard added
 * where a bug was once observed protects that site and nothing else.
 * Putting the catch in the introspector, at the point where consumer
 * code is actually invoked, covers every present caller and every
 * future one without anyone having to remember. The second is that a
 * silent swallow trades a crash for a mystery: `undefined` appearing at
 * a defaulted field with no explanation is its own support burden, so
 * every containment reports once per site in development.
 *
 * This is NOT for consumer callbacks the runtime invokes on purpose and
 * already routes somewhere visible: `onSubmit` / `onError` land on
 * `form.meta.submitError`, and `register({ transforms })` failures go
 * through `assigner-pipeline`'s AF14 path onto `field.transformError`.
 * Those have a channel. Schema-embedded functions have none, so the
 * fallback value is the only possible answer.
 */
import { __DEV__ } from './dev'

/**
 * Sites reported at most once each. Keyed by the site string rather
 * than by the function, because the same broken `.default()` factory
 * re-runs on every re-derivation (mount, reset, variant switch) and one
 * console entry per form is the useful volume.
 *
 * In production `__DEV__` is `false`, the Set allocation tree-shakes
 * out, and `report` returns without touching it.
 */
const reported: Set<string> | null = __DEV__ ? new Set<string>() : null

/**
 * The schema-embedded functions Attaform invokes. A closed set on
 * purpose: each one names a specific Zod construct with specific
 * remediation, and a new entry should arrive with its own advice line
 * rather than reusing a generic one.
 */
export type ConsumerCallSite = 'default-factory' | 'catch-factory' | 'lazy-getter'

/**
 * Report a contained throw, once per site.
 *
 * The `__DEV__` test leads so the whole body, remediation strings
 * included, sits inside a branch the consumer's bundler folds away in
 * production. Holding the advice in a module-level record instead
 * would keep those strings in the production bundle, since a reference
 * from a live function is enough to retain them.
 */
function report(site: ConsumerCallSite, err: unknown): void {
  if (!__DEV__) return
  if (reported === null || reported.has(site)) return
  reported.add(site)
  const advice =
    site === 'default-factory'
      ? "a `.default(() => ...)` factory threw. Attaform used `undefined` for that field's initial value."
      : site === 'catch-factory'
        ? 'a `.catch(() => ...)` fallback threw. Attaform used `undefined` for that value.'
        : 'a `z.lazy(() => ...)` factory threw. Attaform stopped descending at that node, so paths below it will not resolve.'
  console.error(
    `[attaform] ${advice} A function inside your schema must not throw; ` +
      `wrap your own try/catch if the failure is recoverable. Original error:`,
    err
  )
}

/**
 * Invoke `fn` and return `fallback` if it throws.
 *
 * `fallback` is always a value the walkers already treat as "nothing
 * here" (`undefined` at every current site), so a contained throw
 * degrades to the same state as a field the schema never described.
 * That is the honest outcome: the consumer's function was the only
 * thing that knew the answer, and it did not produce one.
 *
 * Deliberately not async-aware. Every site is synchronous, and a
 * rejected thenable returned from one of these would be the consumer's
 * value to handle, not an escape for this helper to swallow.
 */
export function callConsumerSchemaFn<T>(fn: () => T, fallback: T, site: ConsumerCallSite): T {
  try {
    return fn()
  } catch (err) {
    report(site, err)
    return fallback
  }
}

/**
 * Read `key` off a consumer-supplied object, returning `undefined` if
 * the read throws.
 *
 * Separate from `callConsumerSchemaFn` because the hazard is different
 * and so is the judgement about where to apply it. Attaform walks the
 * values a consumer writes, and a property read is only dangerous when
 * the property is an accessor: a getter on a class instance, a
 * `computed` reached through a Vue reactive object, a Proxy trap. That
 * is rare enough that guarding every read in every hot walker would buy
 * safety with a permanent tax on the common case.
 *
 * So this is applied at the walk boundaries that take a consumer value
 * whole and rebuild it (`unset-walker`), not at every property access
 * in the codebase. A throwing getter deeper inside a value Attaform
 * merely carries by reference never gets read by Attaform at all, which
 * is the point of carrying values by reference.
 *
 * Silent by design, unlike the schema-function sites above. A throwing
 * accessor is the consumer's own object behaving as they wrote it, and
 * Attaform reading it is incidental; warning would report Attaform's
 * traversal rather than a mistake the consumer made against Attaform's
 * API. See the dev-warning-scope rule.
 */
export function readConsumerProp(obj: Record<string, unknown>, key: string): unknown {
  try {
    return obj[key]
  } catch {
    return undefined
  }
}

/**
 * Own enumerable string keys of a consumer-supplied object, returning
 * `[]` if enumerating them throws.
 *
 * `Object.keys` is not a safe read on an arbitrary value. It invokes
 * the `ownKeys` and `getOwnPropertyDescriptor` traps, so a Proxy can
 * throw before a single property has been touched, which no amount of
 * per-key guarding would catch. Vue's `reactive()` returns a Proxy, so
 * this is not a hypothetical shape to find in form state.
 *
 * `[]` reads as "an object with nothing in it", which every walker
 * already handles.
 */
export function consumerKeys(obj: object): string[] {
  try {
    return Object.keys(obj)
  } catch {
    return []
  }
}

/**
 * Read index `i` off a consumer-supplied array, returning `undefined`
 * if the read throws.
 *
 * The array counterpart of `readConsumerProp`. An array index can be an
 * accessor just as an object key can (`Object.defineProperty(arr, '0',
 * { get })`), and a Proxy wrapping an array traps element reads too.
 */
export function readConsumerIndex(arr: readonly unknown[], i: number): unknown {
  try {
    return arr[i]
  } catch {
    return undefined
  }
}

/**
 * Own symbol keys of a consumer-supplied object, returning `[]` if
 * enumerating them throws. Companion to `consumerKeys` for the one
 * walker that has to know whether symbol-keyed properties are present.
 */
export function consumerSymbolKeys(obj: object): symbol[] {
  try {
    return Object.getOwnPropertySymbols(obj)
  } catch {
    return []
  }
}

/**
 * Own-or-inherited key existence on a consumer-supplied object,
 * returning `false` if the check throws.
 *
 * `key in obj` invokes a Proxy's `has` trap and
 * `Object.prototype.hasOwnProperty.call` invokes its
 * `getOwnPropertyDescriptor` trap, so an existence check is no safer
 * than a read. `false` reads as "no value at this path", which is the
 * same answer every caller takes for a slot that is genuinely absent.
 */
export function consumerHas(obj: object, key: string | number): boolean {
  try {
    return key in obj
  } catch {
    return false
  }
}
