import {
  computed,
  getCurrentInstance,
  getCurrentScope,
  onScopeDispose,
  provide,
  ref,
  watch,
  type ComputedRef,
} from 'vue'
import { buildWizardGraph, WizardCycleError } from '../core/wizard-graph'
import { __DEV__ } from '../core/dev'
import { kAttaformAncestorWizard, useRegistry } from '../core/registry'
import { resolveTrichotomy } from '../core/resolve-default-values'
import { createWizardHistory, NOOP_WIZARD_HISTORY } from '../core/wizard-history'
import { buildWizardStatusesProxy } from '../core/wizard-statuses-proxy'
import { AttaformErrorCode } from '../core/error-codes'
import type {
  AggregateError,
  AnyForm,
  FormStatus,
  WizardValue,
  WizardFlow,
  WizardHistoryConfig,
  WizardNavOptions,
  WizardOnError,
  WizardOnSubmit,
  WizardOptions,
  WizardSubmitContext,
  WizardWarning,
  UseWizardReturnType,
} from '../types/types-wizard'
import type { OnInvalidSubmitPolicy, ValidationResponse } from '../types/types-api'

/** Pending sentinel returned by `wizard.statuses[key]` when the form hasn't
 *  yet wired a FormStore (defensive — useWizard guards against this, but
 *  the snapshot fallback keeps templates from crashing). */
const PENDING_STATUS: FormStatus = {
  valid: false,
  dirty: false,
  submitted: false,
  errorCount: 0,
}

/** Shape we read off each participating form at runtime. Loosely typed
 *  against `AnyForm` (which only requires `key` + optional `next`) — the
 *  runtime objects returned by `useForm` always satisfy this richer shape. */
type StatusSourceForm = {
  readonly meta: {
    readonly valid: boolean
    readonly dirty: boolean
    readonly submitted: boolean
    readonly errorCount: number
    readonly errors: ReadonlyArray<{
      readonly path: ReadonlyArray<string | number>
      readonly message: string
      readonly code?: string
    }>
  }
  readonly values: unknown
}

/** Subset of the form's public surface the wizard's submission walk
 *  exercises. The runtime objects returned by `useForm` always satisfy
 *  this shape; the loose typing keeps the wizard structural against
 *  every adapter's `UseFormReturnType<...>`. */
type SubmissionSourceForm = StatusSourceForm & {
  activate(): Promise<void>
  process(): Promise<ValidationResponse<unknown>>
  applyInvalidSubmitPolicy(policy?: OnInvalidSubmitPolicy): void
  reset(): void
  readonly meta: StatusSourceForm['meta'] & {
    readonly updatedAt: string | null
  }
  readonly hydrateError: { readonly message: string } | null | undefined
}

/**
 * Multistep-form orchestrator. Walks the static graph declared by
 * `useForm({ next })` declarations starting from `entryForm`, composing
 * the reachable forms into a wizard with navigation, status aggregation,
 * browser history, and lazy activation (so a step's async
 * `defaultValues` factory only fires once the step becomes current).
 *
 * Graph discovery rules:
 *  - The entry form's `next` field (identity ref or `{ pick, forms }`)
 *    declares its downstream neighbor(s); the walker BFS's from there
 *    through every reachable form.
 *  - Convergent paths are deduped by key — a form reached via multiple
 *    upstream paths shows up once in `allForms`.
 *  - Cycles throw `WizardCycleError` at construction; consumers who want
 *    intentional revisits use `wizard.goTo(key)`.
 *  - Single-step wizards (the entry form has no `next`) are valid; a
 *    one-time dev-warn notes the navigation surface is degenerate.
 *
 * Each reachable form gets a ref-count via `registry.trackConsumer(key)`.
 * This pins the FormStore for the wizard's lifetime — so a step's state
 * survives even when its component is unmounted between visits
 * (v-if pattern). The ref is released on `onScopeDispose`.
 */
export function useWizard(entryForm: AnyForm, options: WizardOptions = {}): UseWizardReturnType {
  const graph = buildWizardGraph(entryForm)
  const forms = graph.allForms
  const byKey = graph.byKey
  const formKeys = forms.map((form) => form.key)
  const seenKeys = new Set(formKeys)

  for (const warning of graph.warnings) {
    console.warn(warning.message)
  }

  // Resolve history config. `history` omitted → default on with the
  // standard `step` param. `history: true` → same defaults. `false` →
  // primitive replaced with a no-op (no DOM access, no popstate
  // subscription).
  const historyOption = options.history
  const historyConfig: Required<WizardHistoryConfig> = {
    enabled: historyOption !== false,
    param:
      typeof historyOption === 'object' && historyOption !== null
        ? (historyOption.param ?? 'step')
        : 'step',
  }
  const wizardHistory = historyConfig.enabled
    ? createWizardHistory(historyConfig.param)
    : NOOP_WIZARD_HISTORY
  // Resolve initial step. Priority: `getServerActiveStep()` (SSR
  // source of truth, returned identically on client) → URL
  // `?step=<key>` (reload preservation when no getter is wired) →
  // the entry form's `key` fallback. Unknown keys at any level fall
  // through so a stale link can't crash construction.
  const fromGetter = options.getServerActiveStep?.()
  const fromUrl = wizardHistory.read()
  let initialKey: string
  if (fromGetter !== undefined && seenKeys.has(fromGetter)) {
    initialKey = fromGetter
  } else if (fromUrl !== undefined && seenKeys.has(fromUrl)) {
    initialKey = fromUrl
  } else {
    initialKey = entryForm.key
  }
  const current = ref<string>(initialKey)

  // Runtime navigation audit log. Seeded with the initial step so the
  // trail always starts somewhere, then appended in `setCurrent` on every
  // distinct navigation (next / back / goTo / popstate). The setCurrent
  // identity-guard already drops no-op writes, so consecutive duplicates
  // never reach the push site. Append-only — back() does not pop the
  // trail; the array is the audit log the consumer reads for breadcrumbs
  // and tour-style "where you've been" UI.
  const visited = ref<string[]>([initialKey])

  // Replace the URL so it always reflects the active step on mount —
  // idempotent when the URL already named the correct key.
  wizardHistory.replace(initialKey)

  const registry = useRegistry()

  // SSR prefetch coordination — the wizard's activation gate for
  // non-current steps. On the server, enqueue the initial step (so its
  // factory runs inside the form's `onServerPrefetch` hook) and
  // explicitly skip every other step (so a transform mark or stray
  // `form.activate()` on a non-current step cannot leak that step's
  // factory). The client path goes through the per-form `activate()`
  // calls below — `skipPrefetch` is a no-op there since `shouldPrefetch`
  // is only read by the SSR drain.
  if (registry.ssr) {
    for (const key of formKeys) {
      if (key === initialKey) {
        registry.enqueuePrefetch(key)
      } else {
        registry.skipPrefetch(key)
      }
    }
  }

  // Activate the initial step's form synchronously. On the client this
  // fires the captured async factory immediately; on the server it
  // routes through `state.activate()` which both records the enqueue
  // intent and (via `onServerPrefetch`) drains the queue with the
  // actual factory call. Other steps stay dormant until navigation
  // activates them.
  const initialForm = byKey.get(initialKey) as unknown as
    | { activate?: () => Promise<void> }
    | undefined
  if (initialForm !== undefined && typeof initialForm.activate === 'function') {
    void initialForm.activate()
  }

  // Resolve `defaultStatuses` (the trichotomy mirror). Sync values
  // apply immediately at construction; async factories register and
  // populate `seedRef` on resolution. While the async seed is
  // pending, the status falls back to the pending sentinel.
  const seedRef = ref<Record<string, FormStatus> | undefined>(undefined)
  const seedInput = options.defaultStatuses
  if (seedInput !== undefined) {
    const resolved = resolveTrichotomy(seedInput)
    if (resolved.kind === 'sync') {
      seedRef.value = resolved.value
    } else {
      const eager = resolved.factory()
      if (eager instanceof Promise) {
        void eager.then((value) => {
          seedRef.value = value
        })
      } else {
        seedRef.value = eager
      }
    }
  }
  // Filter unknown seed keys with a dev warn. Likely a typo on the
  // consumer's side; the wizard ignores the entry and keeps the rest.
  if (seedRef.value !== undefined) {
    const unknownSeedKeys: string[] = []
    const seedMap = seedRef.value
    for (const seedKey of Object.keys(seedMap)) {
      if (!seenKeys.has(seedKey)) unknownSeedKeys.push(seedKey)
    }
    if (unknownSeedKeys.length > 0) {
      console.warn(
        `[attaform] useWizard.defaultStatuses: ignoring unknown key(s) ${unknownSeedKeys
          .map((k) => `"${k}"`)
          .join(', ')}. Known keys: ${formKeys.map((k) => `"${k}"`).join(', ')}.`
      )
      const cleaned: Record<string, FormStatus> = {}
      for (const seedKey of Object.keys(seedMap)) {
        if (seenKeys.has(seedKey)) cleaned[seedKey] = seedMap[seedKey] as FormStatus
      }
      seedRef.value = cleaned
    }
  }

  // Build per-form FormStatus computeds — each tracks its participating
  // form's `meta` reactively. Resolution priority:
  //   1. store.defaultsResolved === true → derive from form.meta
  //   2. else seed value for this key → frozen seed
  //   3. else → pending sentinel
  // `defaultsResolved` is the right gate (not `hydrating`) because
  // dormant lazy forms have `hydrating: false` BEFORE activation —
  // the factory hasn't fired, so meta is the trivial pending shape
  // rather than real data.
  const statusComputeds: Record<string, ComputedRef<FormStatus>> = {}
  for (const form of forms) {
    const source = form as unknown as StatusSourceForm
    const key = form.key
    statusComputeds[key] = computed<FormStatus>(() => {
      const store = registry.forms.get(key)
      const resolved = store?.defaultsResolved.value === true
      const meta = source.meta
      if (resolved && meta !== undefined && meta !== null) {
        return {
          valid: meta.valid,
          dirty: meta.dirty,
          submitted: meta.submitted,
          errorCount: meta.errorCount,
        }
      }
      const seedMap = seedRef.value
      if (seedMap !== undefined && Object.hasOwn(seedMap, key)) {
        return seedMap[key] as FormStatus
      }
      return PENDING_STATUS
    })
  }
  const statuses = buildWizardStatusesProxy<Record<string, FormStatus>>(statusComputeds)

  // `onStatusChange` handler captured once for both the per-form
  // material-change watch AND the synthetic nav-away invocation in
  // `setCurrent` below.
  const statusChangeHandler = options.onStatusChange

  // Wire per-form material-change watches. Fires only when the
  // 4-scalar tuple (`valid`, `dirty`, `submitted`, `errorCount`)
  // actually moves; identical writes don't re-fire. Async returns are
  // fire-and-forget — navigation is never gated on the handler's
  // promise.
  if (statusChangeHandler !== undefined) {
    for (const form of forms) {
      const key = form.key
      const statusComputed = statusComputeds[key]
      if (statusComputed === undefined) continue
      watch(statusComputed, (next, prev) => {
        if (
          prev !== undefined &&
          prev.valid === next.valid &&
          prev.dirty === next.dirty &&
          prev.submitted === next.submitted &&
          prev.errorCount === next.errorCount
        ) {
          return
        }
        void statusChangeHandler(next, form)
      })
    }
  }

  if (getCurrentScope() !== undefined) {
    const releases: Array<() => void> = []
    for (const key of formKeys) {
      releases.push(registry.trackConsumer(key))
    }
    onScopeDispose(() => {
      for (const release of releases) release()
      wizardHistory.dispose()
    })
  }

  function indexOf(key: string): number {
    return formKeys.indexOf(key)
  }

  // Cross-form aggregates. `allValues` exposes each form's existing
  // values proxy under its key — read-only by way of the proxies'
  // own traps. `allErrors` is a computed flat list ordered by BFS
  // walk, then per-form order.
  const allValuesObject: Record<string, unknown> = {}
  for (const form of forms) {
    const source = form as unknown as StatusSourceForm
    Object.defineProperty(allValuesObject, form.key, {
      enumerable: true,
      configurable: false,
      get: () => source.values,
    })
  }
  const allValues = allValuesObject

  // Progress — default `valid_count / total` (normalised) or override.
  // Wrapped in a computed so reactivity follows the underlying
  // statuses (default) or whatever reactive sources the override
  // touches.
  const progressOverride = options.progress
  const progress = computed<number>(() => {
    if (progressOverride !== undefined) {
      return progressOverride(forms)
    }
    if (forms.length === 0) return 0
    let valid = 0
    for (const form of forms) {
      const status = statusComputeds[form.key]?.value
      if (status?.valid === true) valid += 1
    }
    return valid / forms.length
  })

  const allErrors = computed<readonly AggregateError[]>(() => {
    const flat: AggregateError[] = []
    for (const form of forms) {
      const store = registry.forms.get(form.key)
      if (store?.defaultsResolved.value !== true) continue
      const source = form as unknown as StatusSourceForm
      const errors = source.meta?.errors
      if (errors === undefined) continue
      for (const error of errors) {
        const entry: { -readonly [P in keyof AggregateError]: AggregateError[P] } = {
          formKey: form.key,
          path: error.path,
          message: error.message,
        }
        if (error.code !== undefined) entry.code = error.code
        flat.push(entry)
      }
    }
    return flat
  })

  /**
   * Internal navigation. `historyMode` controls how the change is
   * reflected in `window.history`:
   *   - `'push'` (default for nav calls) — new history entry.
   *   - `'replace'` — overwrite the current entry (for
   *     `goTo({ replace: true })`).
   *   - `'silent'` — no write. Used by the popstate handler: the
   *     browser has already moved the entry, writing again would
   *     double-record.
   */
  function setCurrent(nextKey: string, historyMode: 'push' | 'replace' | 'silent' = 'push'): void {
    const priorKey = current.value
    if (priorKey === nextKey) return
    current.value = nextKey
    visited.value.push(nextKey)
    // Kick the new step's activation. `activate()` is idempotent — if
    // the form is already resolved (sync defaults / hydrated payload /
    // earlier visit re-using state), this returns a resolved promise
    // and nothing re-fires. On the server, `setCurrent` is uncommon
    // (initial step resolution wires the SSR queue at construction);
    // on the client this is the primary firing site for async-defaults
    // factories on navigation.
    const nextForm = byKey.get(nextKey) as unknown as { activate?: () => Promise<void> } | undefined
    if (nextForm !== undefined && typeof nextForm.activate === 'function') {
      void nextForm.activate()
    }
    if (historyMode === 'push') wizardHistory.push(nextKey)
    else if (historyMode === 'replace') wizardHistory.replace(nextKey)
    // Synthetic nav-away invocation. `onStatusChange` fires for the
    // form being left, regardless of whether anything materially
    // changed — useful for autosave-on-step-leave patterns.
    if (statusChangeHandler !== undefined) {
      const priorForm = byKey.get(priorKey)
      if (priorForm !== undefined) {
        const priorStatus = statusComputeds[priorKey]?.value
        if (priorStatus !== undefined) {
          void statusChangeHandler(priorStatus, priorForm)
        }
      }
    }
  }

  // Browser back/forward → restore current from URL. The handler is a
  // no-op when the URL no longer names a known key (consumer linked
  // outside the wizard, or popped past the original entry).
  wizardHistory.subscribe((key) => {
    if (key === undefined) return
    if (!seenKeys.has(key)) return
    setCurrent(key, 'silent')
  })

  // --- Phase 4: lifecycle state ------------------------------------------

  const submitting = ref(false)
  const submissionAttempts = ref(0)
  const complete = ref(false)
  // Watchers that flip `complete` back to `false` on any post-success
  // edit to a walked-path form. Torn down when `complete` itself flips
  // (or when `wizard.reset()` runs), so the wizard only pays the watch
  // cost while it has a successful submission to invalidate.
  let completeStopFns: Array<() => void> = []

  function teardownCompleteWatchers(): void {
    for (const stop of completeStopFns) stop()
    completeStopFns = []
  }

  function markComplete(walkedPath: readonly AnyForm[]): void {
    teardownCompleteWatchers()
    // Snapshot each walked form's `meta.updatedAt` at success time;
    // any post-success write bumps the timestamp, signalling an edit.
    // Watching the boolean `meta.dirty` would be inert here because
    // dirty is sticky-true after the first write — there's no
    // transition to observe once the user has touched the form.
    const snapshots = new Map<string, string | null>()
    for (const form of walkedPath) {
      const source = form as unknown as SubmissionSourceForm
      snapshots.set(form.key, source.meta?.updatedAt ?? null)
    }
    complete.value = true
    for (const form of walkedPath) {
      const source = form as unknown as SubmissionSourceForm
      const stopFn = watch(
        () => source.meta?.updatedAt ?? null,
        (nextValue) => {
          if (nextValue !== snapshots.get(form.key) && complete.value === true) {
            complete.value = false
            teardownCompleteWatchers()
          }
        }
      )
      completeStopFns.push(stopFn)
    }
  }

  const canAdvance = computed<boolean>(() => {
    const activeForm = byKey.get(current.value)
    if (activeForm === undefined) return false
    const nextDecl = activeForm.next
    if (nextDecl === undefined) return false
    if (nextDecl.forms.length === 0) return false
    return true
  })

  const canGoBack = computed<boolean>(() => formKeys.indexOf(current.value) > 0)

  // --- Navigation --------------------------------------------------------

  async function next(navOptions?: WizardNavOptions): Promise<void> {
    if (submitting.value) {
      console.warn(
        `[attaform] useWizard.next(): blocked while a submit is in flight. Wait for handleSubmit to settle, or call back/goTo from onError.`
      )
      return
    }
    const activeKey = current.value
    const activeForm = byKey.get(activeKey) as unknown as SubmissionSourceForm | undefined
    if (activeForm === undefined) return
    const nextDecl = (activeForm as unknown as AnyForm).next
    if (nextDecl === undefined) {
      console.warn(
        `[attaform] useWizard.next(): already on the last step ("${activeKey}"). Disable the button at the end of the wizard.`
      )
      return
    }
    // Activate first so async `defaultValues` factories settle before we
    // ask the form to validate. Activation failure dev-warns and does
    // not advance — the consumer can retry once the factory recovers.
    try {
      if (typeof activeForm.activate === 'function') {
        await activeForm.activate()
      }
    } catch (err) {
      console.warn(
        `[attaform] useWizard.next(): activation of "${activeKey}" failed: ${
          (err as Error)?.message ?? String(err)
        }`
      )
      return
    }
    const result = await activeForm.process()
    if (result.success !== true) {
      // Invalid form blocks navigation. Fire the form's own
      // `onInvalidSubmit` policy (focus / scroll / both / none) so the
      // user gets the configured nudge without going through handleSubmit.
      activeForm.applyInvalidSubmitPolicy()
      return
    }
    const picked = nextDecl.pick(result.data)
    if (picked === undefined) {
      console.warn(
        `[attaform] useWizard.next(): \`pick(parsed)\` returned undefined at "${activeKey}" — dynamic terminal reached.`
      )
      return
    }
    setCurrent(picked.key, navOptions?.replace === true ? 'replace' : 'push')
  }

  function back(navOptions?: WizardNavOptions): void {
    if (submitting.value) {
      console.warn(`[attaform] useWizard.back(): blocked while a submit is in flight.`)
      return
    }
    const idx = indexOf(current.value)
    if (idx === 0) {
      console.warn(
        `[attaform] useWizard.back(): already on the first step ("${current.value}"). Disable the button at the start of the wizard.`
      )
      return
    }
    setCurrent(formKeys[idx - 1] as string, navOptions?.replace === true ? 'replace' : 'push')
  }

  function goTo(key: string, navOptions?: WizardNavOptions): void {
    if (submitting.value) {
      console.warn(`[attaform] useWizard.goTo(): blocked while a submit is in flight.`)
      return
    }
    if (!seenKeys.has(key)) {
      console.warn(
        `[attaform] useWizard.goTo("${key}"): unknown step key. Known keys: ${formKeys.map((k) => `"${k}"`).join(', ')}. Ignoring.`
      )
      return
    }
    setCurrent(key, navOptions?.replace === true ? 'replace' : 'push')
  }

  // --- handleSubmit ------------------------------------------------------

  type Processed = ValidationResponse<unknown>

  async function processForm(form: AnyForm, cache: Map<string, Processed>): Promise<Processed> {
    const cached = cache.get(form.key)
    if (cached !== undefined) return cached
    const full = form as unknown as SubmissionSourceForm
    let activationFailure: string | undefined
    try {
      if (typeof full.activate === 'function') await full.activate()
    } catch (err) {
      // Caller-visible throw from `activate()` (rare — the form runtime
      // captures most factory failures internally, but this covers
      // direct throws from synchronous activation paths).
      activationFailure = (err as Error)?.message ?? String(err)
    }
    // Mirror the form runtime's internal capture: a function-form
    // `defaultValues` factory throw lands on `form.hydrateError` rather
    // than propagating out of `activate()`. Promote it to the wizard's
    // aggregate channel with the dedicated `atta:activation-failed`
    // code so consumers can branch on origin (vs. ordinary validation
    // errors that ride field paths).
    if (activationFailure === undefined && full.hydrateError != null) {
      activationFailure = full.hydrateError.message
    }
    if (activationFailure !== undefined) {
      const synthetic: Processed = {
        success: false,
        data: undefined,
        errors: [
          {
            formKey: form.key,
            path: [],
            message: `Form '${form.key}' failed to activate: ${activationFailure}`,
            code: AttaformErrorCode.ActivationFailed,
          },
        ],
        formKey: form.key,
      }
      cache.set(form.key, synthetic)
      return synthetic
    }
    const result = await full.process()
    cache.set(form.key, result)
    return result
  }

  type WalkResult = { readonly path: readonly AnyForm[]; readonly allValid: boolean }

  async function walkSubgraph(form: AnyForm, cache: Map<string, Processed>): Promise<WalkResult> {
    const result = await processForm(form, cache)
    const isValid = result.success === true
    const nextDecl = form.next
    if (nextDecl === undefined) {
      return { path: [form], allValid: isValid }
    }
    if (isValid) {
      const picked = nextDecl.pick(result.data)
      if (picked === undefined) {
        return { path: [form], allValid: true }
      }
      const sub = await walkSubgraph(picked, cache)
      return { path: [form, ...sub.path], allValid: sub.allValid }
    }
    // Invalid current + branching: walk ALL declared `forms` subgraphs in
    // parallel so latency is bounded by the slowest branch, not the sum
    // of all branches. The aggregate cache dedupes any form that
    // appears in more than one subgraph.
    if (nextDecl.forms.length > 0) {
      await Promise.all(nextDecl.forms.map((branch) => walkSubgraph(branch, cache)))
    }
    return { path: [form], allValid: false }
  }

  function handleSubmit(
    onSubmit: WizardOnSubmit,
    onError?: WizardOnError
  ): (event?: Event) => Promise<void> {
    return async function submitHandler(event?: Event): Promise<void> {
      if (event !== undefined && typeof (event as Event).preventDefault === 'function') {
        event.preventDefault()
      }
      if (submitting.value) {
        console.warn(
          `[attaform] wizard.handleSubmit: re-entrant submit while a prior call is still in flight; resolving no-op.`
        )
        return
      }
      submitting.value = true
      try {
        const cache = new Map<string, Processed>()
        const walk = await walkSubgraph(entryForm, cache)
        // Aggregate errors and parsed values from the cache in BFS order
        // (matching `forms`) so the error list and value record are
        // stable regardless of branch interleaving.
        const errors: AggregateError[] = []
        const values: Record<string, WizardValue> = {}
        for (const form of forms) {
          const processed = cache.get(form.key)
          if (processed === undefined) continue
          if (processed.success === true) {
            values[form.key] = processed.data as WizardValue
            continue
          }
          if (processed.data !== undefined) values[form.key] = processed.data as WizardValue
          for (const err of processed.errors) {
            const entry: { -readonly [P in keyof AggregateError]: AggregateError[P] } = {
              formKey: err.formKey,
              path: err.path,
              message: err.message,
            }
            if (err.code !== undefined) entry.code = err.code
            errors.push(entry)
          }
        }
        // Bump each walked form's `meta.submissionAttempts` so
        // `field.showErrors` reveals previously-hidden errors. The
        // wizard mutates the store directly (it already reads
        // `defaultsResolved` and `meta` off the registry); per-form
        // `meta.submitting` is NOT flipped because the wizard never
        // routes through each form's own `handleSubmit`.
        for (const key of cache.keys()) {
          const store = registry.forms.get(key)
          if (store !== undefined) {
            store.submissionAttempts.value += 1
          }
        }
        submissionAttempts.value += 1
        if (errors.length === 0) {
          const ctx: WizardSubmitContext = {
            values,
            get: ((form: AnyForm) => values[form.key]) as WizardSubmitContext['get'],
            path: walk.path,
          }
          await onSubmit(ctx)
          markComplete(walk.path)
        } else {
          if (onError !== undefined) {
            await onError(errors)
          }
          if (options.navigateToFirstError !== false) {
            const firstFailedKey = errors[0]?.formKey
            if (firstFailedKey !== undefined && seenKeys.has(firstFailedKey)) {
              // Use the internal `setCurrent` so the navigation is not
              // gated on `submitting` — that gate is for user-initiated
              // navigation, not the wizard's own failure routing.
              setCurrent(firstFailedKey, 'push')
              const failedForm = byKey.get(firstFailedKey) as unknown as
                | SubmissionSourceForm
                | undefined
              if (
                failedForm !== undefined &&
                typeof failedForm.applyInvalidSubmitPolicy === 'function'
              ) {
                failedForm.applyInvalidSubmitPolicy()
              }
            }
          }
        }
      } finally {
        submitting.value = false
      }
    }
  }

  function reset(): void {
    teardownCompleteWatchers()
    complete.value = false
    submissionAttempts.value = 0
    visited.value = [current.value]
    for (const form of forms) {
      const full = form as unknown as SubmissionSourceForm
      if (typeof full.reset === 'function') full.reset()
    }
  }

  // Construction-time warnings frozen at construction; runtime
  // anomalies (out-of-forms pick returns) throw from `normalize-next`
  // and are NOT collected here. Same array identity on every call so
  // consumers can memoize / referentially compare.
  const diagnose = (): readonly WizardWarning[] => graph.warnings

  const flow: WizardFlow = Object.freeze({
    entryForm,
    tree: graph.tree,
    allForms: forms,
    get visited(): readonly string[] {
      return visited.value
    },
    diagnose,
  } as WizardFlow)

  const wizardKey = options.key
  const handle: UseWizardReturnType = {
    key: wizardKey,
    entryForm,
    allForms: forms,
    count: forms.length,
    statuses,
    allValues,
    next,
    back,
    goTo,
    handleSubmit,
    reset,
    flow,
    get current(): string | undefined {
      return current.value
    },
    get activeForm(): AnyForm | undefined {
      return byKey.get(current.value)
    },
    get activeIndex(): number {
      return formKeys.indexOf(current.value)
    },
    get allErrors(): readonly AggregateError[] {
      return allErrors.value
    },
    get progress(): number {
      return progress.value
    },
    get canAdvance(): boolean {
      return canAdvance.value
    },
    get canGoBack(): boolean {
      return canGoBack.value
    },
    get complete(): boolean {
      return complete.value
    },
    get submitting(): boolean {
      return submitting.value
    },
    get submissionAttempts(): number {
      return submissionAttempts.value
    },
  }

  // Register the handle under `options.key` so descendants can reach it
  // via `injectWizard(key)`. First-wins-silently: a duplicate key
  // (modal + main rendering the same wizard, HMR fast-refresh, etc.)
  // keeps the live handle and dev-warns on the second registration so
  // accidental collisions surface but the runtime stays predictable.
  if (wizardKey !== undefined) {
    const existing = registry.wizards.get(wizardKey)
    if (existing === undefined) {
      registry.wizards.set(wizardKey, handle)
    } else if (__DEV__) {
      console.warn(
        `[attaform] useWizard({ key: "${wizardKey}" }): a wizard with this key is already registered. Keeping the existing handle. Pass a unique key to each useWizard call, or share the original handle via injectWizard("${wizardKey}").`
      )
    }
    if (getCurrentScope() !== undefined) {
      const releaseWizard = registry.trackWizardConsumer(wizardKey)
      onScopeDispose(releaseWizard)
    }
  }

  // Ambient provide so descendants can call `injectWizard()` (no key)
  // and resolve the nearest wizard above them. Mirrors `useForm`'s
  // `kFormContext` provide. Fires for both keyed and anonymous wizards
  // — the ambient slot is independent of the registry path.
  if (getCurrentInstance() !== null) {
    provide(kAttaformAncestorWizard, handle)
  }

  return handle
}

export { WizardCycleError }
