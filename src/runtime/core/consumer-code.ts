/**
 * Containment for code the CONSUMER wrote that Attaform has to run.
 *
 * A schema is not inert data. `z.lazy(() => ...)`, `.default(() => ...)`
 * and `.catch(() => ...)` each hold a consumer function, and Attaform
 * invokes them during its own walks: deriving blanks at mount, resolving a
 * recursive node, filling a structural gap on a write. A `useWizard` step
 * slot is the same shape one layer up, a consumer function the wizard calls
 * during its compile pass. A throw from any of them lands mid-walk, so it
 * comes out of `useForm(...)`, `setValue(...)` or `useWizard(...)` and takes
 * the host component with it. Attaform must never be the reason a
 * third-party page goes down (#608).
 *
 * Two things make this a shared helper rather than a try/catch per site.
 * The catch belongs where consumer code is actually invoked, so it covers
 * every present and future caller with nobody having to remember; a guard
 * placed where a bug was once observed protects that one site and nothing
 * else. And a silent swallow trades a crash for a mystery, `undefined` at a
 * defaulted field or a step missing from a wizard with no explanation being
 * its own support burden, so every containment reports once per site in
 * development.
 *
 * This is NOT for consumer callbacks the runtime invokes on purpose and
 * already routes somewhere visible: `onSubmit` / `onError` land on
 * `form.meta.submitError`, and `register({ transforms })` failures go
 * through `assigner-pipeline`'s AF14 path onto `field.transformError`.
 * Those have a channel. The sites below have none, so the fallback value is
 * the only possible answer.
 */
import { __DEV__ } from './dev'

/**
 * Sites reported at most once each. Keyed by the site string, plus the
 * caller's `detail` where one is given, rather than by the function:
 * the same broken `.default()` factory re-runs on every re-derivation
 * (mount, reset, variant switch) and the same broken step resolver
 * re-runs on every compile pass, so one console entry per distinct site
 * is the useful volume.
 *
 * `detail` has to name a position in the consumer's SOURCE rather than
 * anything minted at runtime. `steps[2]` is bounded by the array the
 * consumer wrote; a generated wizard key would grow this Set without
 * bound on a page that mounts and unmounts a wizard repeatedly.
 *
 * In production `__DEV__` is `false`, the Set allocation tree-shakes
 * out, and `report` returns without touching it.
 */
const reported: Set<string> | null = __DEV__ ? new Set<string>() : null

/**
 * The consumer functions Attaform invokes during its own walks. A closed
 * set on purpose: each one names a specific construct with specific
 * remediation, and a new entry should arrive with its own advice line
 * rather than reusing a generic one.
 */
export type ConsumerCallSite =
  | 'default-factory'
  | 'catch-factory'
  | 'lazy-getter'
  | 'wizard-slot'
  | 'wizard-lazy-slot'
  | 'wizard-progress'
  | 'wizard-restore'
  | 'wizard-persist'
  | 'wizard-default-statuses'

/**
 * Report a contained throw or rejection, once per site.
 *
 * The `__DEV__` test leads so the whole body, the record of remediation
 * strings included, sits inside a branch the consumer's bundler folds away
 * in production. A module-level record would instead keep those strings in
 * the production bundle, since a reference from a live function is enough
 * to retain them.
 *
 * Exported because one site is a rejected promise rather than a throw:
 * `useWizard({ defaultStatuses })` accepts an async factory, and the
 * `.catch` that stops it becoming an unhandled rejection cannot route
 * through `callConsumerFn`, which is synchronous by design.
 */
export function reportConsumerThrow(
  site: ConsumerCallSite,
  detail: string | undefined,
  err: unknown
): void {
  if (!__DEV__) return
  const key = detail === undefined ? site : `${site}|${detail}`
  if (reported === null || reported.has(key)) return
  reported.add(key)
  const at = detail === undefined ? '' : ` at \`${detail}\``
  const advice: Record<ConsumerCallSite, string> = {
    'default-factory':
      "a `.default(() => ...)` factory threw. Attaform used `undefined` for that field's initial value.",
    'catch-factory':
      'a `.catch(() => ...)` fallback threw. Attaform used `undefined` for that value.',
    'lazy-getter':
      'a `z.lazy(() => ...)` factory threw. Attaform stopped descending at that node, so paths below it will not resolve.',
    'wizard-slot': `a function step slot threw${at}. Attaform dropped that step from the compiled list; the rest of the flow still navigates.`,
    'wizard-lazy-slot': `a \`lazy()\` step resolver threw${at}. Attaform dropped that step from the compiled list until the resolver's own dependencies change.`,
    'wizard-progress':
      'a `useWizard({ progress })` override threw. Attaform fell back to its own valid-step ratio.',
    'wizard-restore':
      'a `useWizard({ restore })` callback threw. Attaform read no step from it, so the wizard stays where it is.',
    'wizard-persist':
      'a `useWizard({ persist })` callback threw. Attaform navigated anyway, so the step is live but unrecorded.',
    'wizard-default-statuses':
      'a `useWizard({ defaultStatuses })` factory threw or rejected. Attaform seeded no statuses, the same as omitting the option.',
  }
  console.error(
    `[attaform] ${advice[site]} Attaform has nowhere to surface this, so it must not ` +
      `throw; wrap your own try/catch if the failure is recoverable. Original error:`,
    err
  )
}

/**
 * Invoke `fn` and return `fallback` if it throws.
 *
 * `fallback` is always a value the walkers already treat as "nothing
 * here" (`undefined` at every current site), so a contained throw
 * degrades to the same state as a field the schema never described, or
 * a step slot the consumer wrote as `null`. That is the honest outcome:
 * the consumer's function was the only thing that knew the answer, and
 * it did not produce one.
 *
 * `detail` distinguishes two call sites of the same kind, so a wizard
 * can say WHICH slot broke. Omit it where the site is already unique.
 *
 * Deliberately not async-aware. Every site is synchronous, and a
 * rejected thenable returned from one of these would be the consumer's
 * value to handle, not an escape for this helper to swallow.
 */
export function callConsumerFn<T>(
  fn: () => T,
  fallback: T,
  site: ConsumerCallSite,
  detail?: string
): T {
  try {
    return fn()
  } catch (err) {
    reportConsumerThrow(site, detail, err)
    return fallback
  }
}

/**
 * Read `key` off a consumer-supplied object, returning `undefined` if
 * the read throws.
 *
 * Separate from `callConsumerFn` because the hazard differs, and so
 * does the judgement about where to apply it. Attaform walks the values a
 * consumer writes, and a property read is dangerous only when the property
 * is an accessor: a getter on a class instance, a `computed` reached
 * through a Vue reactive object, a Proxy trap. That is rare enough that
 * guarding every read in every hot walker would buy safety at a permanent
 * tax on the common case.
 *
 * So this is applied at the walk boundaries that take a consumer value
 * whole and rebuild it (`unset-walker`), not at every property access
 * in the codebase. A throwing getter deeper inside a value Attaform
 * merely carries by reference never gets read by Attaform at all, which
 * is the point of carrying values by reference.
 *
 * Silent by design, unlike the invoked-function sites above. A throwing
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
