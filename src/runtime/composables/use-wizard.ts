import {
  computed,
  getCurrentInstance,
  getCurrentScope,
  inject,
  nextTick,
  onScopeDispose,
  provide,
  ref,
  useId,
  watch,
  type ComputedRef,
} from 'vue'
import { __DEV__ } from '../core/dev'
import { ANONYMOUS_WIZARD_KEY_PREFIX } from '../core/defaults'
import { AttaformErrorCode } from '../core/error-codes'
import {
  kAttaformAncestorWizard,
  kAttaformWizardActiveStepResolver,
  useRegistry,
} from '../core/registry'
import { resolveTrichotomy } from '../core/resolve-default-values'
import { isDeferMarker } from '../core/wizard-defer'
import { createWizardHistory, NOOP_WIZARD_HISTORY } from '../core/wizard-history'
import { buildNoopWizardSchema } from '../core/wizard-noop-schema'
import { buildWizardStatusesProxy } from '../core/wizard-statuses-proxy'
import { useAbstractForm } from './use-abstract-form'
import type {
  AggregateError,
  AnyForm,
  CompiledStep,
  DeferMarker,
  FormStatus,
  StepSlot,
  UseWizardReturnType,
  WizardCtx,
  WizardCtxForm,
  WizardOnError,
  WizardOnSubmit,
  WizardOptions,
  WizardPersistFn,
  WizardRestoreFn,
  WizardRestoreState,
  WizardSubmitContext,
} from '../types/types-wizard'
import type { FormKey, OnInvalidSubmitPolicy, ValidationResponse } from '../types/types-api'

/** Default URL search param when the consumer doesn't supply a custom
 *  `restore` / `persist` pair. */
const DEFAULT_STEP_PARAM = 'step'

/** Fallback status surfaced for forms whose async defaults haven't yet
 *  settled (and no `defaultStatuses` seed covers the key). */
const PENDING_STATUS: FormStatus = {
  valid: false,
  dirty: false,
  submitted: false,
  errorCount: 0,
}

/** Status surfaced for noop forms (string-slot affordance steps). Noops
 *  carry no schema, no fields, and no error surface — they are always
 *  trivially valid, so the wizard's progress and complete computeds can
 *  treat string slots as "done by being there." */
const NOOP_VALID_STATUS: FormStatus = {
  valid: true,
  dirty: false,
  submitted: false,
  errorCount: 0,
}

/** Subset of the form's surface the wizard reads for status + values. */
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
    readonly updatedAt: string | null
  }
  readonly values: unknown
}

/** Subset of the form's surface the wizard's submission walk exercises. */
type SubmissionSourceForm = StatusSourceForm & {
  activate(): Promise<void>
  process(): Promise<ValidationResponse<unknown>>
  applyInvalidSubmitPolicy(policy?: OnInvalidSubmitPolicy): void
  reset(): void
  readonly hydrateError: { readonly message: string } | null | undefined
}

/**
 * Multistep-form orchestrator built around an ordered list of step slots.
 * Each slot resolves to a participating form: an existing `useForm`
 * reference, a bare string key (desugared to a noop form so affordance
 * steps participate uniformly), an eagerly-evaluated function slot for
 * runtime branching, or a `defer()`-wrapped function slot whose
 * resolution sticks across re-evaluations.
 *
 * The wizard's surface is read-only from the consumer's side:
 * navigation (`next` / `back` / `goTo`) walks positional indices,
 * `handleSubmit` validates the active form on intermediate steps and
 * the whole wizard on the final step, and URL synchronization rides on
 * `restore` / `persist` callbacks that default to `?step=<key>`.
 */
export function useWizard(options: WizardOptions): UseWizardReturnType {
  const rawSteps = options.steps
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new Error('[attaform] useWizard({ steps }): expected a non-empty array of step slots.')
  }

  const registry = useRegistry()

  // --- Noop-form synthesis for top-level string slots -------------------
  //
  // String slots desugar to a wizard-owned `useAbstractForm` call backed
  // by `buildNoopWizardSchema`. Synthesis runs at setup time so the
  // forms are registered in the registry (status + ref-counting +
  // consumer eviction all flow through the same paths as real forms).
  // Function slots may return any of these same keys; runtime lookups
  // use the cache built here.
  const noopForms = new Map<string, AnyForm>()
  for (const slot of rawSteps) {
    if (typeof slot !== 'string') continue
    if (noopForms.has(slot)) continue
    const noop = useAbstractForm({
      schema: buildNoopWizardSchema(slot),
      key: slot,
    }) as unknown as AnyForm
    noopForms.set(slot, noop)
  }

  // --- Static slot inventory -------------------------------------------
  //
  // Collect every form referenced by a top-level slot. This is the
  // initial consumer-tracking set; function slots add to it lazily as
  // they resolve.
  const trackedKeys = new Set<FormKey>()
  function trackOnce(form: AnyForm): void {
    if (trackedKeys.has(form.key)) return
    trackedKeys.add(form.key)
    if (getCurrentScope() !== undefined) {
      const release = registry.trackConsumer(form.key)
      onScopeDispose(release)
    }
  }
  for (const slot of rawSteps) {
    if (typeof slot === 'string') {
      const noop = noopForms.get(slot)
      if (noop !== undefined) trackOnce(noop)
    } else if (isAnyForm(slot)) {
      trackOnce(slot)
    }
  }

  // --- Reactive plumbing for the slot compiler --------------------------
  //
  // `stickyDefers` caches the resolved form for each deferred slot at
  // its index in `rawSteps`. Once a `defer((ctx) => …)` slot resolves
  // (or explicitly drops via `undefined`), subsequent reactive reads
  // reuse the cached result without re-invoking the resolver. The
  // wizard treats `defer()` slots as eager-but-sticky in this build:
  // they resolve on first compile-pass evaluation and never re-resolve.
  const stickyDefers = new Map<number, AnyForm | null>()

  // `activeKey` is the canonical source of truth for the active step.
  // Initialized below from `restore` (or the first compiled slot's key).
  // Declared early so the slot compiler's `ctx.currentKey` reads it.
  const activeKey = ref<string>('')

  // Static accumulator of forms reachable through top-level slots. The
  // slot context's `forms` projection reads from this Map so function
  // slots can branch on a stable lookup surface (`ctx.forms.account`)
  // without forcing the slot context to depend on the compiled step
  // list — that dependency would close a reactive cycle through the
  // slot compiler.
  const formsAccumulator = new Map<FormKey, AnyForm>()
  for (const slot of rawSteps) {
    if (typeof slot === 'string') {
      const noop = noopForms.get(slot)
      if (noop !== undefined) formsAccumulator.set(noop.key, noop)
    } else if (isAnyForm(slot)) {
      formsAccumulator.set(slot.key, slot)
    }
  }

  // Slot resolution context shape — projected to consumers as the
  // single argument of function slots. Values are loose-typed because
  // the wizard does not generically thread each step's schema through
  // `ctx.forms`; consumers reach back to their original form refs for
  // typed access.
  const slotForms = new Proxy({} as Record<FormKey, WizardCtxForm>, {
    get(_, key: string | symbol): WizardCtxForm | undefined {
      if (typeof key !== 'string') return undefined
      return formsAccumulator.get(key) as WizardCtxForm | undefined
    },
    has(_, key: string | symbol): boolean {
      if (typeof key !== 'string') return false
      return formsAccumulator.has(key)
    },
    ownKeys(): ArrayLike<string | symbol> {
      return [...formsAccumulator.keys()]
    },
    getOwnPropertyDescriptor(_, key: string | symbol): PropertyDescriptor | undefined {
      if (typeof key !== 'string') return undefined
      const form = formsAccumulator.get(key)
      if (form === undefined) return undefined
      return { configurable: true, enumerable: true, writable: false, value: form }
    },
  })
  const slotCtx = computed<WizardCtx>(() => ({
    forms: slotForms,
    currentKey: activeKey.value === '' ? undefined : activeKey.value,
  }))

  /**
   * Resolve a single raw slot to a participating form, or `undefined`
   * to drop that slot from the compiled list. Hoisted to a free
   * function so the steps computed stays readable.
   */
  function resolveSlot(slot: StepSlot, index: number, ctx: WizardCtx): AnyForm | undefined {
    if (typeof slot === 'string') {
      const noop = noopForms.get(slot)
      if (noop === undefined && __DEV__) {
        console.warn(
          `[attaform] useWizard: function slot returned key "${slot}" which is not declared as a top-level string slot or registered form. Skipping.`
        )
      }
      return noop
    }
    if (isDeferMarker(slot)) {
      const cached = stickyDefers.get(index)
      if (cached !== undefined) return cached === null ? undefined : cached
      const result = (slot as DeferMarker).resolve(ctx)
      const form = resolveSlotResult(result)
      stickyDefers.set(index, form ?? null)
      return form
    }
    if (typeof slot === 'function') {
      const result = (slot as (ctx: WizardCtx) => AnyForm | string | undefined)(ctx)
      return resolveSlotResult(result)
    }
    if (isAnyForm(slot)) return slot
    return undefined
  }

  function resolveSlotResult(result: AnyForm | string | undefined): AnyForm | undefined {
    if (result === undefined) return undefined
    if (typeof result === 'string') {
      const noop = noopForms.get(result)
      if (noop === undefined && __DEV__) {
        console.warn(
          `[attaform] useWizard: function slot returned key "${result}" which is not declared as a top-level string slot or registered form. Skipping.`
        )
      }
      return noop
    }
    return result
  }

  // The compiled step list. Function slots re-evaluate on every read
  // of their reactive deps; sticky defer slots resolve once and stick;
  // string slots cache their noop forms.
  const compiledSteps = computed<readonly CompiledStep[]>(() => {
    const ctx = slotCtx.value
    const out: CompiledStep[] = []
    const seen = new Set<FormKey>()
    for (let i = 0; i < rawSteps.length; i++) {
      const slot = rawSteps[i] as StepSlot
      const form = resolveSlot(slot, i, ctx)
      if (form === undefined) continue
      if (seen.has(form.key)) {
        if (__DEV__) {
          console.warn(
            `[attaform] useWizard: step "${form.key}" appears in more than one slot. The wizard treats the first occurrence as canonical and drops later duplicates.`
          )
        }
        continue
      }
      seen.add(form.key)
      trackOnce(form)
      out.push({ key: form.key, form })
    }
    return out
  })

  // --- Active-step state ------------------------------------------------

  const activeIndex = computed<number>(() => {
    const key = activeKey.value
    if (key === '') return -1
    const list = compiledSteps.value
    for (let i = 0; i < list.length; i++) {
      if ((list[i] as CompiledStep).key === key) return i
    }
    return -1
  })

  const currentStep = computed<FormKey>(() => {
    const key = activeKey.value
    if (key !== '') return key
    const first = compiledSteps.value[0]
    return first === undefined ? '' : first.key
  })

  const activeForm = computed<AnyForm>(() => {
    const list = compiledSteps.value
    const idx = activeIndex.value
    if (idx >= 0 && idx < list.length) {
      return (list[idx] as CompiledStep).form
    }
    const first = list[0]
    if (first === undefined) {
      throw new Error('[attaform] useWizard: compiled step list is empty.')
    }
    return first.form
  })

  const isFinalStep = computed<boolean>(() => {
    const list = compiledSteps.value
    const idx = activeIndex.value
    return list.length > 0 && idx === list.length - 1
  })

  const count = computed<number>(() => compiledSteps.value.length)

  // --- Forms record + namespaced aggregates -----------------------------

  const formsRecord = computed<Readonly<Record<FormKey, AnyForm>>>(() => {
    const out: Record<FormKey, AnyForm> = {}
    for (const step of compiledSteps.value) out[step.key] = step.form
    return out
  })

  const allValues = computed<Readonly<Record<FormKey, unknown>>>(() => {
    const out: Record<FormKey, unknown> = {}
    for (const step of compiledSteps.value) {
      const source = step.form as unknown as StatusSourceForm
      out[step.key] = source.values
    }
    return out
  })

  const allErrors = computed<Readonly<Record<FormKey, readonly AggregateError[]>>>(() => {
    const out: Record<FormKey, readonly AggregateError[]> = {}
    for (const step of compiledSteps.value) {
      const source = step.form as unknown as StatusSourceForm
      const list: AggregateError[] = []
      const store = registry.forms.get(step.key)
      const resolved = store?.defaultsResolved.value === true
      if (resolved) {
        const errors = source.meta?.errors ?? []
        for (const err of errors) {
          const entry: { -readonly [P in keyof AggregateError]: AggregateError[P] } = {
            formKey: step.key,
            path: err.path,
            message: err.message,
          }
          if (err.code !== undefined) entry.code = err.code
          list.push(entry)
        }
      }
      out[step.key] = list
    }
    return out
  })

  // --- Statuses proxy + seed --------------------------------------------

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

  // Per-step status computeds, lazily extended as new step keys appear
  // through function-slot resolution. A keyed cache keeps each form's
  // computed identity stable across re-evaluations of `compiledSteps`.
  const statusCache = new Map<FormKey, ComputedRef<FormStatus>>()

  function statusFor(form: AnyForm): ComputedRef<FormStatus> {
    const cached = statusCache.get(form.key)
    if (cached !== undefined) return cached
    const source = form as unknown as StatusSourceForm
    const computedStatus = computed<FormStatus>(() => {
      const store = registry.forms.get(form.key)
      const resolved = store?.defaultsResolved.value === true
      if (resolved) {
        const meta = source.meta
        if (meta !== undefined && meta !== null) {
          return {
            valid: meta.valid,
            dirty: meta.dirty,
            submitted: meta.submitted,
            errorCount: meta.errorCount,
          }
        }
      }
      // Noop forms surface as always-valid even before their (trivial)
      // schema settle has registered — noop schemas resolve synchronously
      // so this branch is mostly defensive, but it keeps the
      // status surface stable for string-slot keys at t=0.
      if (noopForms.has(form.key)) return NOOP_VALID_STATUS
      const seedMap = seedRef.value
      if (seedMap !== undefined && Object.hasOwn(seedMap, form.key)) {
        return seedMap[form.key] as FormStatus
      }
      return PENDING_STATUS
    })
    statusCache.set(form.key, computedStatus)
    return computedStatus
  }

  // Wrap the cache in a Proxy so `wizard.statuses` reads each key's
  // computed lazily, including keys that only appeared via function-slot
  // resolution. The underlying statuses-proxy expects a static record;
  // we feed it a live one whose `get` delegates to `statusFor`.
  const statusesRecord = new Proxy({} as Record<FormKey, ComputedRef<FormStatus>>, {
    get(_, key: string | symbol): ComputedRef<FormStatus> | undefined {
      if (typeof key !== 'string') return undefined
      const form = formsRecord.value[key]
      if (form === undefined) {
        // Honor seeded keys for forms not yet visible in the compiled
        // list (e.g. ghost forms behind a function-slot that hasn't
        // resolved to them yet) so consumers can read a stable status
        // surface for keys they know about.
        const cached = statusCache.get(key)
        if (cached !== undefined) return cached
        return undefined
      }
      return statusFor(form)
    },
    ownKeys(): ArrayLike<string | symbol> {
      return Object.keys(formsRecord.value)
    },
    has(_, key: string | symbol): boolean {
      if (typeof key !== 'string') return false
      return formsRecord.value[key] !== undefined
    },
    getOwnPropertyDescriptor(_, key: string | symbol): PropertyDescriptor | undefined {
      if (typeof key !== 'string') return undefined
      const form = formsRecord.value[key]
      if (form === undefined) return undefined
      return {
        configurable: true,
        enumerable: true,
        writable: false,
        value: statusFor(form),
      }
    },
  })

  const statuses = buildWizardStatusesProxy<Record<string, FormStatus>>(statusesRecord)

  // Dev-warn on seed keys that match no compiled step (initial pass).
  if (__DEV__ && seedRef.value !== undefined) {
    const seedMap = seedRef.value
    const known = new Set(compiledSteps.value.map((s) => s.key))
    const unknown: string[] = []
    for (const key of Object.keys(seedMap)) {
      if (!known.has(key)) unknown.push(key)
    }
    if (unknown.length > 0) {
      console.warn(
        `[attaform] useWizard.defaultStatuses: seed contains unknown key(s) ${unknown
          .map((k) => `"${k}"`)
          .join(', ')}. Known step keys: ${[...known].map((k) => `"${k}"`).join(', ')}.`
      )
    }
  }

  // --- Progress + complete (forward-looking) ---------------------------

  const progressOverride = options.progress
  const progress = computed<number>(() => {
    if (progressOverride !== undefined) {
      return progressOverride(compiledSteps.value)
    }
    const list = compiledSteps.value
    if (list.length === 0) return 0
    let valid = 0
    for (const step of list) {
      const status = statusFor(step.form).value
      if (status.valid === true) valid += 1
    }
    return valid / list.length
  })

  const complete = computed<boolean>(() => {
    if (!isFinalStep.value) return false
    for (const step of compiledSteps.value) {
      if (statusFor(step.form).value.valid !== true) return false
    }
    return true
  })

  // --- Navigation positional helpers ------------------------------------

  const canAdvance = computed<boolean>(() => activeIndex.value < count.value - 1)
  const canGoBack = computed<boolean>(() => activeIndex.value > 0)

  const visited = ref<FormKey[]>([])

  // --- URL / restore wiring --------------------------------------------
  //
  // Default restore reads the first non-undefined value among:
  //   1. injected Nuxt-side resolver (`?step=<key>` via useRoute() in
  //      the Nuxt module's runtime plugin), then
  //   2. window.location's search param mirrored through a reactive
  //      ref that updates on popstate.
  //
  // Default persist writes back to the URL via `wizard-history.ts`.
  // The historyHandle is created only when the consumer has not
  // disabled `restore`/`persist`, so embed contexts that opt out (or
  // pass custom handlers) never touch the DOM History API.
  const wantsDefaultUrlSync = options.restore !== false || options.persist !== false
  const historyHandle = wantsDefaultUrlSync
    ? createWizardHistory(DEFAULT_STEP_PARAM)
    : NOOP_WIZARD_HISTORY
  const injectedResolver = inject(kAttaformWizardActiveStepResolver, null)

  // Reactive URL mirror — `historyHandle.subscribe` fires the callback
  // on popstate. Initial value resolves to whatever the URL holds at
  // setup time (server's URL during SSR via the resolver, or the
  // window URL on the client).
  const urlMirror = ref<string | undefined>(undefined)
  const initialUrlValue =
    injectedResolver !== null ? injectedResolver(DEFAULT_STEP_PARAM) : historyHandle.read()
  urlMirror.value = initialUrlValue
  historyHandle.subscribe((value) => {
    urlMirror.value = value
  })

  const restoreCallback: WizardRestoreFn | undefined =
    options.restore === false
      ? undefined
      : options.restore !== undefined
        ? options.restore
        : (): WizardRestoreState | undefined => {
            const value = urlMirror.value
            return value === undefined ? undefined : { step: value }
          }

  const persistCallback: WizardPersistFn | undefined =
    options.persist === false
      ? undefined
      : options.persist !== undefined
        ? options.persist
        : (state: WizardRestoreState): void => {
            if (state.step === undefined) return
            historyHandle.replace(state.step)
          }

  // --- Initial active key resolution ------------------------------------

  function isCompiledKey(key: string): boolean {
    const list = compiledSteps.value
    for (const step of list) if (step.key === key) return true
    return false
  }

  function firstKey(): FormKey {
    const first = compiledSteps.value[0]
    if (first === undefined) {
      throw new Error('[attaform] useWizard: compiled step list is empty.')
    }
    return first.key
  }

  let initialKey: FormKey
  const restoredAtSetup = restoreCallback?.()
  const restoredStep = restoredAtSetup?.step
  if (restoredStep !== undefined && isCompiledKey(restoredStep)) {
    initialKey = restoredStep
  } else {
    if (
      __DEV__ &&
      restoredStep !== undefined &&
      restoredStep !== '' &&
      !isCompiledKey(restoredStep)
    ) {
      console.warn(
        `[attaform] useWizard: restore() yielded step "${restoredStep}" which is not in the compiled step list. Falling back to the first step.`
      )
    }
    initialKey = firstKey()
  }
  activeKey.value = initialKey
  visited.value = [initialKey]

  // --- SSR prefetch coordination ---------------------------------------
  //
  // On the server, mark the initial step's form for prefetch (so its
  // async `defaultValues` resolves inside `onServerPrefetch`) and
  // explicitly skip every other compiled step so a stray transform mark
  // can't fire a non-current step's factory.
  if (registry.ssr) {
    for (const step of compiledSteps.value) {
      if (step.key === initialKey) {
        registry.enqueuePrefetch(step.key)
      } else {
        registry.skipPrefetch(step.key)
      }
    }
  }

  // Activate every compiled step's form on the client. Idempotent —
  // `activate()` returns a resolved promise when the form has no
  // async work, and the registry's per-store hydration latch holds
  // the factory single-shot across repeat calls. SSR keeps the
  // prefetch coordination above (only the initial step's factory
  // resolves inside `onServerPrefetch`); eager-activate-all is a
  // client-side contract.
  if (!registry.ssr) {
    for (const step of compiledSteps.value) {
      const source = step.form as unknown as SubmissionSourceForm
      if (typeof source.activate === 'function') void source.activate()
    }
  }

  // --- Reactive restore / persist watchers -----------------------------
  //
  // Loop break: the restore side watches what the `restore` lambda
  // returns (the lambda's tracked reads decide the dep set), and only
  // applies when that value moves AND differs from the active step.
  // The persist side diffs against `lastPersisted`. We deliberately
  // do not read `activeKey` inside the restore watch's getter — that
  // would re-fire the restore on every internal navigation and revert
  // it before the persist write reaches `urlMirror` on its own pass.
  let lastPersisted: string | undefined = initialUrlValue
  if (restoreCallback !== undefined) {
    watch(
      () => restoreCallback()?.step,
      (step) => {
        if (step === undefined) return
        if (!isCompiledKey(step)) {
          if (__DEV__) {
            console.warn(
              `[attaform] useWizard: restore() yielded step "${step}" which is not in the compiled step list. Ignoring.`
            )
          }
          return
        }
        if (step === activeKey.value) return
        activeKey.value = step
        if (!visited.value.includes(step)) visited.value.push(step)
      }
    )
  }
  if (persistCallback !== undefined) {
    watch(
      () => activeKey.value,
      (next) => {
        if (next === lastPersisted) return
        lastPersisted = next
        persistCallback({ step: next })
        // Keep the URL mirror in sync so the default restore lambda
        // sees the persisted value on its next read. The restore watch
        // diffs the new mirror value against `activeKey` and bails out
        // when they agree, closing the loop in one round.
        urlMirror.value = next
      }
    )
    // Replace the URL once at construction so a fresh load reflects the
    // active step (idempotent when the URL already named the correct
    // key — the diff in the watcher handles steady-state).
    if (initialKey !== initialUrlValue && initialUrlValue === undefined) {
      lastPersisted = initialKey
      persistCallback({ step: initialKey })
      urlMirror.value = initialKey
    }
  }

  // --- Lifecycle state --------------------------------------------------

  const submitting = ref(false)
  const submissionAttempts = ref(0)
  // Monotonic latch: flips true the first time a final-step
  // `handleSubmit` resolves without throwing, and stays true through
  // subsequent edits or invalidations. Only `reset()` flips it back
  // (a new run starts a new history). Distinct accounting from
  // `complete`, which is forward-looking and reactive to current form
  // validity.
  const done = ref(false)

  // --- Navigation internals --------------------------------------------

  function activateForm(form: AnyForm): void {
    const source = form as unknown as SubmissionSourceForm
    if (typeof source.activate === 'function') {
      void source.activate()
    }
  }

  function moveTo(key: FormKey, options?: { silent?: boolean }): void {
    if (activeKey.value === key) return
    activeKey.value = key
    if (!visited.value.includes(key)) visited.value.push(key)
    if (options?.silent === true) {
      lastPersisted = key
    }
    const list = compiledSteps.value
    for (const step of list) {
      if (step.key === key) {
        activateForm(step.form)
        return
      }
    }
  }

  function recordDeparture(key: FormKey): void {
    const store = registry.forms.get(key)
    if (store !== undefined) store.departAttempts.value += 1
  }

  async function next(): Promise<void> {
    if (submitting.value) {
      if (__DEV__) {
        console.warn(
          `[attaform] wizard.next(): blocked while a submit is in flight. Wait for handleSubmit to settle.`
        )
      }
      return
    }
    const idx = activeIndex.value
    const list = compiledSteps.value
    if (idx < 0 || idx >= list.length - 1) {
      if (__DEV__) {
        console.warn(
          `[attaform] wizard.next(): already on the final step ("${activeKey.value}"). Use wizard.handleSubmit() to submit.`
        )
      }
      return
    }
    recordDeparture(activeKey.value)
    const target = list[idx + 1] as CompiledStep
    moveTo(target.key)
  }

  function back(): void {
    if (submitting.value) {
      if (__DEV__) {
        console.warn(`[attaform] wizard.back(): blocked while a submit is in flight.`)
      }
      return
    }
    const idx = activeIndex.value
    if (idx <= 0) {
      if (__DEV__) {
        console.warn(`[attaform] wizard.back(): already on the first step ("${activeKey.value}").`)
      }
      return
    }
    recordDeparture(activeKey.value)
    const target = compiledSteps.value[idx - 1] as CompiledStep
    moveTo(target.key)
  }

  function goTo(key: string): void {
    if (submitting.value) {
      if (__DEV__) {
        console.warn(`[attaform] wizard.goTo(): blocked while a submit is in flight.`)
      }
      return
    }
    if (!isCompiledKey(key)) {
      if (__DEV__) {
        const known = compiledSteps.value.map((s) => `"${s.key}"`).join(', ')
        console.warn(`[attaform] wizard.goTo("${key}"): unknown step key. Known keys: ${known}.`)
      }
      return
    }
    if (key !== activeKey.value) recordDeparture(activeKey.value)
    moveTo(key)
  }

  // --- handleSubmit -----------------------------------------------------

  function buildSubmitContext(
    valuesMap: Record<FormKey, unknown>,
    currentKey: FormKey,
    isFinal: boolean
  ): WizardSubmitContext {
    return {
      values: valuesMap,
      get: ((form: AnyForm) => valuesMap[form.key]) as WizardSubmitContext['get'],
      currentKey,
      isFinal,
    }
  }

  async function processOne(form: AnyForm): Promise<ValidationResponse<unknown>> {
    const full = form as unknown as SubmissionSourceForm
    let activationFailure: string | undefined
    try {
      if (typeof full.activate === 'function') await full.activate()
    } catch (err) {
      activationFailure = (err as Error)?.message ?? String(err)
    }
    if (activationFailure === undefined && full.hydrateError != null) {
      activationFailure = full.hydrateError.message
    }
    if (activationFailure !== undefined) {
      return {
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
    }
    return full.process()
  }

  function collectErrors(
    results: ReadonlyMap<FormKey, ValidationResponse<unknown>>
  ): AggregateError[] {
    const out: AggregateError[] = []
    for (const step of compiledSteps.value) {
      const processed = results.get(step.key)
      if (processed === undefined || processed.success === true) continue
      for (const err of processed.errors) {
        const entry: { -readonly [P in keyof AggregateError]: AggregateError[P] } = {
          formKey: err.formKey,
          path: err.path,
          message: err.message,
        }
        if (err.code !== undefined) entry.code = err.code
        out.push(entry)
      }
    }
    return out
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
        if (__DEV__) {
          console.warn(
            `[attaform] wizard.handleSubmit: re-entrant submit while a prior call is still in flight; resolving no-op.`
          )
        }
        return
      }
      submitting.value = true
      try {
        const currentKey = activeKey.value
        const final = isFinalStep.value
        const list = compiledSteps.value
        const results = new Map<FormKey, ValidationResponse<unknown>>()

        if (final) {
          // Final-step submission: validate every step. Run in parallel
          // so latency is bounded by the slowest form rather than the
          // sum of all forms.
          await Promise.all(
            list.map(async (step) => {
              const result = await processOne(step.form)
              results.set(step.key, result)
            })
          )
        } else {
          // Intermediate submission: validate the active form only and
          // advance on success.
          const active = activeForm.value
          const result = await processOne(active)
          results.set(active.key, result)
        }

        // Bump per-form submissionAttempts for every form we just
        // processed (noops included — accounting-distinct counters per
        // [[feedback-api-name-hygiene]]). The wizard-level counter
        // always bumps once per invocation.
        for (const key of results.keys()) {
          const store = registry.forms.get(key)
          if (store !== undefined) store.submissionAttempts.value += 1
        }
        submissionAttempts.value += 1

        const errors = collectErrors(results)
        if (errors.length === 0) {
          const valuesMap: Record<FormKey, unknown> = {}
          for (const step of list) {
            const processed = results.get(step.key)
            if (processed !== undefined && processed.success === true) {
              valuesMap[step.key] = processed.data
            } else {
              const source = step.form as unknown as StatusSourceForm
              valuesMap[step.key] = source.values
            }
          }
          const ctx = buildSubmitContext(valuesMap, currentKey, final)
          await onSubmit(ctx)
          if (final) {
            done.value = true
          } else {
            // Intermediate success → record departure + advance to next
            // step. Mirrors the navigation arm so the URL and visited
            // trail stay coherent.
            recordDeparture(currentKey)
            const idx = activeIndex.value
            const target = list[idx + 1]
            if (target !== undefined) moveTo(target.key)
          }
        } else {
          if (onError !== undefined) await onError(errors)
          if (options.focusFirstError !== false) {
            const firstFailedKey = errors[0]?.formKey
            if (firstFailedKey !== undefined && isCompiledKey(firstFailedKey)) {
              moveTo(firstFailedKey)
              await nextTick()
              const failedForm = formsRecord.value[firstFailedKey] as unknown as
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

  // --- Reset ------------------------------------------------------------

  function reset(): void {
    submissionAttempts.value = 0
    done.value = false
    for (const step of compiledSteps.value) {
      const full = step.form as unknown as SubmissionSourceForm
      if (typeof full.reset === 'function') full.reset()
    }
    const firstStep = compiledSteps.value[0]
    if (firstStep !== undefined) {
      activeKey.value = firstStep.key
      visited.value = [firstStep.key]
      if (persistCallback !== undefined) {
        lastPersisted = firstStep.key
        persistCallback({ step: firstStep.key })
      }
    }
  }

  // --- Lifecycle hooks --------------------------------------------------

  if (getCurrentScope() !== undefined) {
    onScopeDispose(() => {
      historyHandle.dispose()
    })
  }

  // --- Handle assembly --------------------------------------------------

  const explicitKey = options.key
  const wizardKey = resolveWizardKey(explicitKey)
  const handle: UseWizardReturnType = {
    key: wizardKey,
    next,
    back,
    goTo,
    handleSubmit,
    reset,
    get currentStep(): FormKey {
      return currentStep.value
    },
    get activeForm(): AnyForm {
      return activeForm.value
    },
    get activeIndex(): number {
      return activeIndex.value
    },
    get isFinalStep(): boolean {
      return isFinalStep.value
    },
    get steps(): ReadonlyArray<CompiledStep> {
      return compiledSteps.value
    },
    get forms(): Readonly<Record<FormKey, AnyForm>> {
      return formsRecord.value
    },
    get count(): number {
      return count.value
    },
    statuses,
    get allValues(): Readonly<Record<FormKey, unknown>> {
      return allValues.value
    },
    get allErrors(): Readonly<Record<FormKey, readonly AggregateError[]>> {
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
    get done(): boolean {
      return done.value
    },
    get submitting(): boolean {
      return submitting.value
    },
    get submissionAttempts(): number {
      return submissionAttempts.value
    },
    get visited(): readonly FormKey[] {
      return visited.value
    },
  }

  // Registry registration + ambient provide --------------------------
  //
  // Every wizard (explicit or synthetic key) lands in the registry so
  // SSR hydration, DevTools labels, and the consumer-counted lifetime
  // story all work uniformly. The explicit-collision warning fires
  // only when the consumer chose the colliding key — two synthetic
  // keys can't collide (each setup-context `useId()` call returns a
  // tree-position-stable distinct id; outside setup the module-local
  // counter increments).
  const existing = registry.wizards.get(wizardKey)
  if (existing === undefined) {
    registry.wizards.set(wizardKey, handle)
  } else if (__DEV__ && explicitKey !== undefined) {
    console.warn(
      `[attaform] useWizard({ key: "${wizardKey}" }): a wizard with this key is already registered. Keeping the existing handle. Pass a unique key to each useWizard call, or share the original handle via injectWizard("${wizardKey}").`
    )
  }
  if (getCurrentScope() !== undefined) {
    const releaseWizard = registry.trackWizardConsumer(wizardKey)
    onScopeDispose(releaseWizard)
  }

  if (getCurrentInstance() !== null) {
    provide(kAttaformAncestorWizard, handle)
  }

  return handle
}

/**
 * Module-local counter for the "no Vue instance in scope" fallback
 * (tests, raw composable calls outside setup). Collisions with
 * consumer-supplied keys are impossible because the synthetic prefix
 * lives inside the reserved `__atta:` namespace and consumer keys
 * starting with `__atta:` are rejected by `useAbstractForm`. Inside
 * setup the wizard reaches for `useId()` instead, which is
 * SSR-stable across the server / hydration boundary.
 */
let anonWizardCounter = 0

/**
 * Resolve `options.key` into a concrete wizard key. Explicit keys
 * pass through; empty / nullish keys are allocated under the
 * `__atta:anon-wizard:` prefix. Mirrors `resolveFormKey` in
 * `use-abstract-form.ts` so anonymous wizards get the same SSR
 * hydration story anonymous forms do.
 */
function resolveWizardKey(key: string | undefined): string {
  if (key !== undefined && key !== null && key !== '') return key
  if (getCurrentInstance() !== null) {
    return `${ANONYMOUS_WIZARD_KEY_PREFIX}${useId()}`
  }
  return `${ANONYMOUS_WIZARD_KEY_PREFIX}${anonWizardCounter++}`
}

/** Best-effort discriminator for the `AnyForm` arm of `StepSlot`. Forms
 *  returned by `useForm` always carry a string `key` — checking that
 *  (and ruling out the other arms structurally) keeps `resolveSlot`
 *  readable without forcing every slot through a `typeof` cascade. */
function isAnyForm(value: unknown): value is AnyForm {
  if (value === null || typeof value !== 'object') return false
  if (typeof (value as { key?: unknown }).key !== 'string') return false
  return true
}
