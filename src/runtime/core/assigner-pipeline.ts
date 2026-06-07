/**
 * The v-register assigner pipeline: the machinery that turns a DOM-side
 * value into a committed form write. Lifted out of `directive.ts` into
 * this leaf module so `directive-file.ts` can import `fireAssigner` /
 * `setAssignFunction` without re-creating the `directive.ts` <->
 * `directive-file.ts` import cycle.
 *
 * Owns the `assignKey` symbol slot, the default / consumer-wrapped
 * assigner tags + predicates, the `transforms: [...]` runner (sync-fast,
 * async-deferred), coercion application, and the `getModelAssigner` /
 * `setAssignFunction` install path. The directive definitions (text /
 * checkbox / radio / select) live in `directive.ts` and call in here.
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
 * Most consumers never need this — the built-in directives wire
 * default assigners for text inputs, checkboxes, radios, and selects.
 */
// `Symbol.for(...)` so `el[assignKey] = ...` round-trips across
// duplicate copies of attaform. The directive (which writes the
// default assigner) and the consumer-side composables/utilities (which
// may read or override it) must agree on the key, or the directive
// stops recognising consumer-installed assigners after the page is
// served from a Vite-optimised copy that's distinct from the one the
// directive registration came from. Same reasoning for `listenersKey`
// and `DEFAULT_ASSIGNER_TAG` below.
export const assignKey: unique symbol = Symbol.for('attaform:assign-key')

/**
 * Symbol-tagged on default-installed assigners so listener bodies can
 * tell "no consumer override" from "consumer-installed assigner". The
 * bail check (`shouldBailListener`) uses this to avoid the bubbled-
 * write bug for non-supported roots: the default assigner reading
 * `el.value` off a `<div>` would clobber form state with `''` /
 * `undefined` on every keystroke from a descendant input. A consumer-
 * installed assigner (via `assignKey` or `onUpdate:registerValue`)
 * has explicitly opted into reading whatever the listener captures,
 * so the bail doesn't apply.
 */
const DEFAULT_ASSIGNER_TAG: unique symbol = Symbol.for('attaform:default-assigner-tag')

type DefaultAssignerCarrier = { [DEFAULT_ASSIGNER_TAG]?: boolean }

export function isDefaultAssigner(fn: unknown): boolean {
  return typeof fn === 'function' && (fn as DefaultAssignerCarrier)[DEFAULT_ASSIGNER_TAG] === true
}

/**
 * Symbol-tagged on wrappers `getModelAssigner` produces for the
 * `@update:registerValue` install path. The tag lets `fireAssigner`
 * recognize an already-wrapped consumer handler and call it raw
 * (the wrapper already runs transforms + coerce + supplies `rv`).
 * Without the tag, fire-time would re-wrap and apply transforms
 * twice for that install path.
 */
const CONSUMER_WRAPPED_TAG: unique symbol = Symbol.for('attaform:consumer-wrapped-assigner')

type ConsumerWrappedCarrier = { [CONSUMER_WRAPPED_TAG]?: boolean }

function isConsumerWrapped(fn: unknown): boolean {
  return typeof fn === 'function' && (fn as ConsumerWrappedCarrier)[CONSUMER_WRAPPED_TAG] === true
}

/**
 * Fire-time entry point for invoking whatever currently sits at
 * `el[assignKey]`. Replaces direct `el[assignKey]?.(value)` calls so
 * the directive's two consumer-install paths produce the same fire-
 * time contract:
 *
 *   - `@update:registerValue` (vnode-prop listener): wrapped at
 *     `created`-time by `getModelAssigner`, tagged with
 *     `CONSUMER_WRAPPED_TAG`. Called raw here — its own body runs
 *     `runTransforms` + `applyCoerce` and supplies `rv` to the user
 *     handler.
 *   - `el[assignKey] = fn` (pre- or post-install via companion
 *     directive / `onMounted` / ref-callback): raw consumer fn,
 *     untagged. JIT-wrapped here so the user sees the same
 *     `(post-transform-post-coerce value, rv)` shape.
 *
 * The default-tagged sentinel runs its own pipeline internally and is
 * also called raw. A `registerValue` that isn't a `RegisterValue`
 * (e.g. `useRegister` returned `undefined` AND a consumer pre-
 * installed an assigner before `setAssignFunction` would have
 * installed the noop) falls through with `(value, undefined)` —
 * defensive; the documented happy path always has a real `rv`.
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
  // JIT-wrap the raw consumer fn: it gets the resolved, coerced value
  // (sync, or via the async kickoff). No `syncDom` — a consumer-installed
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
 * stays byte-for-byte synchronous until a transform returns a thenable;
 * only then does the result switch to `kind: 'async'`, handing the caller
 * a `run` thunk (the deferred remainder of the chain) plus the run's
 * abort `holder` so the deferred orchestrator can open a store-backed run
 * and commit the resolved value.
 *
 *  - `kind: 'sync', ok: true`  → committed-ready value (today's fast path).
 *  - `kind: 'sync', ok: false` → a sync transform threw; the write aborts
 *    (the helper already logged via `console.error`).
 *  - `kind: 'async'`           → a transform returned a thenable. `run`
 *    resolves to the post-chain value (or rejects on a downstream throw /
 *    rejection); `holder` carries the lazy abort signal.
 */
type TransformResult =
  | { kind: 'sync'; ok: true; value: unknown }
  | { kind: 'sync'; ok: false }
  | { kind: 'async'; run: () => Promise<unknown>; holder: TransformAbortHolder }

/**
 * A transform as the runner invokes it: the public `RegisterTransform`
 * receives the transform context as its second argument. The cast is
 * internal to the call site — `RegisterTransform`'s public single-arg
 * shape stays the stable surface; passing `ctx` to a body that ignores
 * it is a no-op.
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
 * doesn't crash the host app.
 *
 * The chain is sync-fast: while each transform returns a non-thenable the
 * loop stays synchronous (no Promise allocation, no abort controller, no
 * busy state) and the result commits in the same tick — byte-for-byte
 * today's behavior. The moment a transform returns a thenable, that index
 * and everything after it are captured in a `run` thunk and handed back
 * as a `kind: 'async'` result; the directive's deferred orchestrator
 * opens a store-backed run, awaits it, and commits the resolved value
 * (latest-request-wins).
 *
 * On a sync throw the pipeline aborts (subsequent transforms don't run),
 * nothing is written, and the caller returns `false`. An async failure (a
 * downstream throw or a rejected thenable) rejects `run` instead — the
 * orchestrator routes it to `field.transformError` with no console noise
 * (a network / file failure is an expected channel, not a programmer bug).
 *
 * `transforms` on `RegisterValue` is optional (test fixtures and custom
 * integrations can omit it); a missing array short-circuits to the
 * original value with no allocation (not even a ctx).
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
 * never holds the store), awaits the chain, and — only if this run is
 * still the live one (latest-request-wins) — commits the resolved value
 * and repaints the bound element. Every path ends in `endTransform`, and
 * the whole thing is `.then`-guarded so a rejected transform never
 * escapes as an unhandled rejection.
 *
 * `commit` is the write step (default assigner → `setValueWithInternalPath`;
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
      // the path (latest-write-wins) — ending first means a transform
      // landing its OWN resolved value isn't caught by that supersede.
      rv.endTransform(token)
      if (!live) return
      const coerced = applyCoerce(value, rv)
      const wrote = commit(coerced)
      // A `false` commit is the slim-primitive gate refusing the resolved
      // value — surface it on `transformError` and leave the DOM showing
      // the user's raw input rather than reverting to stale storage. A
      // successful (or override-`undefined`) commit repaints to the
      // normalized result.
      if (wrote === false) rv.setTransformError(transformGateRejectedError(rv.path))
      else syncDom?.()
    },
    (err: unknown) => {
      // A rejection on a superseded / cancelled run (commonly an
      // AbortError) is silently discarded — only the live run's failure
      // reaches the consumer.
      if (rv.isCurrentTransform(token)) rv.setTransformError(toTransformError(err))
      rv.endTransform(token)
    }
  )
}

/**
 * Log a transform throw. Dev message includes path, index, transform name,
 * remediation hint, and the original error (with message + stack). Prod
 * message is a fixed string with NONE of those — transform bodies are
 * consumer code we don't control, so error messages and stack frames are
 * an information-leak surface (consumer-typed values, file paths, internal
 * function names). Set `NODE_ENV=development` to surface details.
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
      `[attaform] transform threw for path '${path}' (index ${index}${namePart}) — ` +
        `write aborted. Transforms must not throw; wrap your own try/catch if the throw is recoverable. ` +
        `Original error:`,
      err
    )
  } else {
    console.error(
      `[attaform] transform error — write aborted (set NODE_ENV=development for details).`
    )
  }
}

/**
 * Apply the field's coerce closure (built at register-time by
 * `buildCoerceFn`) to a post-transform value. Identity when the
 * RegisterValue is a hand-rolled mock that omits the field, or when
 * coercion was disabled / no coerction target was resolved at the
 * path. The closure itself runs the registry rule, post-validates
 * the result, and falls back to the original on any rule failure
 * (throw, wrong-kind, NaN) — see `schema-coerce.ts` for details.
 */
export function applyCoerce(value: unknown, registerValue: RegisterValue): unknown {
  return registerValue.coerce !== undefined ? registerValue.coerce(value) : value
}

/**
 * Run one write through the transform pipeline, then commit it. The
 * shared skeleton behind every assigner (`fireAssigner` plus
 * `getModelAssigner`'s override / multi-listener / default variants):
 * run transforms; when a transform goes async, hand off to
 * `kickoffAsyncTransform` and return `true` so the listener treats the
 * write as accepted; on a sync throw abort with `false`; otherwise
 * coerce and pass the value to `commit`.
 *
 * `commit` receives the post-transform, post-coerce value on the sync
 * path and (via the kickoff) on the async path. `syncDom` repaints the
 * bound element after an async commit; it is `undefined` on
 * consumer-override paths that own their own DOM.
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
  // developer escape hatch — Vue wires `onUpdate:registerValue` as either a
  // single function or an array of functions depending on how many listeners
  // are bound. We narrow before dispatching.
  //
  // Both shapes invoke the consumer's handler as `(value, registerValue)` so
  // a top-level handler can call `rv.setValueWithInternalPath(value)` to
  // forward the write into form state without having to capture `rv` via
  // closure. The RV auto-attaches per-element persistence meta from its
  // bound element when no `meta` is supplied — same code path the
  // default assigner below uses. Advanced consumers who want to suppress
  // (or override) persistence on a specific write pass an explicit
  // `meta` second argument; the RV honors it verbatim.
  //
  // Vue 3.5's compiler emits TWO different prop keys for `@update:registerValue`
  // depending on context. For native elements with an uppercase letter in the
  // event name (e.g. the `V` in `registerValue`), the compiler preserves
  // casing via the `on:` prefix form: `"on:update:registerValue"`. For
  // components, vnode lifecycle events, or all-lowercase event names, it
  // emits `"onUpdate:registerValue"`. Render-function authors using `h(...)`
  // pick whichever key they like. We read both forms; for components the
  // `onUpdate:` form normally wins, for plain `<input v-register>` the
  // `on:update:` form is what survives the compiler.
  // See @vue/compiler-core/transformOn (search for `[A-Z]/.test(rawName)`).
  const fn: unknown =
    vnode.props?.['onUpdate:registerValue'] ?? vnode.props?.['on:update:registerValue']
  if (isArray(fn)) {
    const fnArr = fn.filter((x) => isFunction(x)) as ((...args: unknown[]) => unknown)[]
    const wrapped: CustomDirectiveRegisterAssignerFn = (value) => {
      // Transforms run BEFORE the override sees the value. A consumer
      // who declared `transforms: [...]` intended "always normalize"; a
      // silent bypass on override would be the surprise. If they want
      // raw, they don't register transforms.
      // Schema-driven coerce runs AFTER transforms (the final type-fixup
      // before storage); override handlers receive the coerced value. The
      // multi-listener case has no single boolean to surface, so commit
      // returns undefined ("succeeded"), matching the single-handler
      // contract. No `syncDom` — a consumer override owns its own DOM.
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
  // Default-installed assigner. Tagged so the listener-body bail
  // (`shouldBailListener`) can distinguish it from consumer overrides
  // and prevent the bubbled-write bug on non-supported roots.
  //
  // Returns the underlying setValue boolean so listeners (e.g.
  // vRegisterSelect's change handler) can detect rejection and gate
  // post-write side effects like the `_assigning` flag.
  const defaultAssigner: CustomDirectiveRegisterAssignerFn = (value) => {
    // Schema-aware undefined short-circuit: when the path admits
    // undefined and the commit IS undefined (the text-input listener
    // mapped a DOM clear), skip transforms + coerce. Consumer-supplied
    // transforms today never receive undefined, so passing it through
    // would force every existing transform to add a `if (v == null)`
    // guard. Treat undefined as the schema-side absent signal that
    // bypasses normalization. Coerce already passes undefined cleanly
    // for paths that admit it, so skipping is a clarity win.
    if (value === undefined && registerValue.acceptsUndefined) {
      // Meta omitted on purpose: the RV's `setValueWithInternalPath`
      // auto-derives `{ persist: hasOptIn(elementId, path) }` from its
      // bound element when no meta is supplied. Same auto-derivation
      // path consumer-installed assigners get for free.
      return registerValue.setValueWithInternalPath(undefined)
    }
    // Default write path. On the async branch the resolved value lands
    // via setValueWithInternalPath, then `_syncFromStorage` (captured at
    // `created`-time) repaints the bound element; returning `true` lets
    // the listener skip its synchronous force-sync (the write is already
    // in flight — `isTransforming(value)` is true).
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
  // Tag so `shouldBailListener` recognizes this as the default,
  // alongside the real default-model assigner.
  ;(noop as unknown as DefaultAssignerCarrier)[DEFAULT_ASSIGNER_TAG] = true
  return noop
}

export function setAssignFunction(
  el: HTMLElement & { [AssignKey: symbol]: CustomDirectiveRegisterAssignerFn },
  vnode: VNode,
  value: RegisterValue<unknown> | undefined
) {
  // Pre-install respect: if the consumer installed `el[assignKey]`
  // BEFORE this directive's `created` hook ran (e.g. via a companion
  // directive ordered first in `withDirectives`, or by a custom
  // element's constructor), preserve their assigner across the
  // entire directive lifecycle. The default assigner is a fallback
  // for the common case where nobody overrides; it should NEVER
  // clobber an explicit consumer override.
  //
  // Wrappers produced by `getModelAssigner` for the
  // `@update:registerValue` install path are tagged with
  // `CONSUMER_WRAPPED_TAG`; bailing on them too would freeze the
  // listener at the first vnode's prop value, so a parent re-render
  // that swaps the handler reference would never take effect. Allow
  // re-derivation in that case — the freshly produced wrapper closes
  // over the new vnode's prop function.
  const current = el[assignKey]
  if (current !== undefined && !isDefaultAssigner(current) && !isConsumerWrapped(current)) {
    return
  }

  // Invariant 4: `v-register="undefined"` is a graceful no-op. The
  // composable `useRegister()` returns `ComputedRef<undefined>` when
  // a child is rendered standalone (no parent passed registerValue);
  // the inner `<input v-register="register">` lands undefined here
  // and we silently install a no-op assigner. The composable already
  // emitted its own dev-warn at the call site, so a second warn from
  // the directive would be redundant noise.
  //
  // Other non-RegisterValue types still fall through to the warn —
  // those are likely typos (passing a string, an object literal, the
  // form API itself, etc.) and the developer benefits from a hint.
  if (value === undefined) {
    el[assignKey] = makeNoopAssigner()
    return
  }
  if (!isRegisterValue(value)) {
    warn(
      `v-register expected a RegisterValue, got '${typeof value}'. ` +
        `Bind to form.register('field') — not the field's ref, value, or path string.`
    )
    el[assignKey] = makeNoopAssigner()
    return
  }

  el[assignKey] = getModelAssigner(el, vnode, value)
}
