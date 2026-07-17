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

/** Status surfaced for noop forms (string-slot affordance steps). Noops
 *  carry no schema, no fields, and no error surface — they are always
 *  trivially valid, so the wizard's progress and complete computeds can
 *  treat string slots as "done by being there." */
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
  'meta' | 'values' | 'activate' | 'parse' | 'applyInvalidSubmitPolicy' | 'reset' | 'hydrateError'
>

/**
 * Internal compiled-step shape. Extends the public `CompiledStep` with
 * the `isGate` flag the gating spine reads (which position a `gate()`
 * wrapped). Kept off the public `CompiledStep` so `wizard.steps` stays a
 * clean `{ key, form }` surface; the flag is an implementation detail of
 * the lock derivation.
 */
type CompiledStepInternal = CompiledStep & { readonly isGate: boolean }

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
// Centers the `AnyForm → handleSubmit` coercion for the live `activeForm`
// facade. The slot type omits `handleSubmit`; at runtime every
// participating form carries it.
function asHandleSubmitSource(form: AnyForm): Pick<UseFormReturnType<GenericForm>, 'handleSubmit'> {
  return form as unknown as Pick<UseFormReturnType<GenericForm>, 'handleSubmit'>
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
 * `handleSubmit` validates the whole step list from any step and never
 * advances (gate advance with `activeForm.handleSubmit(() =>
 * wizard.next())`), and URL synchronization rides on `restore` /
 * `persist` callbacks that default to `?step=<key>`.
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
  // nested marker / nullish). String → noop conversion and nested-marker
  // unwrapping happen in `normalizeSlot`, OUTSIDE the computed, so
  // noop-construction and nested-resolution reactivity don't leak into
  // this slot's dep set (otherwise the form registry's initialization
  // writes would invalidate the cache on the very first compile pass).
  //
  // The memo is keyed by marker identity (not slot index) so a `lazy()`
  // nested inside a `gate()` — in either composition order — still
  // resolves through one stable cache. A WeakMap lets a dropped marker's
  // cache be collected with it.
  const lazyEpoch = ref(0)
  const lazyComputeds = new WeakMap<LazyMarker, ComputedRef<SlotResolution>>()

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

  /** Get (or lazily build) the memo computed for a `lazy()` marker,
   *  keyed by marker identity. See the `lazyComputeds` note above. */
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

  // Cap on how deep the slot normalizer will unwrap. gate/lazy/function
  // nesting is a handful of levels in any real wizard; the cap only
  // catches a pathological cycle (a resolver that returns itself).
  const MAX_SLOT_DEPTH = 32

  /**
   * Recursively resolve a single slot to a participating form plus
   * whether a `gate()` wrapped it anywhere on the way down, or
   * `undefined` to drop the slot from the compiled list.
   *
   * Each level unwraps one layer and recurses: a `gate()` records the
   * gate and descends into its inner slot; a `lazy()` reads its memo; a
   * function slot is called; a string desugars to its noop form; a form
   * bottoms out. So `gate()` and `lazy()` compose in either order, and a
   * function / lazy resolver may itself return a `gate()` wrapper. String
   * → noop conversion and nested-marker reads happen here (not inside a
   * lazy computed) to keep resolver dep sets clean.
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
    // A `null` / `undefined` slot (a literal absence, e.g. `cond ? form :
    // null`) drops out of the compiled list.
    if (slot === undefined || slot === null) return undefined
    // String slots build a noop on first reference (top-level strings are
    // pre-built at construction; the builder hits that cache). Authors
    // don't pre-declare affordance keys; the wizard handles new keys
    // uniformly.
    if (typeof slot === 'string') return { form: getOrBuildNoop(slot), gated }
    // `gate(step)`: mark the position gated and descend into the wrapped
    // slot. The gated flag rides through every further unwrap.
    if (isGateMarker(slot)) return normalizeSlot(slot.inner, ctx, true, depth + 1)
    // `lazy(fn)`: read through the marker-keyed memo, then normalize the
    // raw result (which may itself be a string / gate / lazy).
    if (isLazyMarker(slot)) return normalizeSlot(lazyComputedFor(slot).value, ctx, gated, depth + 1)
    // Eager function slot: call and normalize the result.
    if (typeof slot === 'function') {
      const result = (slot as (ctx: WizardCtx) => SlotResolution)(ctx)
      return normalizeSlot(result, ctx, gated, depth + 1)
    }
    if (isAnyForm(slot)) return { form: slot, gated }
    return undefined
  }

  // The compiled step list. Function slots re-evaluate on every read
  // of their reactive deps; lazy slots run through their own memoized
  // computed; string slots cache their noop forms; a `gate()` marks its
  // position and is transparent to the resolved form. The compile pass
  // itself has no `activeKey` dep — each function-slot body contributes
  // its own deps through `slotCtx.currentKey`'s getter, so navigation
  // only re-fires the slots that actually look at the active step.
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

  // `currentStep` and `activeForm` resolve through the same
  // `activeIndex`-aware lookup so they can never disagree on which
  // step the wizard is on. The forward-continuity watch below keeps
  // `activeKey` pointed at a live step, so in steady state
  // `activeIndex` is in range; the `list[0]` fallback here only covers
  // the sub-tick before that watch flushes, and the degenerate
  // empty-key case.
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

  // Forward-continuity guard. When the active step drops out of the
  // compiled list (a function or lazy slot that used to yield the active
  // form now returns nullish), re-point `activeKey` at the step that took
  // its place so the flow continues from there rather than snapping back
  // to the first step. Clamp to the new last when the dropped step was
  // last; an emptied wizard falls back to the degenerate empty key.
  // Re-pinning at the source keeps `activeIndex` / `currentStep` /
  // `activeForm` and index-based navigation consistent, instead of
  // leaving `activeKey` stranded on a dead key.
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

  // `wizard.activeForm` returns this single facade (when the wizard is
  // non-degenerate) on every read, so a handler captured once at setup
  // time stays correct as the wizard advances:
  //
  //   const onNext = wizard.activeForm.handleSubmit(() => wizard.next())
  //
  // `handleSubmit` is late-bound: the returned submit handler resolves
  // the active form when it RUNS, not when `.handleSubmit(...)` was
  // called, so `onNext` validates whichever step is current at click
  // time instead of pinning to step one. Every other access forwards to
  // the current form. Reach for `wizard.forms[key]` when you need a
  // specific step's raw handle. The Proxy target is inert: all behavior
  // comes from the traps, which read the reactive `activeForm` computed
  // at access time (so reactivity tracks through the stable identity)
  // and no-op safely when the wizard has no steps.
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
      // Force `configurable: true` so the Proxy invariant (a descriptor
      // reported for a key absent from the inert target must be
      // configurable) holds regardless of how the handle defines the key.
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
  function toWizardAggregateError(
    err: {
      readonly path: ReadonlyArray<string | number>
      readonly message: string
      readonly code?: string
      readonly formKey?: FormKey
    },
    fallbackKey: FormKey
  ): WizardAggregateError {
    const entry: { -readonly [P in keyof WizardAggregateError]: WizardAggregateError[P] } = {
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
  // A `gate()` seals every step positioned after it until the gate
  // CLEARS. Clearance is submission-triggered — a member form's clean
  // submit, or a seeded-valid form gate whose verdict settles at mount —
  // never a live value edit. That intent-vs-confirmation split is the
  // whole point of `gate()`: keying on a leading value signal lets a
  // downstream step collect data before the prerequisite is confirmed.
  // Gate PRESENCE stays reactive (a function slot may add / drop a gate),
  // clearance is a LATCH, so a checkbox toggle can never open the rail.
  //
  // Two derived sets feed the reused spine:
  //   - navLockSet: steps strictly after the first UNCLEARED gate. Drives
  //     the `commitActiveKey` redirect and `statuses[key].locked`.
  //   - freezeSet: navLockSet ∪ each cleared gate's own key. Drives Part
  //     1's `externalLock`, so a cleared gate is frozen-but-navigable
  //     (a read-only review, no withdrawal path) and everything
  //     downstream stays frozen until its gate clears. The freeze is
  //     bypass-proof: unlike a navigation guard, a deep link or
  //     back/forward cannot reach around the data-layer freeze.

  // Static "could this wizard ever gate?" flag: a top-level gate marker,
  // or a function / lazy slot that might resolve to one. A plain
  // form / string wizard allocates no gate watchers.
  const mightGate = rawSteps.some(
    (slot) => isGateMarker(slot) || isLazyMarker(slot) || typeof slot === 'function'
  )

  // Cleared gates, latched. A reactive Set (mirroring create-form-store's
  // reactive collections) so `navLockSet` / `freezeSet` recompute on an
  // add. Only mount-time seeding, a member form's clean submit, and
  // `reset()` ever move it.
  const clearedGates = reactive(new Set<FormKey>())

  // One-shot guard: a form gate's seeded-valid state is sampled once, the
  // first time its verdict settles, never re-sampled on a later live
  // edit — re-sampling would reintroduce the leading-signal foot-gun.
  const seededSampled = new Set<FormKey>()

  // A gate form's verdict is trustworthy once its defaults are resolved,
  // its first validation pass has completed, and nothing is in flight.
  // The common sync base-schema consent satisfies this synchronously at
  // construction; an async-validated gate settles a tick later and the
  // reconcile watch re-samples then.
  function isGateVerdictSettled(key: FormKey): boolean {
    const store = registry.forms.get(key)
    if (store === undefined) return false
    return (
      store.defaultsResolved.value === true &&
      store.firstValidationDone.value === true &&
      store.activeValidations.value === 0
    )
  }

  function isGateFormValid(key: FormKey): boolean {
    const form = formsRecord.value[key] ?? formsAccumulator.get(key)
    if (form === undefined) return false
    return asStatusSource(form).meta?.valid ?? false
  }

  // Seed a form gate as pre-cleared when its member form rehydrates
  // already valid (a persisted consent), so a seeded-valid gate renders
  // open from t=0. Affordance gates (noop forms, trivially valid) are
  // skipped — their clearance is an ephemeral acknowledgment, so they
  // re-prompt each session. Called only from `reconcileGates` (a watch
  // callback / init pass), so the validity read never sits in a reactive
  // scope and a live value edit can never trigger it.
  function sampleSeededGate(key: FormKey): void {
    if (seededSampled.has(key)) return
    if (noopForms.has(key)) return
    if (!isGateVerdictSettled(key)) return
    seededSampled.add(key)
    if (isGateFormValid(key)) clearedGates.add(key)
  }

  // Subscribe each gate form to its clean-submit signal (the
  // authoritative confirmation), sample any newly-settled form gate, and
  // drop subscriptions for gates that left the compiled list. Idempotent;
  // driven by the reconcile watch below plus one init pass.
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
      sampleSeededGate(key)
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
  // never nav-locked — you must be able to reach it to clear it.
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

  // Freeze set: nav-locked steps plus each cleared gate's own key. A
  // cleared gate is navigable but frozen (a read-only review), so the
  // freeze set is a superset of the nav-lock set.
  const freezeSet = computed<ReadonlySet<FormKey>>(() => {
    const out = new Set<FormKey>(navLockSet.value)
    for (const key of gatePositions.value) if (clearedGates.has(key)) out.add(key)
    return out.size === 0 ? EMPTY_LOCK_SET : out
  })

  // The furthest step reachable from the start without crossing a gate:
  // walk positionally and stop at the first nav-locked step. A nav-locked
  // target redirects here, so a deep link past an uncleared gate lands on
  // the gate. `undefined` only when the very first step is nav-locked
  // (pathological); callers then leave the pin where it is.
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

  // Resolve where a navigation to `target` actually lands. A reachable
  // target lands as-is. A nav-locked target redirects to the gate
  // (`lastReachableKey`), but only once that gate has resolved its
  // defaults: bouncing onto a still-hydrating gate would flicker if it
  // settles to "reachable" a tick later, so while the gate is pending the
  // pin stays on the (frozen, therefore safe) target and the corrector
  // performs the bounce once readiness settles.
  function resolveLandingKey(target: FormKey): FormKey {
    if (!navLockSet.value.has(target)) return target
    const redirect = lastReachableKey()
    if (redirect === undefined) return target
    if (!isFormReady(redirect)) return target
    return redirect
  }

  // Sole writer of `activeKey.value`. Every navigation path routes its
  // target through here so a nav-locked step can never silently become
  // the active step (subject to the readiness defer in
  // `resolveLandingKey`). Side-effect-minimal by design: callers keep
  // their own `visited` / activation bookkeeping and use the returned
  // landing key, so they record where navigation actually ended up rather
  // than where it was aimed. The empty-string clear (degenerate wizard)
  // passes through. A hoisted declaration so the forward-continuity watch
  // above can route through it; every caller invokes it after
  // `navLockSet` is live.
  function commitActiveKey(target: FormKey): FormKey {
    const landing = target === '' ? '' : resolveLandingKey(target)
    if (activeKey.value !== landing) activeKey.value = landing
    return landing
  }

  if (mightGate) {
    // Reconcile gate subscriptions + seeded-valid sampling. The signature
    // fires when the gate set changes, a gate's store registers, or a
    // gate form's verdict settles — exactly the moments to (re)subscribe
    // and (re)sample. Validity is read only inside `reconcileGates` (a
    // watch callback, a non-reactive scope), so a live value edit on a
    // gate form never clears it. `immediate` runs the init pass so a
    // sync seeded-valid gate is cleared before the initial landing below.
    watch(
      () => {
        const parts: string[] = []
        for (const step of compiledSteps.value) {
          if (!step.isGate) continue
          const store = registry.forms.get(step.key)
          const settled = store !== undefined && isGateVerdictSettled(step.key)
          parts.push(`${step.key}:${store !== undefined ? 1 : 0}:${settled ? 1 : 0}`)
        }
        return parts.join('|')
      },
      reconcileGates,
      { immediate: true }
    )

    // Drive Part 1's `externalLock` on each member store from
    // `freezeSet`. A key entering the set freezes its form; a key leaving
    // it (its gate cleared and it is no longer downstream, or the step
    // dropped out) releases it. `previouslyFrozen` tracks what we froze
    // last pass so a departed key is actively reset rather than stranded.
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
        // `registry.forms` is reactive, so a member store registered after
        // this first runs re-triggers the effect and picks up its freeze.
        const store = registry.forms.get(key)
        if (store !== undefined) store.externalLock.value = true
      }
      previouslyFrozen = [...frozen]
    })

    if (getCurrentScope() !== undefined) {
      onScopeDispose(() => {
        // Release every still-frozen member and drop gate subscriptions on
        // teardown so a form that outlives the wizard (shared key,
        // KeepAlive) is not stranded frozen. A store already evicted from
        // the registry is skipped.
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

  const seedRef = ref<Record<string, FormStatusSeed> | undefined>(undefined)
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
      // `locked` and `gate` are orthogonal to the readiness trichotomy
      // below: both overlay whatever base status this form resolves to.
      // `locked` = sealed behind an earlier uncleared gate; `gate` = this
      // step's OWN prerequisite role (null unless it compiles to a
      // `gate()`). Constants pass through untouched on the common
      // unlocked + ungated path so their identity survives.
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
      // Noop forms surface as always-valid even before their (trivial)
      // schema settle has registered — noop schemas resolve synchronously
      // so this branch is mostly defensive, but it keeps the status
      // surface stable for string-slot keys at t=0. A string slot can
      // itself be a gate (`gate('terms')`), so the gate overlay applies
      // here too.
      if (noopForms.has(form.key)) {
        return locked || gate !== null ? { ...NOOP_VALID_STATUS, locked, gate } : NOOP_VALID_STATUS
      }
      const seed = seedRef.value?.[form.key]
      if (seed !== undefined) return { ...seed, locked, gate }
      return locked || gate !== null ? { ...PENDING_STATUS, locked, gate } : PENDING_STATUS
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
            // Resolve the URL's *effective* step: an absent or unknown
            // `?step=` resolves to the first step (the wizard's
            // fallback), so a bare `/wizard` is the same effective page
            // as `?step=<first>`. Writing the step we're already
            // effectively on is a canonicalization, not a navigation —
            // replace in place so Back never lands on a dead entry
            // showing the same step (and the Forward stack survives a
            // Back round-trip). A genuine step change pushes a real
            // history entry.
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
    // Route the initial pin through the funnel so a deep link straight
    // into a gated step lands on the gate (or defers to the corrector
    // while the gate hydrates) instead of opening a locked step.
    const landing = commitActiveKey(initialKey)
    visited.value = [landing]
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
  // The error thrown or rejected by the most recent `wizard.handleSubmit`
  // callback (or its `onError`), coerced to a real `Error`. Mirrors
  // `form.meta.submitError`: cleared at submit entry, parked here instead
  // of re-thrown, so binding the handler to `@submit` never
  // manufactures a `window` unhandledrejection.
  const submitError = ref<Error | null>(null)
  // Monotonic latch: flips true the first time a `handleSubmit` resolves
  // without throwing (and leaves no errors on any step), and stays true
  // through subsequent edits or invalidations. Only `reset()` flips it
  // back (a new run starts a new history). Distinct accounting from
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

  // Raw single-step advance: record the departure and move the pin to the
  // next compiled position. Shared by `next()` (the public verb) and
  // `tryNext()`'s post-submit advance, so `tryNext` never re-enters the
  // gate-delegating `next()` (which would loop on a gate step).
  function advanceOne(): void {
    const list = compiledSteps.value
    const idx = activeIndex.value
    if (idx < 0 || idx >= list.length - 1) return
    recordDeparture(activeKey.value)
    const target = list[idx + 1] as CompiledStep
    moveTo(target.key)
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
    // A gate step advances only through its own submit: a bare `next()` on
    // a gate behaves like `tryNext()`, so wiring Next straight to `next()`
    // can never skip the gate's confirmation.
    const active = list[idx]
    if (active !== undefined && active.isGate) {
      await tryNext()
      return
    }
    advanceOne()
  }

  // Submit the active step, and once that submit resolves clean, advance.
  // Wire it straight to a control (`@click="wizard.tryNext()"`) with no
  // captured handler. Invalid input keeps the pin put under the form's own
  // reveal (first error focused, display state advanced); a clean submit
  // advances. The advance runs AFTER the submit settles, not inside its
  // callback, so a `gate()` on the active step has cleared (its
  // clean-submit signal fired) by the time the pin moves, and the gate
  // clears + advances in a single call. Resolves to whether the pin
  // moved, so `if (await wizard.tryNext())` can branch on the outcome.
  // Pure navigation stays `next()`; the whole-wizard submit stays
  // `handleSubmit`. No-ops to `false` on a degenerate or final-step
  // wizard, mirroring `next()`.
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
    // Confirm the submit ran clean, THEN advance. A `gate()` on the active
    // step only clears after its submit callback resolves, so advancing
    // from inside the callback would read pre-clear lock state and refuse.
    // Marking success in the callback and advancing afterward lets a gate
    // clear on its own completion. Advance through `advanceOne()`, not
    // `next()`, so a gate step doesn't loop back into `tryNext`.
    const before = activeKey.value
    let ranClean = false
    await asHandleSubmitSource(form).handleSubmit(() => {
      ranClean = true
    })()
    if (ranClean) advanceOne()
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
            formKey: form.key,
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

  // Lift the user-error layer of each PROCESSED form into the wizard's
  // aggregate shape. The post-callback mirror of `collectErrors` (#438):
  // after a clean validation pass, a callback that called `setErrors` on
  // a step left those errors here. Scoped to the keys the submit actually
  // processed (every step, since `handleSubmit` is whole-wizard), matching
  // the entry-clear scope.
  function collectCallbackErrors(keys: Iterable<FormKey>): WizardAggregateError[] {
    const out: WizardAggregateError[] = []
    for (const key of keys) {
      const store = registry.forms.get(key)
      if (store === undefined) continue
      for (const errs of store.userErrors.values()) {
        for (const err of errs) out.push(toWizardAggregateError(err, key))
      }
    }
    return out
  }

  // Uncleared `gate()` steps, lifted to the wizard's aggregate error shape.
  // A gate blocks whole-wizard completion even when its (and every
  // downstream) form validates, because a gate clears only on a member
  // form's clean submit — never on a valid-by-default downstream form. So a
  // finish attempt that jumps past an unconfirmed gate is routed through the
  // same failure path as a validation error: focus lands on the gate and
  // `done` never latches.
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

  // Move to the first failed step and run its invalid-submit focus
  // policy. Shared by the validation-failure path and the post-callback
  // error path (#438) so both honor `options.focusFirstError` the same
  // way, and runs BEFORE onError so the consumer can override the focus.
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
        // Positional only: surfaced as `ctx.isFinal`. Nothing branches on
        // it — `handleSubmit` processes the whole wizard from any step.
        const final = isFinalStep.value
        const list = compiledSteps.value
        const results = new Map<FormKey, ValidationResponse<unknown>>()

        // Validate every step, regardless of which step fired the submit:
        // `wizard.handleSubmit` always submits the whole wizard. Gating
        // advance on a single step's validity is the composition
        // `activeForm.handleSubmit(() => wizard.next())`, which runs on the
        // form side. Run in parallel so latency is bounded by the slowest
        // form rather than the sum of all forms.
        await Promise.all(
          list.map(async (step) => {
            // Entry-clear user-set errors before validating, mirroring
            // form.handleSubmit: a fresh attempt starts each form from a
            // clean user-error slate. Every step is processed, so every
            // step is cleared.
            registry.forms.get(step.key)?.clearUserErrors()
            const result = await processOne(step.form)
            results.set(step.key, result)
          })
        )

        // Bump per-form submissionAttempts for every form we just
        // processed (noops included — accounting-distinct counters per
        // [[feedback-api-name-hygiene]]). The wizard-level counter
        // always bumps once per invocation.
        for (const key of results.keys()) {
          const store = registry.forms.get(key)
          if (store !== undefined) {
            store.submissionAttempts.value += 1
            // Mirror the form's own handleSubmit: a wizard submit is an
            // explicit reveal, so abort any in-flight per-field validation
            // (clearing `fieldValidatingSince`) and drop the anti-flash
            // display state, so leftover show-delay holds or min-visible
            // spinner timers can't outlive the submit and delay the verdict.
            store.cancelFieldValidation()
            store.displayEngine.clear()
          }
        }
        submissionAttempts.value += 1

        const errors = collectErrors(results)
        // An uncleared gate blocks completion even on an all-valid pass;
        // fold it into the blocking set so the whole-wizard finish can't
        // route around an unconfirmed prerequisite. Validation errors sort
        // first so focus lands on a genuine field error before the gate.
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
          // #438 parity with form.handleSubmit: a callback that left errors
          // on a processed step (the documented `setErrors(...); return`
          // server-rejection path) has NOT succeeded. The entry-clear above
          // means any user error present now was set by this callback. Route
          // it through the same failure path as a validation failure: focus
          // the first error, fire onError, and return WITHOUT latching `done`.
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
          // Whole-wizard success: every step validated and the callback
          // left no errors. Latch `done`; never move the pin. Advancing a
          // step lives in the gated-advance composition, not here.
          done.value = true
        } else {
          // Apply the invalid-submit focus policy BEFORE onError, mirroring
          // form.handleSubmit: the consumer's onError can override the
          // focus, and a throwing onError still leaves the first error
          // focused rather than stranding the user. `blocking` carries the
          // validation errors plus any uncleared-gate error.
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
        // Park the throw on `submitError`, coerced to a real Error; never
        // re-throw. The handler is bound to DOM events (`@submit`),
        // so a rejected promise would surface as a `window`
        // unhandledrejection — a phantom crash for an already-handled
        // failure. The `finally` still resets `submitting`, so navigation
        // resumes and the button is never stranded.
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
    // Clear the gate latch so a reboot re-gates from scratch. A gate whose
    // reset defaults land valid re-clears through `reconcileGates` below,
    // once the per-form reset has restored + re-validated those defaults.
    if (mightGate) {
      clearedGates.clear()
      seededSampled.clear()
    }
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
    if (mightGate) reconcileGates()
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

  // Gate corrector. `commitActiveKey` refuses a nav-locked target at the
  // write site, but the active step can still end up nav-locked: its gate
  // was mid-hydration at commit time (the readiness defer kept the pin on
  // it), a gate dropped its cleared state, or a forward-continuity slide
  // landed on it. Whenever the active step is nav-locked and the gate it
  // sits behind has settled, bounce to the gate. Placed after `moveTo` /
  // `visited` so the bounce records its landing like any other navigation.
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
    tryNext,
    handleSubmit,
    reset,
    get currentStep(): CurrentStepOf<S> {
      return currentStep.value as CurrentStepOf<S>
    },
    get activeForm(): ActiveFormOf<S> {
      // Live facade (built once above) so a handler captured at setup
      // time retargets the current step on every call. `undefined`
      // preserved for the degenerate (no-steps) wizard.
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
