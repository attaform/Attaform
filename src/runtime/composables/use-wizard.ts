import {
  computed,
  effectScope,
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
import { captureUserCallSite } from '../core/dev-stack-trace'
import { AttaformErrorCode } from '../core/error-codes'
import {
  kAttaformAncestorWizard,
  kAttaformWizardActiveStepResolver,
  useRegistry,
} from '../core/registry'
import { resolveTrichotomy } from '../core/resolve-default-values'
import { isLazyMarker } from '../core/wizard-lazy'
import { createWizardHistory, NOOP_WIZARD_HISTORY } from '../core/wizard-history'
import { buildNoopWizardSchema } from '../core/wizard-noop-schema'
import { buildWizardStatusesProxy } from '../core/wizard-statuses-proxy'
import { useAbstractForm, type AmbientProvideEntry } from './use-abstract-form'
import type {
  ActiveFormOf,
  AggregateError,
  AnyForm,
  CompiledStep,
  CurrentStepOf,
  FormStatus,
  LazyMarker,
  StepSlot,
  UseWizardReturnType,
  WizardCtx,
  WizardCtxForm,
  WizardForms,
  WizardOnError,
  WizardOnSubmit,
  WizardOptions,
  WizardPersistFn,
  WizardRestoreFn,
  WizardRestoreState,
  WizardSubmitContext,
} from '../types/types-wizard'
import type { FormKey, UseFormReturnType, ValidationResponse } from '../types/types-api'
import type { GenericForm } from '../types/types-core'

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

/**
 * Subset of the form's surface the wizard reads for status + values.
 * Picked off the public `UseFormReturnType` so additions on the form
 * side don't drift this slice (and so a removal/rename trips the type
 * checker instead of leaking silently through a hand-redeclared shape).
 */
type StatusSourceForm = Pick<UseFormReturnType<GenericForm>, 'meta' | 'values'>

/**
 * Subset of the form's surface the wizard's submission walk exercises.
 * Picked off `UseFormReturnType` for the same drift-detection reason as
 * `StatusSourceForm`.
 */
type SubmissionSourceForm = Pick<
  UseFormReturnType<GenericForm>,
  'meta' | 'values' | 'activate' | 'process' | 'applyInvalidSubmitPolicy' | 'reset' | 'hydrateError'
>

/**
 * Internal helpers that center the `AnyForm → UseFormReturnType` cast.
 * The wizard's slot surface is intentionally narrow (`AnyForm` —
 * `{ readonly key: FormKey }`) to avoid forcing contravariant
 * unification across participating forms; at runtime every form is
 * the full `UseFormReturnType`. These helpers do the one-way coercion
 * in a single place per surface so call sites read as a typed access
 * instead of a `as unknown as` chain (W-COUPLE-1).
 */
function asStatusSource(form: AnyForm): StatusSourceForm {
  return form as unknown as StatusSourceForm
}
function asSubmissionSource(form: AnyForm): SubmissionSourceForm {
  return form as unknown as SubmissionSourceForm
}

/**
 * Multistep-form orchestrator built around an ordered list of step slots.
 * Each slot resolves to a participating form: an existing `useForm`
 * reference, a bare string key (desugared to a noop form so affordance
 * steps participate uniformly), an eagerly-evaluated function slot for
 * runtime branching, or a `lazy()`-wrapped function slot that caches
 * its resolution and re-fires only on its own tracked deps.
 *
 * The wizard's surface is read-only from the consumer's side:
 * navigation (`next` / `back` / `goTo`) walks positional indices,
 * `handleSubmit` validates the active form on intermediate steps and
 * the whole wizard on the final step, and URL synchronization rides on
 * `restore` / `persist` callbacks that default to `?step=<key>`.
 */
export function useWizard<const S extends ReadonlyArray<StepSlot>>(
  options: WizardOptions & { readonly steps: S }
): UseWizardReturnType<S> {
  // Defensive coercion: a misshapen `steps` (non-array, undefined, empty)
  // never crashes the surrounding app. Dev-warn surfaces the
  // misconfiguration; runtime continues with an empty list and the
  // wizard reads as degenerate (`currentStep === undefined`,
  // navigation refuses, `handleSubmit` no-ops). The "wizard wired into
  // a checkout never crashes" promise sits on this branch.
  const rawSteps: ReadonlyArray<StepSlot> = Array.isArray(options.steps) ? options.steps : []
  if (rawSteps.length === 0 && __DEV__) {
    console.error(
      '[attaform] useWizard({ steps }): expected a non-empty array of step slots. Continuing with an empty step list — wizard.currentStep reads as undefined, navigation refuses, handleSubmit no-ops.'
    )
  }

  const registry = useRegistry()

  // --- Noop-form synthesis for top-level string slots -------------------
  //
  // String slots desugar to a wizard-owned `useAbstractForm` call backed
  // by `buildNoopWizardSchema`. Synthesis runs at setup time so the
  // forms are registered in the registry (status + ref-counting +
  // consumer eviction all flow through the same paths as real forms).
  // Function and lazy slots may also return string keys at runtime,
  // including ones not declared at the top level. Those go through
  // `getOrBuildNoop` below, which constructs a noop on the fly inside
  // a wizard-scoped `effectScope` so consumer cleanup, registry
  // presence, and the rest of the FormStore surface stay identical to
  // an eagerly-built noop.
  const noopForms = new Map<string, AnyForm>()
  // Wizard-private scope for lazily-built noops. Building inside this
  // scope lets `useAbstractForm` register its `onScopeDispose` hook
  // against the wizard's lifetime, not against whatever component
  // happens to be active when the function slot first returned an
  // undeclared key. Stopped when the wizard's own setup scope tears
  // down.
  const lazyNoopScope = effectScope(true)
  for (const slot of rawSteps) {
    if (typeof slot !== 'string') continue
    if (noopForms.has(slot)) continue
    const noop = useAbstractForm({
      schema: buildNoopWizardSchema(slot),
      key: slot,
    }) as unknown as AnyForm
    noopForms.set(slot, noop)
  }

  function getOrBuildNoop(key: string): AnyForm {
    const existing = noopForms.get(key)
    if (existing !== undefined) return existing
    const noop = lazyNoopScope.run(
      () =>
        useAbstractForm(
          {
            schema: buildNoopWizardSchema(key),
            key,
          },
          { registry }
        ) as unknown as AnyForm
    )
    if (noop === undefined) {
      // `lazyNoopScope.run` only returns `undefined` if the scope has
      // already been stopped, which only happens at wizard teardown.
      // Reaching this branch means the wizard is mid-disposal; return
      // a structurally-empty stand-in so the caller's compile pass
      // completes without crashing.
      const stub: AnyForm = { key }
      return stub
    }
    noopForms.set(key, noop)
    formsAccumulator.set(key, noop)
    return noop
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
  // Each `lazy()` slot gets its own Vue computed. The resolver fires
  // eagerly on the first compile pass and the result memoizes. The
  // cache invalidates only when one of the resolver's own tracked
  // reactive reads changes (Vue handles dep tracking) — an unrelated
  // slot re-evaluating does not re-fire this one. `wizard.reset()`
  // bumps `lazyEpoch` so every lazy computed re-fires on the next
  // compile pass.
  //
  // The computed caches the resolver's *raw* return (form / string /
  // undefined). String → noop conversion happens outside the computed
  // so noop-construction reactivity doesn't leak into the lazy slot's
  // dep set (otherwise the form registry's initialization writes
  // would invalidate the cache on the very first compile pass).
  //
  // The map is keyed by slot index in `rawSteps`; population happens
  // eagerly below so cross-test mounts get fresh per-index closures.
  const lazyEpoch = ref(0)
  type LazyResult = AnyForm | string | undefined
  const lazyComputeds = new Map<number, ComputedRef<LazyResult>>()

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
  // Shared slot-resolution context. Built as a plain object with
  // `currentKey` exposed as a getter so the `activeKey` dep is
  // established only when a slot body actually reads `ctx.currentKey`
  // — every navigation writes `activeKey`, so reading it eagerly
  // (e.g. via a wrapping `computed`) would thread the dep through
  // every bare function slot and re-fire the entire compile pass on
  // each `next` / `back` / `goTo`. The getter form lets `lazy()` and
  // bare function slots opt into the active-step dep individually.
  const slotCtx: WizardCtx = {
    forms: slotForms,
    get currentKey() {
      return activeKey.value === '' ? undefined : activeKey.value
    },
  }

  /**
   * Resolve a single raw slot to a participating form, or `undefined`
   * to drop that slot from the compiled list. Hoisted to a free
   * function so the steps computed stays readable.
   */
  function resolveSlot(slot: StepSlot, index: number, ctx: WizardCtx): AnyForm | undefined {
    if (typeof slot === 'string') {
      // Top-level string slots are pre-built into `noopForms` at
      // construction. The lazy builder hits the cache; the unified
      // path keeps function/lazy string returns consistent with
      // top-level string slots.
      return getOrBuildNoop(slot)
    }
    if (isLazyMarker(slot)) {
      // Lazy slots flow through their own per-slot computed. Reading
      // `.value` here memoizes by the resolver's tracked reactive
      // reads; other slots re-evaluating around it do not re-fire
      // this one. String → noop conversion runs out here so the
      // resolver's dep set stays clean of noop-construction side
      // effects.
      const c = lazyComputeds.get(index)
      return c === undefined ? undefined : resolveSlotResult(c.value)
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
      // Function and lazy slot string returns build a noop on first
      // reference. Subsequent returns of the same string hit the
      // cache. Authors don't have to pre-declare affordance keys
      // anywhere; the wizard handles new keys uniformly.
      return getOrBuildNoop(result)
    }
    return result
  }

  // Eagerly populate one computed per lazy slot. Each computed
  // subscribes to `lazyEpoch` so `reset()` can invalidate every cache
  // in one move, and to whatever reactive reads its own resolver makes
  // (Vue's standard dep tracking). The closure over `idx` and `marker`
  // pins this computed to a specific slot in `rawSteps`. Lazy slots
  // and bare function slots share `slotCtx` — the same getter-style
  // object — so the `activeKey` dep is opt-in per resolver body for
  // both slot kinds.
  for (let i = 0; i < rawSteps.length; i++) {
    const slot = rawSteps[i]
    if (isLazyMarker(slot)) {
      const idx = i
      const marker = slot as LazyMarker
      lazyComputeds.set(
        idx,
        computed(() => {
          void lazyEpoch.value
          return marker.resolve(slotCtx)
        })
      )
    }
  }

  // The compiled step list. Function slots re-evaluate on every read
  // of their reactive deps; lazy slots run through their own memoized
  // computed; string slots cache their noop forms. The compile pass
  // itself has no `activeKey` dep — each function-slot body
  // contributes its own deps through `slotCtx.currentKey`'s getter,
  // so navigation only re-fires the slots that actually look at the
  // active step.
  const compiledSteps = computed<readonly CompiledStep[]>(() => {
    const out: CompiledStep[] = []
    const seen = new Set<FormKey>()
    for (let i = 0; i < rawSteps.length; i++) {
      const slot = rawSteps[i] as StepSlot
      const form = resolveSlot(slot, i, slotCtx)
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

  const currentStep = computed<FormKey | undefined>(() => {
    const key = activeKey.value
    if (key !== '') return key
    const first = compiledSteps.value[0]
    return first === undefined ? undefined : first.key
  })

  const activeForm = computed<AnyForm | undefined>(() => {
    const list = compiledSteps.value
    const idx = activeIndex.value
    if (idx >= 0 && idx < list.length) {
      return (list[idx] as CompiledStep).form
    }
    const first = list[0]
    return first === undefined ? undefined : first.form
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

  // "Form ready?" gate — `true` once a participating form's defaults
  // have applied (sync defaults at construction, or async factory
  // settle complete). Reads through the registry's per-store flag,
  // not through the public `form.ready` getter, because the latter
  // would activate dormant lazy factories the wizard hasn't asked
  // for. Hoisted so `errorsFor` and `statusFor` share one definition
  // of the gate (W-DUP-2 dedup).
  function isFormReady(key: FormKey): boolean {
    const store = registry.forms.get(key)
    return store?.defaultsResolved.value === true
  }

  // Lift a per-form error into the wizard's aggregate shape. `err`
  // may arrive without `formKey` (e.g. entries from `form.meta.errors`,
  // which are pre-scoped to the form) or with it (`ValidationError`
  // entries from `processOne`'s result). Centralising the lift dedups
  // the construction shared by `allErrors` and `collectErrors`
  // (W-DUP-1).
  function toAggregateError(
    err: {
      readonly path: ReadonlyArray<string | number>
      readonly message: string
      readonly code?: string
      readonly formKey?: FormKey
    },
    fallbackKey: FormKey
  ): AggregateError {
    const entry: { -readonly [P in keyof AggregateError]: AggregateError[P] } = {
      formKey: err.formKey ?? fallbackKey,
      path: err.path,
      message: err.message,
    }
    if (err.code !== undefined) entry.code = err.code
    return entry
  }

  // Per-key memoization for `allValues` / `allErrors`. One field edit
  // on form A only invalidates form A's slot; templates reading
  // `wizard.allErrors.formB` stay cached. Mirrors `statusCache` below
  // — the audit's COMP-W2 finding flagged the whole-record
  // re-evaluation each per-step computed used to do.
  const valuesCache = new Map<FormKey, ComputedRef<unknown>>()
  function valuesFor(form: AnyForm): ComputedRef<unknown> {
    const cached = valuesCache.get(form.key)
    if (cached !== undefined) return cached
    const source = asStatusSource(form)
    const computedValues = computed(() => source.values)
    valuesCache.set(form.key, computedValues)
    return computedValues
  }

  const errorsCache = new Map<FormKey, ComputedRef<readonly AggregateError[]>>()
  function errorsFor(form: AnyForm): ComputedRef<readonly AggregateError[]> {
    const cached = errorsCache.get(form.key)
    if (cached !== undefined) return cached
    const source = asStatusSource(form)
    const computedErrors = computed<readonly AggregateError[]>(() => {
      if (!isFormReady(form.key)) return []
      const errors = source.meta?.errors ?? []
      const list: AggregateError[] = []
      for (const err of errors) list.push(toAggregateError(err, form.key))
      return list
    })
    errorsCache.set(form.key, computedErrors)
    return computedErrors
  }

  // Identity-stable Proxy surfaces backed by the per-key caches.
  // `get` and `getOwnPropertyDescriptor` delegate to the per-key
  // ComputedRef, so reads track only the form they target; `ownKeys`
  // and `has` use `formsRecord` so iteration order matches the
  // compiled step list.
  const allValues = new Proxy({} as Record<FormKey, unknown>, {
    get(_, key: string | symbol): unknown {
      if (typeof key !== 'string') return undefined
      const form = formsRecord.value[key]
      if (form === undefined) return undefined
      return valuesFor(form).value
    },
    has(_, key: string | symbol): boolean {
      if (typeof key !== 'string') return false
      return formsRecord.value[key] !== undefined
    },
    ownKeys(): ArrayLike<string | symbol> {
      return Object.keys(formsRecord.value)
    },
    getOwnPropertyDescriptor(_, key: string | symbol): PropertyDescriptor | undefined {
      if (typeof key !== 'string') return undefined
      const form = formsRecord.value[key]
      if (form === undefined) return undefined
      return {
        configurable: true,
        enumerable: true,
        writable: false,
        value: valuesFor(form).value,
      }
    },
  }) as Readonly<Record<FormKey, unknown>>

  const allErrors = new Proxy({} as Record<FormKey, readonly AggregateError[]>, {
    get(_, key: string | symbol): readonly AggregateError[] | undefined {
      if (typeof key !== 'string') return undefined
      const form = formsRecord.value[key]
      if (form === undefined) return undefined
      return errorsFor(form).value
    },
    has(_, key: string | symbol): boolean {
      if (typeof key !== 'string') return false
      return formsRecord.value[key] !== undefined
    },
    ownKeys(): ArrayLike<string | symbol> {
      return Object.keys(formsRecord.value)
    },
    getOwnPropertyDescriptor(_, key: string | symbol): PropertyDescriptor | undefined {
      if (typeof key !== 'string') return undefined
      const form = formsRecord.value[key]
      if (form === undefined) return undefined
      return {
        configurable: true,
        enumerable: true,
        writable: false,
        value: errorsFor(form).value,
      }
    },
  }) as Readonly<Record<FormKey, readonly AggregateError[]>>

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
    const source = asStatusSource(form)
    const computedStatus = computed<FormStatus>(() => {
      if (isFormReady(form.key)) {
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

  function firstKey(): FormKey | undefined {
    const first = compiledSteps.value[0]
    return first === undefined ? undefined : first.key
  }

  let initialKey: FormKey | undefined
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
  if (initialKey !== undefined) {
    activeKey.value = initialKey
    visited.value = [initialKey]
  }
  // Degenerate path (`initialKey === undefined`): activeKey stays `''`,
  // visited stays `[]`, and downstream getters surface `undefined`
  // accordingly. The wizard handle is still constructable; the
  // surrounding app keeps rendering.

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
      const source = asSubmissionSource(step.form)
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
    // key — the diff in the watcher handles steady-state). The
    // `initialKey !== undefined` guard short-circuits the degenerate
    // path: with an empty steps list there's no step to persist.
    if (
      initialKey !== undefined &&
      initialKey !== initialUrlValue &&
      initialUrlValue === undefined
    ) {
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
    const source = asSubmissionSource(form)
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
    const list = compiledSteps.value
    if (list.length === 0) {
      if (__DEV__) {
        console.warn(`[attaform] wizard.next(): wizard has no compiled steps; no-op.`)
      }
      return
    }
    const idx = activeIndex.value
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
    if (compiledSteps.value.length === 0) {
      if (__DEV__) {
        console.warn(`[attaform] wizard.back(): wizard has no compiled steps; no-op.`)
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
    const full = asSubmissionSource(form)
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
      for (const err of processed.errors) out.push(toAggregateError(err, step.key))
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
      if (compiledSteps.value.length === 0) {
        if (__DEV__) {
          console.warn(`[attaform] wizard.handleSubmit: wizard has no compiled steps; no-op.`)
        }
        return
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
          // advance on success. The empty-list short-circuit above
          // guarantees `activeForm.value` is defined here.
          const active = activeForm.value as AnyForm
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
              valuesMap[step.key] = asStatusSource(step.form).values
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
              const failedForm = formsRecord.value[firstFailedKey]
              if (failedForm !== undefined) {
                const failedSource = asSubmissionSource(failedForm)
                if (typeof failedSource.applyInvalidSubmitPolicy === 'function') {
                  failedSource.applyInvalidSubmitPolicy()
                }
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
    // Bump the lazy epoch so every `lazy()` slot's memoized computed
    // re-fires on the next compile pass. Without this, expensive
    // one-shot lookups would stay glued to their first resolution
    // across a wizard reboot — and `reset()` is meant to be a true
    // reboot, not a soft rewind.
    lazyEpoch.value += 1
    for (const step of compiledSteps.value) {
      const full = asSubmissionSource(step.form)
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
      lazyNoopScope.stop()
    })
  }

  // --- Handle assembly --------------------------------------------------

  const explicitKey = options.key
  const wizardKey = resolveWizardKey(explicitKey)
  // The handle's parameterized return type narrows `currentStep` /
  // `activeForm` to non-undefined when the steps tuple is statically
  // safe (see `StaticallyNonEmpty` in types-wizard.ts). The runtime
  // can't observe the tuple shape, so the active-position getters
  // cast through `CurrentStepOf<S>` / `ActiveFormOf<S>`. The cast is
  // sound: when `S` passes the static-safety predicate, the compiled
  // step list is guaranteed non-empty (only Form and string slots
  // preserve their positions; function / lazy slots are precluded by
  // the predicate), so the getters never observe the degenerate
  // `undefined` branch in that case.
  const handle: UseWizardReturnType<S> = {
    key: wizardKey,
    next,
    back,
    goTo,
    handleSubmit,
    reset,
    get currentStep(): CurrentStepOf<S> {
      return currentStep.value as CurrentStepOf<S>
    },
    get activeForm(): ActiveFormOf<S> {
      return activeForm.value as ActiveFormOf<S>
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
    get forms(): WizardForms<S> {
      return formsRecord.value as unknown as WizardForms<S>
    },
    get count(): number {
      return count.value
    },
    statuses,
    allValues,
    allErrors,
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

  // Anonymous wizards fill the ambient slot for descendant
  // `injectWizard()` calls; keyed wizards stay registry-only, so
  // explicit / ambient resolution stays disjoint (mirrors `useForm`).
  if (getCurrentInstance() !== null && explicitKey === undefined) {
    recordAmbientWizardProvide(registry.ssr)
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
 * Tracks which parent Vue component instances have already run an
 * anonymous-wizard ambient provide. Dev-only; `null` in production so
 * the WeakMap allocation tree-shakes out. Exported so `injectWizard()`
 * (no key) can walk the parent chain and warn lazily when a single
 * parent registered more than one anonymous `useWizard()`, since Vue's
 * `provide` is last-write-wins. Mirrors `ambientProvideHistory` on the
 * form side.
 */
export const ambientWizardProvideHistory: WeakMap<object, AmbientProvideEntry[]> | null = __DEV__
  ? new WeakMap<object, AmbientProvideEntry[]>()
  : null

function recordAmbientWizardProvide(ssr: boolean): void {
  if (!__DEV__ || ssr || ambientWizardProvideHistory === null) return
  const instance = getCurrentInstance()
  if (instance === null) return
  const instanceKey = instance as unknown as object
  const entry: AmbientProvideEntry = {
    source: captureUserCallSite(),
  }
  const existing = ambientWizardProvideHistory.get(instanceKey)
  if (existing === undefined) {
    ambientWizardProvideHistory.set(instanceKey, [entry])
    return
  }
  existing.push(entry)
}

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
