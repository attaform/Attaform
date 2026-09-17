import {
  computed,
  effectScope,
  getCurrentInstance,
  getCurrentScope,
  inject,
  nextTick,
  onScopeDispose,
  provide,
  reactive,
  ref,
  useId,
  watch,
  watchEffect,
  type ComputedRef,
} from 'vue'
import { __DEV__ } from '../core/dev'
import { ANONYMOUS_WIZARD_KEY_PREFIX } from '../core/defaults'
import { captureUserCallSite } from '../core/dev-stack-trace'
import { AttaformErrorCode } from '../core/error-codes'
import { SubmitErrorHandlerError, toError } from '../core/errors'
import {
  kAttaformAncestorWizard,
  kAttaformWizardActiveStepResolver,
  useRegistry,
} from '../core/registry'
import { resolveTrichotomy } from '../core/resolve-default-values'
import { isLazyMarker } from '../core/wizard-lazy'
import { isGateMarker } from '../core/wizard-gate'
import { createWizardHistory, NOOP_WIZARD_HISTORY } from '../core/wizard-history'
import { buildNoopWizardSchema } from '../core/wizard-noop-schema'
import { buildWizardStatusesProxy } from '../core/wizard-statuses-proxy'
import { useAbstractForm, type AmbientProvideEntry } from './use-abstract-form'
import type {
  ActiveFormOf,
  WizardAggregateError,
  AnyForm,
  CompiledStep,
  CurrentStepOf,
  FormStatus,
  FormStatusSeed,
  LazyMarker,
  SlotResolution,
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
import type {
  FormKey,
  HandleSubmit,
  UseFormReturnType,
  ValidationResponse,
} from '../types/types-api'
import type { GenericForm } from '../types/types-core'
import type { FormStore } from '../core/create-form-store'

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
  locked: false,
  gate: null,
}

/** Status for a noop form, the desugaring of a string affordance step.
 *  A noop has no schema, no fields and no error surface, so it is
 *  trivially valid and the progress and complete computeds can read a
 *  string slot as done by being there. */
const NOOP_VALID_STATUS: FormStatus = {
  valid: true,
  dirty: false,
  submitted: false,
  errorCount: 0,
  locked: false,
  gate: null,
}

/** Shared empty lock set for wizards that declare no `locked` policy, so
 *  the no-policy path allocates nothing and reads as "nothing locked." */
const EMPTY_LOCK_SET: ReadonlySet<FormKey> = new Set()

/**
 * What the wizard reads for status and values. `Pick`ed off the public
 * `UseFormReturnType` so a removal or rename on the form side trips the
 * type checker rather than leaking through a hand-redeclared shape.
 */
type StatusSourceForm = Pick<UseFormReturnType<GenericForm>, 'meta' | 'values'>

/** What the submission walk exercises. Same drift check as `StatusSourceForm`. */
type SubmissionSourceForm = Pick<
  UseFormReturnType<GenericForm>,
  'meta' | 'values' | 'activate' | 'parse' | 'applyInvalidSubmitPolicy' | 'reset' | 'hydrateError'
>

/**
 * The public `CompiledStep` plus the `isGate` flag the gating spine
 * reads, recording which position a `gate()` wrapped. It stays off
 * `CompiledStep` so `wizard.steps` keeps its clean `{ key, form }`
 * surface; the flag belongs to the lock derivation alone.
 */
type CompiledStepInternal = CompiledStep & { readonly isGate: boolean }

/**
 * Center the `AnyForm` to `UseFormReturnType` coercion, one helper per
 * surface, so a call site reads as a typed access rather than an `as
 * unknown as` chain. The slot surface is deliberately narrow (`AnyForm`
 * is `{ readonly key: FormKey }`) to avoid forcing contravariant
 * unification across participating forms, but at runtime every one of
 * them is the full `UseFormReturnType`.
 */
function asStatusSource(form: AnyForm): StatusSourceForm {
  return form as unknown as StatusSourceForm
}
function asSubmissionSource(form: AnyForm): SubmissionSourceForm {
  return form as unknown as SubmissionSourceForm
}
// Same coercion for the live `activeForm` facade. The slot type omits
// `handleSubmit`; every participating form carries it at runtime.
function asHandleSubmitSource(form: AnyForm): Pick<UseFormReturnType<GenericForm>, 'handleSubmit'> {
  return form as unknown as Pick<UseFormReturnType<GenericForm>, 'handleSubmit'>
}

/**
 * Multistep-form orchestrator built around an ordered list of step
 * slots. A slot resolves to a participating form four ways: an existing
 * `useForm` reference, a bare string key (desugared to a noop form, so
 * an affordance step participates like any other), an eager function
 * slot for runtime branching, or a `lazy()`-wrapped function slot that
 * caches its resolution and re-fires only on its own tracked deps.
 *
 * Navigation (`next` / `back` / `goTo`) walks positional indices.
 * `handleSubmit` validates the whole step list from any step and never
 * advances; to gate an advance, write
 * `activeForm.handleSubmit(() => wizard.next())`. URL sync rides on the
 * `restore` / `persist` callbacks, which default to `?step=<key>`.
 */
export function useWizard<const S extends ReadonlyArray<StepSlot>>(
  options: WizardOptions & { readonly steps: S }
): UseWizardReturnType<S> {
  // A misshapen `steps` must never crash the surrounding app. The dev
  // error surfaces the misconfiguration and the runtime continues
  // degenerate: `currentStep` undefined, navigation refuses,
  // `handleSubmit` no-ops. A wizard wired into a checkout rests here.
  const rawSteps: ReadonlyArray<StepSlot> = Array.isArray(options.steps) ? options.steps : []
  if (rawSteps.length === 0 && __DEV__) {
    console.error(
      '[attaform] useWizard({ steps }): expected a non-empty array of step slots. Continuing with an empty step list — wizard.currentStep reads as undefined, navigation refuses, handleSubmit no-ops.'
    )
  }

  const registry = useRegistry()

  // --- Noop-form synthesis for top-level string slots -------------------
  //
  // A string slot desugars to a wizard-owned `useAbstractForm` over
  // `buildNoopWizardSchema`. Synthesising at setup time is what puts the
  // form in the registry, so status, ref-counting and consumer eviction
  // all follow the paths real forms take. A function or lazy slot can
  // return a string key too, including one never declared at the top
  // level; `getOrBuildNoop` below builds those on the fly.
  const noopForms = new Map<string, AnyForm>()
  // Building inside a wizard-private scope is what binds
  // `useAbstractForm`'s `onScopeDispose` to the wizard's lifetime rather
  // than to whichever component happened to be active when a function
  // slot first returned an undeclared key.
  const lazyNoopScope = effectScope(true)
  for (const slot of rawSteps) {
    if (typeof slot !== 'string') continue
    if (noopForms.has(slot)) continue
    const noop = useAbstractForm({
      schema: buildNoopWizardSchema(),
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
            schema: buildNoopWizardSchema(),
            key,
          },
          { registry }
        ) as unknown as AnyForm
    )
    if (noop === undefined) {
      // `run` returns `undefined` only on a stopped scope, so reaching
      // here means the wizard is mid-teardown. An empty stand-in lets
      // the caller's compile pass finish without crashing.
      const stub: AnyForm = { key }
      return stub
    }
    noopForms.set(key, noop)
    formsAccumulator.set(key, noop)
    return noop
  }

  // --- Static slot inventory -------------------------------------------
  //
  // Every form a top-level slot references, which seeds consumer
  // tracking. Function slots add to it as they resolve.
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
  // Each `lazy()` slot gets its own computed, fired eagerly on the first
  // compile pass and memoized after. Only that resolver's own tracked
  // reads invalidate it, so an unrelated slot re-evaluating cannot
  // re-fire it. `wizard.reset()` bumps `lazyEpoch` to re-fire them all.
  //
  // The computed caches the resolver's RAW return: form, string, nested
  // marker or nullish. String-to-noop conversion and nested-marker
  // unwrapping stay outside it, in `normalizeSlot`, or the form
  // registry's initialization writes would land in this slot's dep set
  // and invalidate the cache on the very first compile pass.
  //
  // Keying the memo by marker identity rather than slot index is what
  // lets a `lazy()` inside a `gate()` resolve through one stable cache
  // in either composition order. The WeakMap lets a dropped marker's
  // cache go with it.
  const lazyEpoch = ref(0)
  const lazyComputeds = new WeakMap<LazyMarker, ComputedRef<SlotResolution>>()

  // The canonical source of truth for the active step, initialized below
  // from `restore` or the first compiled slot's key. Declared this early
  // so the slot compiler's `ctx.currentKey` can read it.
  const activeKey = ref<string>('')

  // Forms reachable through top-level slots. The slot context's `forms`
  // projection reads this Map, which gives a function slot a stable
  // lookup surface (`ctx.forms.account`) without making the slot context
  // depend on the compiled step list. That dependency would close a
  // reactive cycle through the slot compiler.
  const formsAccumulator = new Map<FormKey, AnyForm>()
  for (const slot of rawSteps) {
    if (typeof slot === 'string') {
      const noop = noopForms.get(slot)
      if (noop !== undefined) formsAccumulator.set(noop.key, noop)
    } else if (isAnyForm(slot)) {
      formsAccumulator.set(slot.key, slot)
    }
  }

  // Projected to consumers as the single argument of a function slot.
  // Loosely typed, because the wizard does not thread each step's schema
  // through `ctx.forms`; reach back to the original form ref for that.
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
  // A plain object, with `currentKey` as a GETTER so the `activeKey` dep
  // is established only when a slot body actually reads it. Every
  // navigation writes `activeKey`, so reading it eagerly (through a
  // wrapping `computed`, say) would thread the dep through every bare
  // function slot and re-fire the whole compile pass on each `next` /
  // `back` / `goTo`. The getter lets each slot opt in for itself.
  const slotCtx: WizardCtx = {
    forms: slotForms,
    get currentKey() {
      return activeKey.value === '' ? undefined : activeKey.value
    },
  }

  /** The memo computed for a `lazy()` marker, keyed by marker identity. */
  function lazyComputedFor(marker: LazyMarker): ComputedRef<SlotResolution> {
    const cached = lazyComputeds.get(marker)
    if (cached !== undefined) return cached
    const c = computed<SlotResolution>(() => {
      void lazyEpoch.value
      return marker.resolve(slotCtx)
    })
    lazyComputeds.set(marker, c)
    return c
  }

  // gate / lazy / function nesting runs a handful of levels deep in any
  // real wizard, so this only catches a resolver that returns itself.
  const MAX_SLOT_DEPTH = 32

  /**
   * Resolve one slot to a participating form plus whether a `gate()`
   * wrapped it anywhere on the way down, or `undefined` to drop the slot
   * from the compiled list.
   *
   * Each level unwraps one layer and recurses: a `gate()` records itself
   * and descends into its inner slot, a `lazy()` reads its memo, a
   * function slot is called, a string desugars to its noop, and a form
   * bottoms out. So `gate()` and `lazy()` compose in either order, and a
   * function or lazy resolver may itself return a `gate()`. The
   * string-to-noop conversion and the nested-marker reads live here
   * rather than inside a lazy computed, to keep resolver dep sets clean.
   */
  function normalizeSlot(
    slot: unknown,
    ctx: WizardCtx,
    gated: boolean,
    depth: number
  ): { form: AnyForm; gated: boolean } | undefined {
    if (depth > MAX_SLOT_DEPTH) {
      if (__DEV__) {
        console.warn(
          `[attaform] useWizard: a step slot nested past ${MAX_SLOT_DEPTH} levels (gate / lazy / function); dropping it. Check for a resolver that returns itself.`
        )
      }
      return undefined
    }
    // A literal absence, such as `cond ? form : null`, drops out.
    if (slot === undefined || slot === null) return undefined
    // Built on first reference; a top-level string was pre-built at
    // construction and hits that cache. Affordance keys are never
    // pre-declared, so a new key has to work like any other.
    if (typeof slot === 'string') return { form: getOrBuildNoop(slot), gated }
    // `gate(step)`: mark the position and descend. The flag rides through
    // every further unwrap.
    if (isGateMarker(slot)) return normalizeSlot(slot.inner, ctx, true, depth + 1)
    // `lazy(fn)`: read the memo, then normalize the raw result, which may
    // itself be a string, gate or lazy.
    if (isLazyMarker(slot)) return normalizeSlot(lazyComputedFor(slot).value, ctx, gated, depth + 1)
    // Eager function slot.
    if (typeof slot === 'function') {
      const result = (slot as (ctx: WizardCtx) => SlotResolution)(ctx)
      return normalizeSlot(result, ctx, gated, depth + 1)
    }
    if (isAnyForm(slot)) return { form: slot, gated }
    return undefined
  }

  // A function slot re-evaluates on every read of its reactive deps, a
  // lazy slot runs through its own memo, a string slot caches its noop,
  // and a `gate()` marks its position while staying transparent to the
  // resolved form. The compile pass carries no `activeKey` dep of its
  // own: each function-slot body contributes its deps through
  // `slotCtx.currentKey`'s getter, so navigation re-fires only the slots
  // that actually look at the active step.
  const compiledSteps = computed<readonly CompiledStepInternal[]>(() => {
    const out: CompiledStepInternal[] = []
    const seen = new Set<FormKey>()
    for (let i = 0; i < rawSteps.length; i++) {
      const norm = normalizeSlot(rawSteps[i], slotCtx, false, 0)
      if (norm === undefined) continue
      const { form, gated } = norm
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
      out.push({ key: form.key, form, isGate: gated })
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

  // `currentStep` and `activeForm` share this `activeIndex`-aware
  // lookup, so they can never disagree on which step the wizard is on.
  // The forward-continuity watch below keeps `activeKey` on a live step,
  // so `activeIndex` is in range in steady state; the `list[0]` fallback
  // covers only the sub-tick before that watch flushes, plus the
  // degenerate empty-key case.
  const currentStep = computed<FormKey | undefined>(() => {
    const list = compiledSteps.value
    const idx = activeIndex.value
    if (idx >= 0 && idx < list.length) {
      return (list[idx] as CompiledStep).key
    }
    const first = list[0]
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

  // Forward continuity. When the active step drops out of the compiled
  // list, because a function or lazy slot that yielded it now returns
  // nullish, re-point `activeKey` at whichever step took its place, so
  // the flow continues FORWARD instead of snapping back to step one. A
  // dropped last step clamps to the new last; an emptied wizard falls
  // back to the degenerate empty key. Re-pinning at the source is what
  // keeps `activeIndex`, `currentStep`, `activeForm` and index-based
  // navigation agreeing, rather than stranding `activeKey` on a dead
  // key.
  watch(compiledSteps, (list, prevList) => {
    const key = activeKey.value
    if (key === '') return
    if (list.some((step) => step.key === key)) return
    if (list.length === 0) {
      commitActiveKey('')
      return
    }
    const oldIndex = prevList.findIndex((step) => step.key === key)
    const slid = list[oldIndex < 0 ? 0 : Math.min(oldIndex, list.length - 1)]
    if (slid !== undefined) commitActiveKey(slid.key)
  })

  // Every read of `wizard.activeForm` returns this one facade, so a
  // handler captured once at setup stays correct as the wizard advances:
  //
  //   const onNext = wizard.activeForm.handleSubmit(() => wizard.next())
  //
  // `handleSubmit` is late-bound: the submit handler it returns resolves
  // the active form when it RUNS, so `onNext` validates whichever step
  // is current at click time rather than pinning to step one. Every
  // other access forwards to the current form; reach for
  // `wizard.forms[key]` for a specific step's raw handle. The Proxy
  // target is inert, all behaviour living in the traps, which read the
  // reactive `activeForm` at access time and no-op when there are no
  // steps.
  const activeFormFacade = new Proxy({} as UseFormReturnType<GenericForm>, {
    get(_target, prop) {
      const form = activeForm.value
      if (form === undefined) return undefined
      if (prop === 'handleSubmit') {
        const lateBound: HandleSubmit<GenericForm> = (onValid, onInvalid) => {
          return (event?: Event): Promise<void> => {
            const current = activeForm.value
            if (current === undefined) return Promise.resolve()
            return asHandleSubmitSource(current).handleSubmit(onValid, onInvalid)(event)
          }
        }
        return lateBound
      }
      return Reflect.get(form, prop, form)
    },
    has(_target, prop) {
      const form = activeForm.value
      return form === undefined ? false : Reflect.has(form, prop)
    },
    ownKeys(_target) {
      const form = activeForm.value
      return form === undefined ? [] : Reflect.ownKeys(form)
    },
    getOwnPropertyDescriptor(_target, prop) {
      const form = activeForm.value
      if (form === undefined) return undefined
      const descriptor = Reflect.getOwnPropertyDescriptor(form, prop)
      if (descriptor === undefined) return undefined
      // The Proxy invariant: a descriptor reported for a key absent from
      // the inert target must be configurable, however the handle
      // defines it.
      return { ...descriptor, configurable: true }
    },
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

  // `true` once a participating form's defaults have applied, whether
  // sync at construction or an async factory that has settled. It reads
  // the registry's per-store flag rather than the public `form.ready`
  // getter, because that getter would activate dormant lazy factories
  // the wizard never asked for. Shared by `errorsFor` and `statusFor`.
  function isFormReady(key: FormKey): boolean {
    const store = registry.forms.get(key)
    return store?.defaultsResolved.value === true
  }

  // Lift a per-form error into the wizard's aggregate shape. Which form
  // an entry belongs to is envelope-level identity: the wizard knows the
  // step it is processing and stamps that key on. Shared by `allErrors`
  // and `collectErrors`.
  function toWizardAggregateError(
    err: {
      readonly path: ReadonlyArray<string | number>
      readonly message: string
      readonly code?: string
    },
    stepKey: FormKey
  ): WizardAggregateError {
    const entry: { -readonly [P in keyof WizardAggregateError]: WizardAggregateError[P] } = {
      formKey: stepKey,
      path: err.path,
      message: err.message,
    }
    if (err.code !== undefined) entry.code = err.code
    return entry
  }

  // Per-key memoization for `allValues` and `allErrors`, so one field
  // edit on form A invalidates only form A's slot and a template reading
  // `wizard.allErrors.formB` stays cached. `statusCache` below is the
  // same shape.
  const valuesCache = new Map<FormKey, ComputedRef<unknown>>()
  function valuesFor(form: AnyForm): ComputedRef<unknown> {
    const cached = valuesCache.get(form.key)
    if (cached !== undefined) return cached
    const source = asStatusSource(form)
    const computedValues = computed(() => source.values)
    valuesCache.set(form.key, computedValues)
    return computedValues
  }

  const errorsCache = new Map<FormKey, ComputedRef<readonly WizardAggregateError[]>>()
  function errorsFor(form: AnyForm): ComputedRef<readonly WizardAggregateError[]> {
    const cached = errorsCache.get(form.key)
    if (cached !== undefined) return cached
    const source = asStatusSource(form)
    const computedErrors = computed<readonly WizardAggregateError[]>(() => {
      if (!isFormReady(form.key)) return []
      const errors = source.meta?.errors ?? []
      const list: WizardAggregateError[] = []
      for (const err of errors) list.push(toWizardAggregateError(err, form.key))
      return list
    })
    errorsCache.set(form.key, computedErrors)
    return computedErrors
  }

  // Identity-stable Proxy surfaces over the per-key caches. `get` and
  // `getOwnPropertyDescriptor` delegate to the per-key ComputedRef, so a
  // read tracks only the form it targets; `ownKeys` and `has` go through
  // `formsRecord`, so iteration order matches the compiled step list.
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

  const allErrors = new Proxy({} as Record<FormKey, readonly WizardAggregateError[]>, {
    get(_, key: string | symbol): readonly WizardAggregateError[] | undefined {
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
  }) as Readonly<Record<FormKey, readonly WizardAggregateError[]>>

  // --- Gates (hard prerequisites; drive the member-form freeze) ---------
  //
  // A `gate()` seals every step after it until the gate CLEARS, and
  // clearance is submission-triggered: a member form's clean submit, or
  // a seeded-valid form gate settling at mount. Never a live value edit.
  // That intent-versus-confirmation split is the whole point, since
  // keying on a leading value signal would let a downstream step collect
  // data before the prerequisite was confirmed. Gate PRESENCE stays
  // reactive, because a function slot may add or drop one, while
  // clearance is a LATCH, so a checkbox toggle can never open the rail.
  //
  // Two derived sets feed the shared spine:
  //   - navLockSet: steps strictly after the first UNCLEARED gate. Drives
  //     the `commitActiveKey` redirect and `statuses[key].locked`.
  //   - freezeSet: navLockSet plus each cleared gate's own key. Drives
  //     the member-form `externalLock`, so a cleared gate is frozen but
  //     navigable, a read-only review with no withdrawal path, and
  //     everything downstream stays frozen until its own gate clears.
  //     Being at the data layer is what makes it bypass-proof: a deep
  //     link or a back/forward cannot reach around it the way they reach
  //     around a navigation guard.

  // Could this wizard ever gate? A top-level gate marker, or a function
  // or lazy slot that might resolve to one. A plain form / string wizard
  // allocates no gate watchers at all.
  const mightGate = rawSteps.some(
    (slot) => isGateMarker(slot) || isLazyMarker(slot) || typeof slot === 'function'
  )

  // Cleared gates, latched. Reactive so `navLockSet` and `freezeSet`
  // recompute on an add. Exactly four things move it: a `defaultStatuses`
  // gate seed, a member form's clean submit, `relock()` and `reset()`. A
  // value going valid is not among them.
  const clearedGates = reactive(new Set<FormKey>())

  // Subscribe each gate form to its clean-submit signal, the
  // authoritative confirmation, and drop subscriptions for gates that
  // left the compiled list. Idempotent, driven by the reconcile watch
  // below plus one init pass. Clearance is established here or by the
  // `defaultStatuses` seed, never inferred from live validity.
  const gateSubs = new Map<FormKey, () => void>()
  function reconcileGates(): void {
    const gateKeys = new Set<FormKey>()
    for (const step of compiledSteps.value) if (step.isGate) gateKeys.add(step.key)
    for (const key of gateKeys) {
      if (!gateSubs.has(key)) {
        const store = registry.forms.get(key)
        if (store !== undefined) {
          gateSubs.set(
            key,
            store.onSubmitSuccess(() => {
              clearedGates.add(key)
            })
          )
        }
      }
    }
    for (const [key, unsub] of gateSubs) {
      if (!gateKeys.has(key)) {
        unsub()
        gateSubs.delete(key)
      }
    }
  }

  // Gate positions in compile order (reactive presence).
  const gatePositions = computed<readonly FormKey[]>(() =>
    compiledSteps.value.filter((step) => step.isGate).map((step) => step.key)
  )

  // Steps strictly after the first uncleared gate. The gate itself is
  // never nav-locked: reaching it is how it gets cleared.
  const navLockSet = computed<ReadonlySet<FormKey>>(() => {
    const out = new Set<FormKey>()
    let sealed = false
    for (const step of compiledSteps.value) {
      if (sealed) {
        out.add(step.key)
        continue
      }
      if (step.isGate && !clearedGates.has(step.key)) sealed = true
    }
    return out.size === 0 ? EMPTY_LOCK_SET : out
  })

  // Nav-locked steps plus each cleared gate's own key. A cleared gate is
  // navigable but frozen, a read-only review, so this is a superset of
  // the nav-lock set.
  const freezeSet = computed<ReadonlySet<FormKey>>(() => {
    const out = new Set<FormKey>(navLockSet.value)
    for (const key of gatePositions.value) if (clearedGates.has(key)) out.add(key)
    return out.size === 0 ? EMPTY_LOCK_SET : out
  })

  // The furthest step reachable from the start without crossing a gate.
  // A nav-locked target redirects here, so a deep link past an uncleared
  // gate lands on the gate. `undefined` only when the very first step is
  // nav-locked, which is pathological; a caller then leaves the pin.
  function lastReachableKey(): FormKey | undefined {
    const list = compiledSteps.value
    const locked = navLockSet.value
    let last: FormKey | undefined
    for (const step of list) {
      if (locked.has(step.key)) break
      last = step.key
    }
    return last
  }

  // Where a navigation to `target` actually lands. A reachable target
  // lands as-is; a nav-locked one redirects to `lastReachableKey`, but
  // only once that gate has resolved its defaults. Bouncing onto a
  // still-hydrating gate would flicker if it settled to reachable a tick
  // later, so while the gate is pending the pin stays on the target,
  // which is frozen and therefore safe, and the corrector performs the
  // bounce once readiness settles.
  function resolveLandingKey(target: FormKey): FormKey {
    if (!navLockSet.value.has(target)) return target
    const redirect = lastReachableKey()
    if (redirect === undefined) return target
    if (!isFormReady(redirect)) return target
    return redirect
  }

  // The SOLE writer of `activeKey.value`. Every navigation path routes
  // its target through here, so a nav-locked step can never quietly
  // become the active step, subject to the readiness defer in
  // `resolveLandingKey`. It stays side-effect-minimal: callers keep their
  // own `visited` and activation bookkeeping and read the returned
  // landing key, so each records where navigation ENDED UP rather than
  // where it was aimed. An empty-string clear passes through. Hoisted so
  // the forward-continuity watch above can route through it; every caller
  // runs after `navLockSet` is live.
  function commitActiveKey(target: FormKey): FormKey {
    const landing = target === '' ? '' : resolveLandingKey(target)
    if (activeKey.value !== landing) activeKey.value = landing
    return landing
  }

  if (mightGate) {
    // The signature fires when the gate set changes or a gate's store
    // registers, which are exactly the moments to resubscribe.
    // `immediate` runs the init pass, so subscriptions are live before
    // the initial landing below.
    watch(
      () => {
        const parts: string[] = []
        for (const step of compiledSteps.value) {
          if (!step.isGate) continue
          const store = registry.forms.get(step.key)
          parts.push(`${step.key}:${store !== undefined ? 1 : 0}`)
        }
        return parts.join('|')
      },
      reconcileGates,
      { immediate: true }
    )

    // Drive each member store's `externalLock` from `freezeSet`. A key
    // entering freezes its form; a key leaving releases it, whether
    // because its gate cleared and it is no longer downstream or because
    // the step dropped out. `previouslyFrozen` holds what the last pass
    // froze, so a departed key is actively reset rather than stranded.
    let previouslyFrozen: FormKey[] = []
    watchEffect(() => {
      const frozen = freezeSet.value
      for (const key of previouslyFrozen) {
        if (!frozen.has(key)) {
          const store = registry.forms.get(key)
          if (store !== undefined) store.externalLock.value = false
        }
      }
      for (const key of frozen) {
        // `registry.forms` is reactive, so a member store that registers
        // later re-triggers this effect and picks up its freeze.
        const store = registry.forms.get(key)
        if (store !== undefined) store.externalLock.value = true
      }
      previouslyFrozen = [...frozen]
    })

    if (getCurrentScope() !== undefined) {
      onScopeDispose(() => {
        // Release every still-frozen member and drop gate subscriptions,
        // so a form that outlives the wizard through a shared key or a
        // KeepAlive is not stranded frozen. An already-evicted store is
        // skipped.
        for (const key of previouslyFrozen) {
          const store = registry.forms.get(key)
          if (store !== undefined) store.externalLock.value = false
        }
        for (const unsub of gateSubs.values()) unsub()
        gateSubs.clear()
      })
    }
  }

  // --- Statuses proxy + seed --------------------------------------------

  // Latch any key seeded `gate: 'cleared'` that compiles to a live gate.
  // This is the ONLY seed path to clearance, since nothing is inferred
  // from validity, and it is one-shot and explicit, so it can never open
  // a gate on an in-session signal. A seed for a non-gate key is ignored
  // here; the dev warn below still flags one matching no step at all.
  function applyGateSeed(map: Record<string, FormStatusSeed> | undefined): void {
    if (map === undefined || !mightGate) return
    const gates = gatePositions.value
    for (const key of Object.keys(map)) {
      if (map[key]?.gate === 'cleared' && gates.includes(key)) clearedGates.add(key)
    }
  }

  const seedRef = ref<Record<string, FormStatusSeed> | undefined>(undefined)
  const seedInput = options.defaultStatuses
  if (seedInput !== undefined) {
    const resolved = resolveTrichotomy(seedInput)
    if (resolved.kind === 'sync') {
      seedRef.value = resolved.value
      applyGateSeed(resolved.value)
    } else {
      const eager = resolved.factory()
      if (eager instanceof Promise) {
        void eager.then((value) => {
          seedRef.value = value
          applyGateSeed(value)
        })
      } else {
        seedRef.value = eager
        applyGateSeed(eager)
      }
    }
  }

  // Extended lazily as new step keys appear through function-slot
  // resolution. Keying the cache is what keeps each form's computed
  // identity stable across re-evaluations of `compiledSteps`.
  const statusCache = new Map<FormKey, ComputedRef<FormStatus>>()

  function statusFor(form: AnyForm): ComputedRef<FormStatus> {
    const cached = statusCache.get(form.key)
    if (cached !== undefined) return cached
    const source = asStatusSource(form)
    const computedStatus = computed<FormStatus>(() => {
      // Both overlay whatever base status the readiness trichotomy below
      // resolves to. `locked` means sealed behind an earlier uncleared
      // gate; `gate` is this step's OWN prerequisite role, null unless it
      // compiles to a `gate()`. On the common unlocked and ungated path
      // the constants pass through untouched, so their identity
      // survives.
      const locked = navLockSet.value.has(form.key)
      let gate: FormStatus['gate'] = null
      if (gatePositions.value.includes(form.key)) {
        gate = clearedGates.has(form.key) ? 'cleared' : 'uncleared'
      }
      if (isFormReady(form.key)) {
        const meta = source.meta
        if (meta !== undefined && meta !== null) {
          return {
            valid: meta.valid,
            dirty: meta.dirty,
            submitted: meta.submitted,
            errorCount: meta.errorCount,
            locked,
            gate,
          }
        }
      }
      // A noop surfaces as always-valid even before its trivial schema
      // settle has registered. Noop schemas resolve synchronously, so
      // this is mostly defensive, but it keeps the status surface stable
      // for a string-slot key at t=0. A string slot can itself be a gate
      // (`gate('terms')`), so the overlay applies here too.
      if (noopForms.has(form.key)) {
        return locked || gate !== null ? { ...NOOP_VALID_STATUS, locked, gate } : NOOP_VALID_STATUS
      }
      const seed = seedRef.value?.[form.key]
      if (seed !== undefined) return { ...PENDING_STATUS, ...seed, locked, gate }
      return locked || gate !== null ? { ...PENDING_STATUS, locked, gate } : PENDING_STATUS
    })
    statusCache.set(form.key, computedStatus)
    return computedStatus
  }

  // Wrapping the cache in a Proxy is what lets `wizard.statuses` read
  // each key's computed lazily, including a key that appeared only
  // through function-slot resolution. The statuses-proxy underneath
  // expects a static record, so it is handed a live one whose `get`
  // delegates to `statusFor`.
  const statusesRecord = new Proxy({} as Record<FormKey, ComputedRef<FormStatus>>, {
    get(_, key: string | symbol): ComputedRef<FormStatus> | undefined {
      if (typeof key !== 'string') return undefined
      const form = formsRecord.value[key]
      if (form === undefined) {
        // Honour a seeded key for a form not yet visible in the compiled
        // list, such as one behind an unresolved function slot, so a
        // consumer can read a stable status for a key it knows about.
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
  // The default restore takes the first defined value of two: the
  // injected Nuxt-side resolver, which reads `?step=<key>` through
  // `useRoute()` in the module's runtime plugin, then `window.location`'s
  // search param mirrored through a ref that updates on popstate.
  //
  // The default persist writes back through `core/wizard-history.ts`. The
  // handle is built only when the consumer has disabled neither `restore`
  // nor `persist`, so an embed that opts out, or passes its own handlers,
  // never touches the DOM History API.
  const wantsDefaultUrlSync = options.restore !== false || options.persist !== false
  const historyHandle = wantsDefaultUrlSync
    ? createWizardHistory(DEFAULT_STEP_PARAM)
    : NOOP_WIZARD_HISTORY
  const injectedResolver = inject(kAttaformWizardActiveStepResolver, null)

  // `historyHandle.subscribe` fires the callback on popstate. The initial
  // value is whatever the URL holds at setup time: the server's URL
  // through the resolver under SSR, the window URL on the client.
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
            // An absent or unknown `?step=` resolves to the first step,
            // so a bare `/wizard` is the same EFFECTIVE page as
            // `?step=<first>`. Writing the step already effectively on
            // screen is a canonicalization rather than a navigation, so
            // it replaces in place: Back never lands on a dead entry
            // showing the same step, and the Forward stack survives a
            // Back round-trip. A genuine step change pushes.
            const current = historyHandle.read()
            const effectiveCurrent =
              current !== undefined && isCompiledKey(current) ? current : firstKey()
            if (state.step === effectiveCurrent) historyHandle.replace(state.step)
            else historyHandle.push(state.step)
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
    // Routing the initial pin through the funnel is what makes a deep
    // link into a gated step land on the gate, or defer to the corrector
    // while the gate hydrates, rather than open a locked step.
    const landing = commitActiveKey(initialKey)
    visited.value = [landing]
  }
  // On the degenerate path `activeKey` stays `''`, `visited` stays `[]`,
  // and the downstream getters surface `undefined`. The handle is still
  // constructable and the surrounding app keeps rendering.

  // --- SSR prefetch coordination ---------------------------------------
  //
  // On the server, mark the initial step's form for prefetch, so its
  // async `defaultValues` resolves inside `onServerPrefetch`, and skip
  // every other compiled step explicitly, so a stray transform mark
  // cannot fire a non-current step's factory.
  if (registry.ssr) {
    for (const step of compiledSteps.value) {
      if (step.key === initialKey) {
        registry.enqueuePrefetch(step.key)
      } else {
        registry.skipPrefetch(step.key)
      }
    }
  }

  // Activate every compiled step's form on the client. Idempotent:
  // `activate()` resolves immediately for a form with no async work, and
  // the registry's per-store hydration latch keeps the factory
  // single-shot across repeat calls. Activating all of them is a
  // CLIENT-side contract; the server keeps the prefetch coordination
  // above, where only the initial step's factory resolves.
  if (!registry.ssr) {
    for (const step of compiledSteps.value) {
      const source = asSubmissionSource(step.form)
      if (typeof source.activate === 'function') void source.activate()
    }
  }

  // --- Reactive restore / persist watchers -----------------------------
  //
  // How the loop breaks: the restore side watches what the `restore`
  // lambda returns, its own tracked reads deciding the dep set, and
  // applies only when that value MOVES and differs from the active step.
  // The persist side diffs against `lastPersisted`. `activeKey` is
  // deliberately never read inside the restore watch's getter, which
  // would re-fire restore on every internal navigation and revert it
  // before the persist write reached `urlMirror` on its own pass.
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
        const landing = commitActiveKey(step)
        if (!visited.value.includes(landing)) visited.value.push(landing)
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
        // Keeps the mirror in sync so the default restore lambda sees the
        // persisted value on its next read. The restore watch diffs it
        // against `activeKey` and bails when they agree, closing the loop
        // in one round.
        urlMirror.value = next
      }
    )
    // Replace the URL once at construction so a fresh load reflects the
    // active step; it is idempotent when the URL already named the right
    // key, the watcher's diff owning steady state. The `initialKey`
    // guard covers the degenerate path, where there is no step to
    // persist.
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
  // Whatever the most recent `wizard.handleSubmit` callback, or its
  // `onError`, threw or rejected with, coerced to a real `Error`. Same
  // contract as `form.meta.submitError`: cleared at submit entry and
  // parked here rather than re-thrown, so binding the handler to
  // `@submit` never manufactures a `window` unhandledrejection.
  const submitError = ref<Error | null>(null)
  // A monotonic latch: true from the first `handleSubmit` that resolves
  // without throwing and leaves no errors on any step, and true through
  // every later edit or invalidation. Only `reset()` flips it back, a new
  // run being a new history. Separate accounting from `complete`, which
  // is forward-looking and tracks current validity.
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
    const landing = commitActiveKey(key)
    if (!visited.value.includes(landing)) visited.value.push(landing)
    if (options?.silent === true) {
      lastPersisted = landing
    }
    const list = compiledSteps.value
    for (const step of list) {
      if (step.key === landing) {
        activateForm(step.form)
        return
      }
    }
  }

  function recordDeparture(key: FormKey): void {
    const store = registry.forms.get(key)
    if (store !== undefined) store.departAttempts.value += 1
  }

  // Record the departure and move the pin one compiled position on.
  // Shared by the public `next()` and by `tryNext()`'s post-submit
  // advance, which is what keeps `tryNext` out of the gate-delegating
  // `next()`, where it would loop on a gate step.
  function advanceOne(): void {
    const list = compiledSteps.value
    const idx = activeIndex.value
    if (idx < 0 || idx >= list.length - 1) return
    recordDeparture(activeKey.value)
    const target = list[idx + 1] as CompiledStep
    moveTo(target.key)
  }

  // Ride an in-flight submit rather than firing a second one.
  //
  // A submit already running on the active step's form means the caller
  // is either inside that form's own submit callback, the documented
  // `activeForm.handleSubmit(() => wizard.next())` composition, or racing
  // an autosave. Submitting again would meet `handleSubmit`'s re-entry
  // guard, come back swallowed, and read as not clean, losing the advance
  // with nothing reported anywhere. Advancing when the in-flight submit
  // resolves clean applies the same condition `tryNext` advances on, and
  // costs the consumer's server no second POST.
  //
  // Pinned TWICE so a stale deferral can never move the pin on its own:
  // to the submission it rode, where an unchanged `submissionAttempts`
  // proves it is still that submission (the count is bumped in that
  // submission's `finally`, after the success signal), and to the step it
  // was requested from. One deferral at a time; a fresh request replaces
  // it.
  let cancelDeferredAdvance: (() => void) | null = null
  function advanceWhenInFlightSubmitLands(store: FormStore<GenericForm>, key: FormKey): void {
    cancelDeferredAdvance?.()
    const attemptsAtRequest = store.submissionAttempts.value
    const off = store.onSubmitSuccess(() => {
      off()
      cancelDeferredAdvance = null
      if (store.submissionAttempts.value !== attemptsAtRequest) return
      if (activeKey.value !== key) return
      advanceOne()
    })
    cancelDeferredAdvance = off
  }

  // The active step's store when it has a submit in flight. Reading
  // `activeSubmissions` rather than `submitting` matches
  // `handleSubmit`'s own re-entry guard exactly, so the two can never
  // disagree about whether a second submit would be swallowed.
  function inFlightActiveStore(): FormStore<GenericForm> | undefined {
    const store = registry.forms.get(activeKey.value)
    if (store === undefined || store.activeSubmissions.value === 0) return undefined
    return store
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
    // A gate step advances only through its own submit, so a bare
    // `next()` on an UNCLEARED gate behaves like `tryNext()` and wiring
    // Next straight to `next()` can never skip the confirmation.
    //
    // Two carve-outs, both so that one user action costs exactly one
    // submission of the member form:
    //
    //  - An already-CLEARED gate has nothing left to confirm, so `next()`
    //    is plain navigation again. Re-submitting it would run the whole
    //    lifecycle a second time, `submissionAttempts`,
    //    `onSubmitSuccess` and every consumer subscriber, for an answer
    //    the latch already holds.
    //  - A submit in flight on this form IS the confirmation this call is
    //    waiting for. Ride it.
    const active = list[idx]
    if (active !== undefined && active.isGate && !clearedGates.has(active.key)) {
      const inFlight = inFlightActiveStore()
      if (inFlight !== undefined) {
        advanceWhenInFlightSubmitLands(inFlight, activeKey.value)
        return
      }
      await tryNext()
      return
    }
    advanceOne()
  }

  // Submit the active step and advance once that submit resolves clean.
  // Wire it straight to a control, `@click="wizard.tryNext()"`, with no
  // captured handler. Invalid input keeps the pin put under the form's
  // own reveal, first error focused and display state advanced; a clean
  // submit advances.
  //
  // The advance runs AFTER the submit settles rather than inside its
  // callback, so a `gate()` on the active step has already fired its
  // clean-submit signal by the time the pin moves, and one call both
  // clears the gate and advances. Resolves to whether the pin moved, so
  // `if (await wizard.tryNext())` can branch on it. Pure navigation stays
  // `next()` and the whole-wizard submit stays `handleSubmit`. No-ops to
  // `false` on a degenerate or final-step wizard, as `next()` does.
  async function tryNext(): Promise<boolean> {
    if (submitting.value) {
      if (__DEV__) {
        console.warn(`[attaform] wizard.tryNext(): blocked while a submit is in flight.`)
      }
      return false
    }
    const list = compiledSteps.value
    if (list.length === 0) {
      if (__DEV__) {
        console.warn(`[attaform] wizard.tryNext(): wizard has no compiled steps; no-op.`)
      }
      return false
    }
    const idx = activeIndex.value
    if (idx < 0 || idx >= list.length - 1) {
      if (__DEV__) {
        console.warn(
          `[attaform] wizard.tryNext(): already on the final step ("${activeKey.value}"). Use wizard.handleSubmit() to submit.`
        )
      }
      return false
    }
    const form = activeForm.value
    if (form === undefined) return false
    const before = activeKey.value
    // A submit already in flight IS the submit this call would start.
    // Ride it rather than firing a second one for the re-entry guard to
    // swallow. The pin has not moved by the time this resolves, so the
    // answer is `false`; the advance lands when that submit does.
    const inFlight = inFlightActiveStore()
    if (inFlight !== undefined) {
      advanceWhenInFlightSubmitLands(inFlight, before)
      return false
    }
    // Confirm the submit ran clean, THEN advance. A `gate()` on the
    // active step clears only after its submit callback resolves, so
    // advancing from inside that callback would read pre-clear lock state
    // and refuse. Marking success in the callback and advancing after it
    // lets the gate clear on its own completion. Through `advanceOne()`,
    // not `next()`, so a gate step cannot loop back into `tryNext`.
    let ranClean = false
    await asHandleSubmitSource(form).handleSubmit(() => {
      ranClean = true
    })()
    // Pinned to the step this call started from: a deferred advance
    // queued by a concurrent `next()` or `tryNext()` may already have
    // moved the pin off it, and advancing again would skip a step.
    if (ranClean && activeKey.value === before) advanceOne()
    return activeKey.value !== before
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
    if (__DEV__ && navLockSet.value.has(key)) {
      console.warn(
        `[attaform] wizard.goTo("${key}"): that step sits behind an uncleared gate(); the navigation was refused. Clear the gate before navigating here.`
      )
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
            path: [],
            message: `Form '${form.key}' failed to activate: ${activationFailure}`,
            code: AttaformErrorCode.ActivationFailed,
          },
        ],
        formKey: form.key,
      }
    }
    return full.parse()
  }

  function collectErrors(
    results: ReadonlyMap<FormKey, ValidationResponse<unknown>>
  ): WizardAggregateError[] {
    const out: WizardAggregateError[] = []
    for (const step of compiledSteps.value) {
      const processed = results.get(step.key)
      if (processed === undefined || processed.success === true) continue
      for (const err of processed.errors) out.push(toWizardAggregateError(err, step.key))
    }
    return out
  }

  // The post-callback mirror of `collectErrors` (#438): after a clean
  // validation pass, a callback that called `setErrors` on a step left
  // those errors in the user layer. Scoped to the keys the submit
  // processed, which is every step since `handleSubmit` is whole-wizard,
  // matching the entry-clear scope.
  function collectCallbackErrors(keys: Iterable<FormKey>): WizardAggregateError[] {
    const out: WizardAggregateError[] = []
    for (const key of keys) {
      const store = registry.forms.get(key)
      if (store === undefined) continue
      for (const cell of store.errorCells.values()) {
        for (const err of cell.user) out.push(toWizardAggregateError(err, key))
      }
    }
    return out
  }

  // An uncleared gate blocks whole-wizard completion even when its own
  // form and every downstream form validates, because a gate clears only
  // on a member form's clean submit, never on a valid-by-default
  // downstream form. So a finish attempt that jumps an unconfirmed gate
  // takes the same failure path a validation error takes: focus lands on
  // the gate and `done` never latches.
  function collectUnclearedGateErrors(): WizardAggregateError[] {
    const out: WizardAggregateError[] = []
    for (const step of compiledSteps.value) {
      if (step.isGate && !clearedGates.has(step.key)) {
        out.push({
          formKey: step.key,
          path: [],
          message: `Step "${step.key}" is a gate that has not been cleared. Submit it to continue.`,
          code: AttaformErrorCode.GateNotCleared,
        })
      }
    }
    return out
  }

  // Move to the first failed step and run its invalid-submit focus nudge.
  // Shared by the validation-failure and post-callback error paths so
  // both honour `options.focusFirstError` identically, and run BEFORE
  // onError so the consumer can override the focus.
  async function focusFirstWizardError(errors: readonly WizardAggregateError[]): Promise<void> {
    if (options.focusFirstError === false) return
    const firstFailedKey = errors[0]?.formKey
    if (firstFailedKey === undefined || !isCompiledKey(firstFailedKey)) return
    moveTo(firstFailedKey)
    await nextTick()
    const failedForm = formsRecord.value[firstFailedKey]
    if (failedForm === undefined) return
    const failedSource = asSubmissionSource(failedForm)
    if (typeof failedSource.applyInvalidSubmitPolicy === 'function') {
      failedSource.applyInvalidSubmitPolicy()
    }
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
      submitError.value = null
      try {
        const currentKey = activeKey.value
        // Positional only, surfaced as `ctx.isFinal`. Nothing branches on
        // it: `handleSubmit` processes the whole wizard from any step.
        const final = isFinalStep.value
        const list = compiledSteps.value
        const results = new Map<FormKey, ValidationResponse<unknown>>()

        // Every step, whichever one fired the submit: `handleSubmit`
        // always submits the whole wizard. Gating an advance on one step's
        // validity is the `activeForm.handleSubmit(() => wizard.next())`
        // composition, which runs on the form side. In parallel, so
        // latency is the slowest form rather than the sum of them.
        await Promise.all(
          list.map(async (step) => {
            // As in `form.handleSubmit`, a fresh attempt starts each form
            // from a clean user-error slate. Every step is processed, so
            // every step is cleared.
            registry.forms.get(step.key)?.clearUserErrors()
            const result = await processOne(step.form)
            results.set(step.key, result)
          })
        )

        // Bump per-form `submissionAttempts` for every form just
        // processed, noops included. The wizard-level counter bumps once
        // per invocation, the two being separate accounting.
        for (const key of results.keys()) {
          const store = registry.forms.get(key)
          if (store !== undefined) {
            store.submissionAttempts.value += 1
            // As in the form's own `handleSubmit`: a wizard submit is an
            // explicit reveal, so abort in-flight per-field validation,
            // clearing `fieldValidatingSince`, and drop the anti-flash
            // display state. Otherwise a leftover show-delay hold or
            // min-visible spinner timer outlives the submit and delays
            // the verdict.
            store.cancelFieldValidation()
            store.displayEngine.clear()
          }
        }
        submissionAttempts.value += 1

        const errors = collectErrors(results)
        // An uncleared gate blocks completion even on an all-valid pass,
        // so folding it into the blocking set is what stops a whole-wizard
        // finish routing around an unconfirmed prerequisite. Validation
        // errors sort first, so focus reaches a genuine field error before
        // the gate.
        const gateErrors = mightGate ? collectUnclearedGateErrors() : []
        const blocking = gateErrors.length > 0 ? [...errors, ...gateErrors] : errors
        if (blocking.length === 0) {
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
          // Parity with `form.handleSubmit` (#438): a callback that left
          // errors on a processed step, the documented `setErrors(...);
          // return` server-rejection path, has NOT succeeded. The
          // entry-clear above means any user error present now came from
          // this callback. Same failure path as a validation failure:
          // focus the first error, fire onError, return without latching
          // `done`.
          const callbackErrors = collectCallbackErrors(results.keys())
          if (callbackErrors.length > 0) {
            await focusFirstWizardError(callbackErrors)
            if (onError !== undefined) {
              try {
                await onError(callbackErrors)
              } catch (cause) {
                throw new SubmitErrorHandlerError('User-provided onError threw', { cause })
              }
            }
            return
          }
          // Every step validated and the callback left no errors. Latch
          // `done` and never move the pin; advancing lives in the
          // gated-advance composition.
          done.value = true
        } else {
          // BEFORE onError, as in `form.handleSubmit`, so the consumer's
          // onError can override the focus and a THROWING onError still
          // leaves the first error focused rather than stranding the user.
          // `blocking` carries the validation errors plus any
          // uncleared-gate error.
          await focusFirstWizardError(blocking)
          if (onError !== undefined) {
            try {
              await onError(blocking)
            } catch (cause) {
              throw new SubmitErrorHandlerError('User-provided onError threw', { cause })
            }
          }
        }
      } catch (err) {
        // Park the throw on `submitError`, coerced to a real Error, and
        // never re-throw. The handler is bound to DOM events, so a
        // rejected promise would surface as a `window` unhandledrejection,
        // a phantom crash for an already-handled failure. The `finally`
        // still resets `submitting`, so navigation resumes and the button
        // is never stranded.
        submitError.value = toError(err)
      } finally {
        submitting.value = false
      }
    }
  }

  // --- Reset ------------------------------------------------------------

  function reset(): void {
    submissionAttempts.value = 0
    done.value = false
    submitError.value = null
    // Clear the latch, then re-apply the `defaultStatuses` seed after the
    // per-form resets below, so a seeded-cleared gate returns to its
    // seeded clearance exactly as those resets restore each form's
    // `defaultValues`. Clearance is never re-inferred from validity: only
    // the explicit seed and a fresh clean submit move it.
    if (mightGate) {
      clearedGates.clear()
    }
    // Re-fires every `lazy()` slot's memo on the next compile pass.
    // Without it an expensive one-shot lookup stays glued to its first
    // resolution across a reboot, and `reset()` is a true reboot rather
    // than a soft rewind.
    lazyEpoch.value += 1
    for (const step of compiledSteps.value) {
      const full = asSubmissionSource(step.form)
      if (typeof full.reset === 'function') full.reset()
    }
    if (mightGate) {
      reconcileGates()
      applyGateSeed(seedRef.value)
    }
    const firstStep = compiledSteps.value[0]
    if (firstStep !== undefined) {
      const landing = commitActiveKey(firstStep.key)
      visited.value = [landing]
      if (persistCallback !== undefined) {
        lastPersisted = landing
        persistCallback({ step: landing })
      }
    }
  }

  // Re-seal a cleared gate by key, contingent on `commit`. As with a
  // gate's clearing submit, the transition is the server's to confirm:
  // await `commit`, your server-side revoke, and re-seal only if it
  // resolves clean, so the gate reflects server-confirmed truth in BOTH
  // directions. A thrown `commit` leaves the gate cleared and resolves
  // `false`.
  //
  // Seal-only, and deliberately so. `clearedGates.delete` re-locks
  // downstream through `navLockSet` and `freezeSet`, and there is no
  // imperative CLEAR counterpart, so `relock` cannot be turned into the
  // leading-signal foot-gun `gate()` exists to prevent. `commit` is
  // required; pass `() => {}` for a deliberate client-only re-seal. Never
  // rejects, so a fire-and-forget relock cannot surface an
  // unhandledrejection. A key that is not a live gate resolves `false`
  // with a dev warn and never reaches `commit`.
  async function relock(key: FormKey, commit: () => void | Promise<void>): Promise<boolean> {
    if (!mightGate || !gatePositions.value.includes(key)) {
      if (__DEV__) {
        console.warn(
          `[attaform] useWizard.relock(${JSON.stringify(key)}): no gate at that key; nothing to re-lock.`
        )
      }
      return false
    }
    try {
      await commit()
    } catch (err) {
      if (__DEV__) {
        console.warn(
          `[attaform] useWizard.relock(${JSON.stringify(key)}): commit threw, so the gate was not re-sealed.`,
          err
        )
      }
      return false
    }
    clearedGates.delete(key)
    return true
  }

  // `commitActiveKey` refuses a nav-locked target at the write site, but
  // the active step can still END UP nav-locked three ways: its gate was
  // mid-hydration at commit time and the readiness defer kept the pin on
  // it, a gate dropped its cleared state, or a forward-continuity slide
  // landed on it. So whenever the active step is nav-locked and the gate
  // behind it has settled, bounce to the gate. It sits after `moveTo` and
  // `visited` so the bounce records its landing like any navigation.
  if (mightGate) {
    watchEffect(() => {
      const key = activeKey.value
      if (key === '' || !navLockSet.value.has(key)) return
      const redirect = lastReachableKey()
      if (redirect === undefined || redirect === key || !isFormReady(redirect)) return
      moveTo(redirect)
    })
  }

  // --- Lifecycle hooks --------------------------------------------------

  if (getCurrentScope() !== undefined) {
    onScopeDispose(() => {
      historyHandle.dispose()
      lazyNoopScope.stop()
      cancelDeferredAdvance?.()
    })
  }

  // --- Handle assembly --------------------------------------------------

  const explicitKey = options.key
  const wizardKey = resolveWizardKey(explicitKey)
  // The handle's parameterized return narrows `currentStep` and
  // `activeForm` to non-undefined when the steps tuple is statically
  // safe; see `StaticallyNonEmpty` in `types/types-wizard.ts`. The
  // runtime cannot observe the tuple shape, so the active-position
  // getters cast through `CurrentStepOf<S>` and `ActiveFormOf<S>`. The
  // cast is sound because a tuple passing that predicate holds only Form
  // and string slots, which keep their positions, so the compiled list is
  // guaranteed non-empty and the getters never reach the degenerate
  // branch.
  const handle: UseWizardReturnType<S> = {
    key: wizardKey,
    next,
    back,
    goTo,
    tryNext,
    handleSubmit,
    reset,
    relock,
    get currentStep(): CurrentStepOf<S> {
      return currentStep.value as CurrentStepOf<S>
    },
    get activeForm(): ActiveFormOf<S> {
      // The live facade built once above, so a handler captured at setup
      // retargets the current step on every call. `undefined` is
      // preserved for the degenerate wizard.
      return (activeForm.value === undefined ? undefined : activeFormFacade) as ActiveFormOf<S>
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
    get submitError(): Error | null {
      return submitError.value
    },
    get visited(): readonly FormKey[] {
      return visited.value
    },
  }

  // Registry registration + ambient provide --------------------------
  //
  // Every wizard lands in the registry, explicit key or synthetic, so SSR
  // hydration, DevTools labels and the consumer-counted lifetime all work
  // the same way. The collision warning fires only for a key the consumer
  // chose: two synthetic keys cannot collide, since `useId()` returns a
  // tree-position-stable distinct id in setup and the module-local
  // counter increments outside it.
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

  // An anonymous wizard fills the ambient slot for a descendant
  // `injectWizard()`; a keyed one stays registry-only, which keeps
  // explicit and ambient resolution disjoint, as on the form side.
  if (getCurrentInstance() !== null && explicitKey === undefined) {
    recordAmbientWizardProvide(registry.ssr)
    provide(kAttaformAncestorWizard, handle)
  }

  return handle
}

/**
 * Feeds the anonymous key when there is no Vue instance in scope, which
 * means tests and raw composable calls. It cannot collide with a
 * consumer key: the synthetic prefix lives inside the reserved `__atta:`
 * namespace, and `useAbstractForm` rejects consumer keys there. In setup
 * the wizard uses `useId()`, which is stable across SSR and hydration.
 */
let anonWizardCounter = 0

/**
 * Which parent instances have already run an anonymous-wizard ambient
 * provide. Dev only, `null` in production so the allocation tree-shakes
 * out. Exported so a no-key `injectWizard()` can walk the parent chain
 * and warn lazily when one parent registered more than one anonymous
 * `useWizard()`, Vue's `provide` being last-write-wins.
 * `ambientProvideHistory` is the form side of the same thing.
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
 * Resolve `options.key` into a concrete wizard key. An explicit key
 * passes through; an empty or nullish one is allocated under
 * `__atta:anon-wizard:`. Shaped after `resolveFormKey` in
 * `composables/use-abstract-form.ts`, so an anonymous wizard gets the
 * same SSR hydration story an anonymous form does.
 */
function resolveWizardKey(key: string | undefined): string {
  if (key !== undefined && key !== null && key !== '') return key
  if (getCurrentInstance() !== null) {
    return `${ANONYMOUS_WIZARD_KEY_PREFIX}${useId()}`
  }
  return `${ANONYMOUS_WIZARD_KEY_PREFIX}${anonWizardCounter++}`
}

/** Best-effort discriminator for the `AnyForm` arm of `StepSlot`. A form
 *  from `useForm` always carries a string `key`, so testing that and
 *  ruling out the other arms structurally keeps `normalizeSlot` readable
 *  without a `typeof` cascade over every slot. */
function isAnyForm(value: unknown): value is AnyForm {
  if (value === null || typeof value !== 'object') return false
  if (typeof (value as { key?: unknown }).key !== 'string') return false
  return true
}
