/**
 * Containment for code the CONSUMER wrote that Attaform has to run.
 *
 * A schema is not inert data. `z.lazy(() => ...)`, `.default(() => ...)`
 * and `.catch(() => ...)` all hold consumer functions, and Attaform
 * invokes them during its own walks: deriving blanks at mount,
 * resolving a recursive node, fingerprinting. A throw from any of them
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
 * Human-readable remediation per site. Kept beside the site names so a
 * message says what to do, not just what happened.
 */
const ADVICE: Readonly<Record<ConsumerCallSite, string>> = {
  'default-factory':
    "a `.default(() => ...)` factory threw. Attaform used `undefined` for that field's initial value.",
  'catch-factory':
    'a `.catch(() => ...)` fallback threw. Attaform used `undefined` for that value.',
  'lazy-getter':
    'a `z.lazy(() => ...)` factory threw. Attaform stopped descending at that node, so paths below it will not resolve.',
}

/**
 * The schema-embedded functions Attaform invokes. A closed set on
 * purpose: each one names a specific Zod construct with specific
 * remediation, and a new entry should arrive with its own advice line
 * rather than reusing a generic one.
 */
export type ConsumerCallSite = 'default-factory' | 'catch-factory' | 'lazy-getter'

function report(site: ConsumerCallSite, err: unknown): void {
  if (reported === null || reported.has(site)) return
  reported.add(site)
  console.error(
    `[attaform] ${ADVICE[site]} A function inside your schema must not throw; ` +
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
 * Copy a consumer record's own enumerable string keys into a fresh
 * plain object, tolerating accessors that throw.
 *
 * `{ ...src }` invokes every getter, so one throwing accessor takes the
 * whole spread down. The fast path here IS the spread, and the guarded
 * key-by-key copy only runs after it has already failed. That keeps the
 * common case at spread speed, which matters because this sits on the
 * per-write merge path, and pays the slow copy only for the object that
 * actually misbehaved.
 *
 * Symbol keys are dropped, matching the spread's own treatment under
 * `stripSymbolsDeep`: form paths are string-keyed.
 */
export function spreadConsumerRecord(src: Record<string, unknown>): Record<string, unknown> {
  try {
    return { ...src }
  } catch {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(src)) {
      const value = readConsumerProp(src, key)
      if (value !== undefined) out[key] = value
    }
    return out
  }
}
