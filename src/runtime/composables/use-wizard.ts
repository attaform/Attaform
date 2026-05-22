import { computed, getCurrentScope, onScopeDispose, ref, watch, type ComputedRef } from 'vue'
import { buildWizardGraph, WizardCycleError } from '../core/wizard-graph'
import { useRegistry } from '../core/registry'
import { resolveTrichotomy } from '../core/resolve-default-values'
import { createWizardHistory, NOOP_WIZARD_HISTORY } from '../core/wizard-history'
import { buildWizardStatusesProxy } from '../core/wizard-statuses-proxy'
import type {
  AggregateError,
  AnyForm,
  FormStatus,
  WizardHistoryConfig,
  WizardNavOptions,
  WizardOptions,
  UseWizardReturnType,
} from '../types/types-wizard'

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

/**
 * Multistep-form orchestrator. Walks the static graph declared by
 * `useForm({ next })` declarations starting from `entry`, composing
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
 *  - Single-step wizards (entry has no `next`) are valid; a one-time
 *    dev-warn notes the navigation surface is degenerate.
 *
 * Each reachable form gets a ref-count via `registry.trackConsumer(key)`.
 * This pins the FormStore for the wizard's lifetime — so a step's state
 * survives even when its component is unmounted between visits
 * (v-if pattern). The ref is released on `onScopeDispose`.
 */
export function useWizard(entry: AnyForm, options: WizardOptions = {}): UseWizardReturnType {
  const graph = buildWizardGraph(entry)
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
  // `entry.key` fallback. Unknown keys at any level fall through so a
  // stale link can't crash construction.
  const fromGetter = options.getServerActiveStep?.()
  const fromUrl = wizardHistory.read()
  let initialKey: string
  if (fromGetter !== undefined && seenKeys.has(fromGetter)) {
    initialKey = fromGetter
  } else if (fromUrl !== undefined && seenKeys.has(fromUrl)) {
    initialKey = fromUrl
  } else {
    initialKey = entry.key
  }
  const current = ref<string>(initialKey)

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

  function next(navOptions?: WizardNavOptions): void {
    const idx = indexOf(current.value)
    if (idx === formKeys.length - 1) {
      console.warn(
        `[attaform] useWizard.next(): already on the last step ("${current.value}"). Disable the button at the end of the wizard.`
      )
      return
    }
    setCurrent(formKeys[idx + 1] as string, navOptions?.replace === true ? 'replace' : 'push')
  }

  function back(navOptions?: WizardNavOptions): void {
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
    if (!seenKeys.has(key)) {
      console.warn(
        `[attaform] useWizard.goTo("${key}"): unknown step key. Known keys: ${formKeys.map((k) => `"${k}"`).join(', ')}. Ignoring.`
      )
      return
    }
    setCurrent(key, navOptions?.replace === true ? 'replace' : 'push')
  }

  return {
    entry,
    allForms: forms,
    count: forms.length,
    statuses,
    allValues,
    next,
    back,
    goTo,
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
  }
}

export { WizardCycleError }
