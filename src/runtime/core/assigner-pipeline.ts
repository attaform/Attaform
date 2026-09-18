/**
 * The v-register assigner pipeline: the machinery that turns a DOM-side
 * value into a committed form write. It owns the `assignKey` symbol slot,
 * the default / consumer-wrapped assigner tags and predicates, the
 * `transforms: [...]` runner (sync-fast, async-deferred), coercion
 * application, and the `getModelAssigner` / `setAssignFunction` install
 * path. The directive definitions (text / checkbox / radio / select) live
 * in `directive.ts` and call in here.
 *
 * Keep this a leaf module: `directive-file.ts` imports `fireAssigner` and
 * `setAssignFunction`, so folding them back into `directive.ts` makes a
 * `directive.ts` <-> `directive-file.ts` cycle.
 */
import { invokeArrayFns, isArray, isFunction } from './vue-shared-shim'
import type { VNode } from 'vue'
import { warn } from 'vue'
import { isRegisterValue } from './register-protocol'
import { __DEV__ } from './dev'
import type {
  CustomDirectiveRegisterAssignerFn,
  InternalRegisterValue,
  RegisterTransform,
  RegisterValue,
  TransformAbortHolder,
  TransformContext,
} from '../types/types-api'
import type { PathKey } from './paths'

/**
 * Symbol slot used by custom directive integrations to install an
 * assigner on the bound element. Read by the v-register directive
 * when a DOM event fires:
 *
 * ```ts
 * import { assignKey } from 'attaform'
 * el[assignKey] = (value) => myCustomWriter(value)
 * ```
 *
 * Most consumers never need this: the built-in directives wire default
 * assigners for text inputs, checkboxes, radios, and selects.
 */
// `Symbol.for` so the key round-trips across duplicate copies of
// Attaform. The directive writes the default assigner and consumer-side
// composables read or override it; were a Vite-optimised copy to give
// them distinct symbols, the directive would stop recognising
// consumer-installed assigners. Same for `listenersKey` and
// `DEFAULT_ASSIGNER_TAG` below.
export const assignKey: unique symbol = Symbol.for('attaform:assign-key')

/**
 * Symbol-tagged on default-installed assigners so listener bodies can
 * tell "no consumer override" from "consumer-installed assigner".
 * `shouldBailListener` reads it to keep a bubbled write off a
 * non-supported root: the default assigner reading `el.value` off a
 * `<div>` would clobber form state with `''` / `undefined` on every
 * keystroke from a descendant input. A consumer-installed assigner (via
 * `assignKey` or `onUpdate:registerValue`) opted into reading whatever
 * the listener captures, so the bail does not apply to it.
 */
const DEFAULT_ASSIGNER_TAG: unique symbol = Symbol.for('attaform:default-assigner-tag')

type DefaultAssignerCarrier = { [DEFAULT_ASSIGNER_TAG]?: boolean }

export function isDefaultAssigner(fn: unknown): boolean {
  return typeof fn === 'function' && (fn as DefaultAssignerCarrier)[DEFAULT_ASSIGNER_TAG] === true
}

/**
 * Symbol-tagged on wrappers `getModelAssigner` produces for the
 * `@update:registerValue` install path, so `fireAssigner` calls an
 * already-wrapped consumer handler raw: the wrapper runs transforms and
 * coerce itself and supplies `rv`. Untagged, it would be wrapped a second
 * time and its transforms would run twice.
 */
const CONSUMER_WRAPPED_TAG: unique symbol = Symbol.for('attaform:consumer-wrapped-assigner')

type ConsumerWrappedCarrier = { [CONSUMER_WRAPPED_TAG]?: boolean }

function isConsumerWrapped(fn: unknown): boolean {
  return typeof fn === 'function' && (fn as ConsumerWrappedCarrier)[CONSUMER_WRAPPED_TAG] === true
}

/**
 * Fire-time entry point for whatever currently sits at `el[assignKey]`.
 * Every call site routes through here rather than calling
 * `el[assignKey]?.(value)`, so both consumer-install paths share one
 * fire-time contract:
 *
 *   - `@update:registerValue` (vnode-prop listener): wrapped at
 *     `created`-time by `getModelAssigner` and tagged
 *     `CONSUMER_WRAPPED_TAG`. Called raw, since its own body runs
 *     `runTransforms` and `applyCoerce` and supplies `rv`.
 *   - `el[assignKey] = fn` (installed by a companion directive,
 *     `onMounted`, or a ref callback): a raw consumer fn, untagged.
 *     Wrapped here so the handler sees the same
 *     `(post-transform-post-coerce value, rv)` shape.
 *
 * The default-tagged sentinel runs its own pipeline internally and is
 * also called raw. A `registerValue` that is not a `RegisterValue`
 * (`useRegister` returned `undefined` AND a consumer pre-installed an
 * assigner before the noop would have landed) falls through with
 * `(value, undefined)`; the documented path always has a real `rv`.
 */
export function fireAssigner(
  el: HTMLElement & { [k: symbol]: CustomDirectiveRegisterAssignerFn },
  registerValue: unknown,
  value: unknown
): boolean | undefined {
  const fn = el[assignKey]
  if (fn === undefined) return undefined
  if (isDefaultAssigner(fn) || isConsumerWrapped(fn)) {
    return fn(value)
  }
  if (!isRegisterValue(registerValue)) {
    return fn(value, undefined)
  }
  // Wrap the raw consumer fn: it gets the resolved, coerced value (sync,
  // or via the async kickoff). No `syncDom`, since a consumer-installed
  // assigner owns its own DOM.
  return wrapWithTransforms(
    value,
    registerValue,
    (coerced) => fn(coerced, registerValue),
    undefined
  )
}

/**
 * Result of running a field's `transforms: [...]` pipeline. The chain
 * stays synchronous until a transform returns a thenable; only then does
 * the result switch to `kind: 'async'`, handing back a `run` thunk (the
 * deferred remainder of the chain) plus the run's abort `holder`.
 *
 *  - `kind: 'sync', ok: true`  → commit-ready value, the fast path.
 *  - `kind: 'sync', ok: false` → a sync transform threw; the write aborts
 *    (`logTransformFailure` has already reported it).
 *  - `kind: 'async'`           → `run` resolves to the post-chain value
 *    (or rejects on a downstream throw / rejection) and `holder` carries
 *    the lazy abort signal.
 */
type TransformResult =
  | { kind: 'sync'; ok: true; value: unknown }
  | { kind: 'sync'; ok: false }
  | { kind: 'async'; run: () => Promise<unknown>; holder: TransformAbortHolder }

/**
 * A transform as the runner invokes it: the public `RegisterTransform`
 * receives the transform context as its second argument. The cast stays
 * internal to the call site so `RegisterTransform`'s single-arg shape
 * remains the public surface, and passing `ctx` to a body that ignores it
 * is a no-op.
 */
type CtxTransform = (value: unknown, ctx: TransformContext) => unknown

/**
 * Thenable check (not `instanceof Promise`) so a cross-realm or
 * non-native promise still routes async.
 */
function isThenable(x: unknown): x is PromiseLike<unknown> {
  return (
    x !== null &&
    (typeof x === 'object' || typeof x === 'function') &&
    typeof (x as { then?: unknown }).then === 'function'
  )
}

/**
 * Build the lazy transform context for one pipeline run. `ctx.signal`
 * materializes its `AbortController` only on first access, so a chain
 * that never reaches for it allocates nothing. The store latches
 * `holder.aborted` at teardown, so a signal touched AFTER the run was
 * superseded is born aborted rather than live.
 */
function makeTransformContext(): { ctx: TransformContext; holder: TransformAbortHolder } {
  const holder: TransformAbortHolder = { controller: null, aborted: false }
  const ctx: TransformContext = {
    get signal(): AbortSignal {
      if (holder.controller === null) {
        holder.controller = new AbortController()
        if (holder.aborted) holder.controller.abort()
      }
      return holder.controller.signal
    },
  }
  return { ctx, holder }
}

/**
 * Apply the field's transform pipeline to a value. Each transform runs
 * inside a per-call try/catch so a buggy or defensive-throw transform
 * cannot escape into the host app (#608).
 *
 * The chain is sync-fast: while each transform returns a non-thenable the
 * loop stays synchronous (no Promise allocation, no abort controller, no
 * busy state) and the result commits in the same tick. The moment one
 * returns a thenable, that index and everything after it are captured in
 * a `run` thunk and handed back as `kind: 'async'`; the directive's
 * deferred orchestrator opens a store-backed run, awaits it, and commits
 * the resolved value (latest-request-wins).
 *
 * A sync throw aborts the pipeline (later transforms do not run), writes
 * nothing, and returns `false` to the caller. An async failure rejects
 * `run` instead, and the orchestrator routes it to `field.transformError`
 * with no console noise: a network or file failure is an expected
 * channel, not a programmer bug.
 *
 * `transforms` is optional on `RegisterValue` (test fixtures and custom
 * integrations omit it); a missing array short-circuits to the original
 * value allocating nothing, not even a ctx.
 */
function runTransforms(initial: unknown, registerValue: RegisterValue): TransformResult {
  const transforms = registerValue.transforms
  if (transforms === undefined || transforms.length === 0) {
    return { kind: 'sync', ok: true, value: initial }
  }
  const { ctx, holder } = makeTransformContext()
  let v = initial
  for (let i = 0; i < transforms.length; i++) {
    const fn = transforms[i] as RegisterTransform
    let out: unknown
    try {
      out = (fn as CtxTransform)(v, ctx)
    } catch (err) {
      logTransformFailure(registerValue.path, i, fn, err)
      return { kind: 'sync', ok: false }
    }
    if (isThenable(out)) {
      // Switch to async for this index and everything after it. The
      // remaining transforms run in a `.then` chain seeded from the
      // thenable; a throw or rejection anywhere downstream rejects `run`,
      // which the orchestrator turns into `field.transformError`.
      const rest = transforms.slice(i + 1) as RegisterTransform[]
      const seed = out
      const run = (): Promise<unknown> =>
        rest.reduce<Promise<unknown>>(
          (acc, next) => acc.then((value) => (next as CtxTransform)(value, ctx)),
          Promise.resolve(seed)
        )
      return { kind: 'async', run, holder }
    }
    v = out
  }
  return { kind: 'sync', ok: true, value: v }
}

/**
 * Drive a deferred (async) transform run to its commit. Opens a store-
 * backed run through the RegisterValue's lifecycle hooks (the directive
 * never holds the store), awaits the chain, and commits the resolved
 * value plus a repaint only if this run is still the live one
 * (latest-request-wins). Every path ends in `endTransform`, and the whole
 * thing is `.then`-guarded so a rejected transform never escapes as an
 * unhandled rejection.
 *
 * `commit` is the write step (default assigner → `setValueWithInternalPath`,
 * a consumer override → invoke the handler). `syncDom` repaints the bound
 * element from the freshly-committed storage; it is `undefined` on
 * consumer-override paths, where the consumer owns its own DOM.
 */
function kickoffAsyncTransform(
  rv: InternalRegisterValue,
  holder: TransformAbortHolder,
  run: () => Promise<unknown>,
  commit: (coerced: unknown) => boolean | undefined,
  syncDom: (() => void) | undefined
): void {
  const token = rv.beginTransform(holder)
  void run().then(
    (value) => {
      const live = rv.isCurrentTransform(token)
      // Release this run BEFORE committing. The commit funnels through the
      // store's write chokepoint, which supersedes in-flight transforms on
      // the path (latest-write-wins), so ending first keeps a transform
      // landing its OWN resolved value out of that supersede.
      rv.endTransform(token)
      if (!live) return
      const coerced = applyCoerce(value, rv)
      const wrote = commit(coerced)
      // A `false` commit is the slim-primitive gate refusing the resolved
      // value: surface it on `transformError` and leave the DOM showing
      // the user's raw input rather than reverting to stale storage. A
      // successful (or override-`undefined`) commit repaints to the
      // normalized result.
      if (wrote === false) rv.setTransformError(transformGateRejectedError(rv.path))
      else syncDom?.()
    },
    (err: unknown) => {
      // A rejection on a superseded or cancelled run (commonly an
      // AbortError) is discarded silently; only the live run's failure
      // reaches the consumer.
      if (rv.isCurrentTransform(token)) rv.setTransformError(toTransformError(err))
      rv.endTransform(token)
    }
  )
}

/**
 * Log a transform throw. The dev message carries path, index, transform
 * name, a remediation hint and the original error with its stack. The
 * prod message is the bare AF14 code with none of those, because a
 * transform body is consumer code: its error message and stack frames
 * leak consumer-typed values, file paths and internal names. Set
 * `NODE_ENV=development` to surface the details.
 */
function logTransformFailure(
  path: PathKey,
  index: number,
  fn: RegisterTransform,
  err: unknown
): void {
  if (__DEV__) {
    const namePart = fn.name !== '' ? `, '${fn.name}'` : ''
    console.error(
      `[attaform] transform threw for path '${path}' (index ${index}${namePart}). ` +
        `Write aborted. Transforms must not throw; wrap your own try/catch if the throw is recoverable. ` +
        `Original error:`,
      err
    )
  } else {
    console.error('[attaform] AF14 attaform.dev/e/af14')
  }
}

/**
 * Apply the field's coerce closure (built at register-time by
 * `buildCoerceFn`) to a post-transform value. Identity when the
 * RegisterValue is a hand-rolled mock that omits the field, when coercion
 * is disabled, or when the path resolved no unambiguous coercion target.
 * The closure runs the two built-in rules, string → number and
 * string → boolean, and passes a token neither one accepts straight
 * through for the slim gate to rule on. See `schema-coerce.ts`.
 */
export function applyCoerce(value: unknown, registerValue: RegisterValue): unknown {
  return registerValue.coerce !== undefined ? registerValue.coerce(value) : value
}

/**
 * Run one write through the transform pipeline, then commit it. This is
 * the shared skeleton behind every assigner (`fireAssigner` plus
 * `getModelAssigner`'s override / multi-listener / default variants): run
 * transforms; when one goes async, hand off to `kickoffAsyncTransform`
 * and return `true` so the listener treats the write as accepted; on a
 * sync throw abort with `false`; otherwise coerce and pass the value to
 * `commit`.
 *
 * `commit` receives the post-transform, post-coerce value on both paths.
 * `syncDom` repaints the bound element after an async commit; it is
 * `undefined` on consumer-override paths that own their own DOM.
 */
function wrapWithTransforms(
  value: unknown,
  registerValue: RegisterValue,
  commit: (coerced: unknown) => boolean | undefined,
  syncDom: (() => void) | undefined
): boolean | undefined {
  const r = runTransforms(value, registerValue)
  if (r.kind === 'async') {
    kickoffAsyncTransform(registerValue as InternalRegisterValue, r.holder, r.run, commit, syncDom)
    return true
  }
  if (!r.ok) return false
  const coerced = applyCoerce(r.value, registerValue)
  return commit(coerced)
}

/**
 * Normalize a rejected async transform's reason into an `Error` for the
 * `field.transformError` channel. Mirrors the submit path's `toError`,
 * with transform-appropriate wording for the rare non-Error rejection.
 */
function toTransformError(value: unknown): Error {
  if (value instanceof Error) return value
  const message =
    typeof value === 'string' && value.length > 0
      ? value
      : `Transform rejected with a non-Error value (${typeof value})`
  return new Error(message, { cause: value })
}

/**
 * The error surfaced on `field.transformError` when an async transform
 * resolved a value the field's slim-primitive gate refused (the commit
 * returned `false`). A structured channel the consumer reads, not a
 * console log, so naming the field path is safe here.
 */
function transformGateRejectedError(path: PathKey): Error {
  return new Error(
    `[attaform] transform result for path '${path}' was rejected by the field's type gate ` +
      `(the resolved value did not fit the schema slot).`
  )
}

const getModelAssigner = (
  el: HTMLElement & { _syncFromStorage?: () => void },
  vnode: VNode,
  registerValue: RegisterValue
): CustomDirectiveRegisterAssignerFn => {
  // The developer escape hatch. Vue wires `onUpdate:registerValue` as
  // either a single function or an array of functions depending on how
  // many listeners are bound, so narrow before dispatching. Both shapes
  // invoke the consumer's handler as `(value, registerValue)`, letting a
  // top-level handler call `rv.setValueWithInternalPath(value)` to forward
  // the write into form state without capturing `rv` by closure.
  //
  // Vue 3.5's compiler emits TWO different prop keys for
  // `@update:registerValue` depending on context. For a native element
  // whose event name carries an uppercase letter (the `V` in
  // `registerValue`) it preserves casing through the `on:` prefix form,
  // `"on:update:registerValue"`. For components, vnode lifecycle events,
  // or all-lowercase names it emits `"onUpdate:registerValue"`, and
  // render-function authors using `h(...)` pick whichever they like. Read
  // both: for components the `onUpdate:` form normally wins, and for a
  // plain `<input v-register>` the `on:update:` form is what survives the
  // compiler. See @vue/compiler-core/transformOn, `[A-Z]/.test(rawName)`.
  const fn: unknown =
    vnode.props?.['onUpdate:registerValue'] ?? vnode.props?.['on:update:registerValue']
  if (isArray(fn)) {
    const fnArr = fn.filter((x) => isFunction(x)) as ((...args: unknown[]) => unknown)[]
    const wrapped: CustomDirectiveRegisterAssignerFn = (value) => {
      // Transforms run BEFORE the override sees the value: a consumer who
      // declared `transforms: [...]` meant "always normalize", and a
      // silent bypass on override would be the surprise. Schema-driven
      // coerce runs after them, the last type fixup before storage, so an
      // override handler receives the coerced value. The multi-listener
      // case has no single boolean to surface, so commit returns
      // `undefined` ("succeeded") to match the single-handler contract.
      // No `syncDom`, since a consumer override owns its own DOM.
      return wrapWithTransforms(
        value,
        registerValue,
        (coerced) => {
          invokeArrayFns(fnArr, coerced, registerValue)
          return undefined
        },
        undefined
      )
    }
    ;(wrapped as unknown as ConsumerWrappedCarrier)[CONSUMER_WRAPPED_TAG] = true
    return wrapped
  }
  if (isFunction(fn)) {
    const handler = fn as CustomDirectiveRegisterAssignerFn
    const wrapped: CustomDirectiveRegisterAssignerFn = (value) => {
      return wrapWithTransforms(
        value,
        registerValue,
        (coerced) => handler(coerced, registerValue),
        undefined
      )
    }
    ;(wrapped as unknown as ConsumerWrappedCarrier)[CONSUMER_WRAPPED_TAG] = true
    return wrapped
  }
  // Default-installed assigner. Tagged so `shouldBailListener` can tell
  // it from a consumer override and keep a bubbled write off a
  // non-supported root. Returns the underlying setValue boolean so a
  // listener (vRegisterSelect's change handler, for one) can detect a
  // rejection and gate post-write side effects like the `_assigning` flag.
  const defaultAssigner: CustomDirectiveRegisterAssignerFn = (value) => {
    // Schema-aware undefined short-circuit: when the path admits
    // undefined and the value IS undefined (the text-input listener
    // mapped a DOM clear), skip transforms and coerce. undefined is the
    // schema-side absent signal, not a value to normalize, and passing it
    // through would force every consumer transform to open with an
    // `if (v == null)` guard.
    if (value === undefined && registerValue.acceptsUndefined) {
      return registerValue.setValueWithInternalPath(undefined)
    }
    // Default write path. On the async branch the resolved value lands
    // through `setValueWithInternalPath`, then `_syncFromStorage`
    // (captured at `created`-time) repaints the bound element. Returning
    // `true` lets the listener skip its synchronous force-sync, the write
    // being in flight already (`isTransforming(value)` is true).
    return wrapWithTransforms(
      value,
      registerValue,
      (coerced) => registerValue.setValueWithInternalPath(coerced),
      el._syncFromStorage
    )
  }
  ;(defaultAssigner as unknown as DefaultAssignerCarrier)[DEFAULT_ASSIGNER_TAG] = true
  return defaultAssigner
}

function makeNoopAssigner(): CustomDirectiveRegisterAssignerFn {
  const noop: CustomDirectiveRegisterAssignerFn = (_) => undefined
  // Tagged so `shouldBailListener` reads it as the default, alongside
  // the real default-model assigner.
  ;(noop as unknown as DefaultAssignerCarrier)[DEFAULT_ASSIGNER_TAG] = true
  return noop
}

export function setAssignFunction(
  el: HTMLElement & { [AssignKey: symbol]: CustomDirectiveRegisterAssignerFn },
  vnode: VNode,
  value: RegisterValue<unknown> | undefined
) {
  // Pre-install respect: an `el[assignKey]` the consumer installed BEFORE
  // this directive's `created` hook ran (a companion directive ordered
  // first in `withDirectives`, a custom element's constructor) survives
  // the whole directive lifecycle. The default assigner is the fallback
  // for when nobody overrides, and must never clobber an explicit one.
  //
  // `CONSUMER_WRAPPED_TAG` wrappers are the exception. Bailing on them too
  // would freeze the listener at the first vnode's prop value, so a parent
  // re-render that swapped the handler reference would never take effect;
  // re-deriving closes the fresh wrapper over the new prop.
  const current = el[assignKey]
  if (current !== undefined && !isDefaultAssigner(current) && !isConsumerWrapped(current)) {
    return
  }

  // `v-register="undefined"` is a graceful no-op. `useRegister()` returns
  // `ComputedRef<undefined>` when a child renders standalone (no parent
  // passed a registerValue), so the inner `<input v-register="register">`
  // lands undefined here and gets a silent no-op assigner. The composable
  // already dev-warned at the call site; a second warn here is noise.
  //
  // Every other non-RegisterValue type still falls through to the warn.
  // Those are typos (a string, an object literal, the form API itself),
  // and the hint is what the developer needs.
  if (value === undefined) {
    el[assignKey] = makeNoopAssigner()
    return
  }
  if (!isRegisterValue(value)) {
    if (__DEV__) {
      warn(
        `v-register expected a RegisterValue, got '${typeof value}'. ` +
          `Bind to form.register('field'), not the field's ref, value, or path string.`
      )
    }
    el[assignKey] = makeNoopAssigner()
    return
  }

  el[assignKey] = getModelAssigner(el, vnode, value)
}
