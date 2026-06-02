// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  computed,
  createApp,
  defineComponent,
  h,
  nextTick,
  watch,
  withDirectives,
  type App,
} from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'
import { vRegister } from '../../src/runtime/core/directive'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { DEFAULT_TIMINGS, defaultDisplayState, makeDefaultDisplayState } from '../../src'
import { FOCUS_OUT_GRACE } from '../../src/runtime/core/display-state'
import type {
  DisplayCtx,
  DisplayMachine,
  DisplayState,
  GetDisplayState,
  ValidationError,
} from '../../src'

/**
 * `field.displayState` + the `getDisplayState` reducer.
 *
 * `field.displayState` is the single derived verdict on `FieldState`
 * (`'idle' | 'pending' | 'error' | 'success'`); the four `show*` booleans
 * are pure projections of it (`showErrors === (displayState === 'error')`,
 * and so on). The reducer `getDisplayState(prev, ctx)` returns the next
 * `DisplayMachine` and resolves through three tiers:
 *   1. Library default: one timing gate
 *      (`submissionAttempts > 0 || blurredAfterInteraction`), then
 *      precedence — a validation in flight surfaces a delayed, then held,
 *      `'pending'` (the anti-flash spinner); own-path error → error;
 *      earned (`valid && !blank && dirty`) → success; else idle.
 *      Containers (intermediate AND root, including `form.meta`) roll up
 *      their descendants' GATED verdicts: pending if any descendant is
 *      pending, else error if any descendant (or own cross-field) error
 *      has cleared its own reveal gate, else earned success, else idle.
 *      An ungated sibling error never surfaces at the container.
 *   2. `createAttaform({ defaults: { getDisplayState } })`.
 *   3. `useForm({ getDisplayState })`, wins over both above.
 *
 * The reducer runs unconditionally (it must see the no-error states to
 * resolve success / idle / pending). Its `ctx.field` / `ctx.formMeta` are
 * `Omit`'d of the derived `displayState` / `show*` / `firstError` keys at
 * BOTH the type and runtime level, so a self-referential reducer is
 * impossible regardless of language (TS or JS). The pure timing matrix is
 * locked in `display-reducer.test.ts`; this file covers the verdicts and
 * the override tiers through a real mounted form.
 */

const apps: App[] = []
afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
  document.body.innerHTML = ''
})

function mountWithApp<T>(
  setup: () => T,
  pluginOptions: Parameters<typeof createAttaform>[0] = {}
): T {
  const handle: { captured?: T } = {}
  const App = defineComponent({
    setup() {
      handle.captured = setup()
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform({ ...pluginOptions }))
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  apps.push(app)
  if (handle.captured === undefined) throw new Error('mountWithApp: setup never returned')
  return handle.captured
}

type FieldStateLike = {
  readonly errors: readonly ValidationError[]
  readonly displayState: DisplayState
  readonly showErrors: boolean
  readonly showPending: boolean
  readonly showSuccess: boolean
  readonly showIdle: boolean
  readonly firstError: ValidationError | undefined
  readonly touched: boolean
  readonly interacted: boolean
  readonly dirty: boolean
  readonly valid: boolean
  readonly validating: boolean
}

type FormLike = {
  fields: (path?: string | readonly (string | number)[]) => FieldStateLike
  setFieldErrors: (errors: readonly ValidationError[]) => void
  setValue: (path: string, value: unknown) => boolean
  touch: (path?: string | readonly (string | number)[]) => void
  handleSubmit: (
    onSubmit: (data: unknown) => void | Promise<void>,
    onError?: (errors: readonly ValidationError[]) => void
  ) => () => Promise<void>
  meta: {
    submissionAttempts: number
    submitting: boolean
    displayState: DisplayState
    showErrors: boolean
    showPending: boolean
    showSuccess: boolean
    showIdle: boolean
  }
  key: string
}

function asForm<F>(form: F): F & FormLike {
  return form as unknown as F & FormLike
}

// Invariant pinned at every assertion: the four `show*` booleans are
// exact projections of the single `displayState` enum and can never
// disagree with it.
function expectProjections(field: FieldStateLike): void {
  expect(field.showErrors).toBe(field.displayState === 'error')
  expect(field.showPending).toBe(field.displayState === 'pending')
  expect(field.showSuccess).toBe(field.displayState === 'success')
  expect(field.showIdle).toBe(field.displayState === 'idle')
}

// -----------------------------------------------------------------------------
// Shared schema-shaped tests, parameterised by adapter
// -----------------------------------------------------------------------------

type AdapterFactory = (pluginOptions?: Parameters<typeof createAttaform>[0]) => FormLike

function describeAdapter(label: string, makeForm: AdapterFactory): void {
  describe(label, () => {
    function injectError(form: FormLike, path: readonly (string | number)[], message: string) {
      form.setFieldErrors([{ path: [...path], message, formKey: form.key, code: 'test' }])
    }

    describe('default heuristic — leaf', () => {
      it('errors present, untouched, submissionAttempts=0 → idle (gate closed)', () => {
        const form = makeForm()
        injectError(form, ['email'], 'email required')
        expect(form.fields('email').errors.length).toBe(1)
        expect(form.fields('email').displayState).toBe('idle')
        expectProjections(form.fields('email'))
      })

      it('touched but not interacted (tab-through) stays idle until submit', async () => {
        const form = makeForm()
        injectError(form, ['email'], 'email required')
        form.touch('email')
        await nextTick()
        expect(form.fields('email').touched).toBe(true)
        expect(form.fields('email').interacted).toBe(false)
        // The gate needs (interacted && touched): a programmatic touch (and
        // a real tab-through) flips touched but never interacted, so the
        // field stays quiet. No scolding a field the user never edited.
        expect(form.fields('email').displayState).toBe('idle')
        expectProjections(form.fields('email'))
      })

      it('programmatic touch + setValue (no user input) stays idle', async () => {
        const form = makeForm()
        injectError(form, ['email'], 'email required')
        form.touch('email')
        form.setValue('email', 'x')
        // Drain the change-mode validation chain so `field.validating`
        // returns to false before the verdict assertion.
        await new Promise((r) => setTimeout(r, 0))
        expect(form.fields('email').dirty).toBe(true)
        expect(form.fields('email').interacted).toBe(false)
        expect(form.fields('email').validating).toBe(false)
        // Neither a programmatic touch nor a programmatic setValue counts as
        // user interaction, so the gate stays closed and the verdict is idle.
        // Only user input through v-register flips interacted.
        expect(form.fields('email').displayState).toBe('idle')
        expectProjections(form.fields('email'))
      })

      it('errors present, untouched, submissionAttempts=1 → error', async () => {
        const form = makeForm()
        injectError(form, ['email'], 'email required')
        await form.handleSubmit(() => {})()
        await nextTick()
        expect(form.meta.submissionAttempts).toBeGreaterThan(0)
        expect(form.fields('email').displayState).toBe('error')
        expectProjections(form.fields('email'))
      })

      it('no errors, submissionAttempts=10, gate open, valid value → success', async () => {
        const form = makeForm()
        form.touch('email')
        form.setValue('email', 'x')
        for (let i = 0; i < 10; i++) {
          await form.handleSubmit(() => {})()
        }
        await nextTick()
        expect(form.fields('email').errors.length).toBe(0)
        expect(form.fields('email').valid).toBe(true)
        expect(form.meta.submissionAttempts).toBe(10)
        // No error + valid + earned (the value was edited to 'x', so the
        // field is dirty and non-blank) → the green-check confirmation.
        expect(form.fields('email').dirty).toBe(true)
        expect(form.fields('email').displayState).toBe('success')
        expect(form.fields('email').showErrors).toBe(false)
        expectProjections(form.fields('email'))
      })
    })

    describe('default heuristic — container (descendant rollup)', () => {
      it('an ungated descendant error keeps the container idle though invalid', async () => {
        const form = makeForm()
        injectError(form, ['users', 0, 'label'], 'label required')
        await nextTick()
        const row = form.fields('users.0')
        expect(row.errors.length).toBeGreaterThan(0)
        // No submit and the leaf was never blurred-after-interaction, so the
        // leaf withholds its own error (its gate is closed) and the container
        // has nothing to surface. Validity still reflects the latent error.
        expect(row.valid).toBe(false)
        expect(row.displayState).toBe('idle')
        expect(row.showErrors).toBe(false)
        expectProjections(row)
      })

      it('a gated descendant error rolls up to its container (row and array)', async () => {
        const form = makeForm()
        // Empty label fails min(1); submit opens every field's gate.
        await form.handleSubmit(() => {})()
        await nextTick()
        expect(form.fields('users.0.label').displayState).toBe('error')
        // The row container reflects the now-visible descendant error...
        expect(form.fields('users.0').displayState).toBe('error')
        expect(form.fields('users.0').showErrors).toBe(true)
        expectProjections(form.fields('users.0'))
        // ...and so does the array container above it.
        expect(form.fields('users').displayState).toBe('error')
        expectProjections(form.fields('users'))
      })

      it('a container surfaces its OWN (cross-field) error after the gate opens', async () => {
        const form = makeForm()
        // Error at the container path itself (e.g., an object-level refine
        // or a server-side cross-field error mapped to the row).
        injectError(form, ['users', 0], 'row is invalid')
        await form.handleSubmit(() => {})()
        await nextTick()
        const row = form.fields('users.0')
        expect(row.displayState).toBe('error')
        expect(row.showErrors).toBe(true)
        expectProjections(row)
      })
    })

    describe('reactivity', () => {
      it('a computed wrapping field.displayState updates after submit', async () => {
        const form = makeForm()
        injectError(form, ['email'], 'email required')
        const probe = computed(() => form.fields('email').displayState)
        expect(probe.value).toBe('idle')
        await form.handleSubmit(() => {})()
        await nextTick()
        expect(probe.value).toBe('error')
      })

      it('clearing errors flips error → success (gate open via submit)', async () => {
        const form = makeForm()
        // Submit opens the gate for every field; the empty required email
        // fails the schema, so it starts in error.
        await form.handleSubmit(() => {})()
        await nextTick()
        expect(form.fields('email').displayState).toBe('error')
        // Edit to a valid value: revalidation clears the error, and the
        // earned (dirty + non-blank + valid) field greens.
        form.setValue('email', 'x')
        await new Promise((r) => setTimeout(r, 0))
        expect(form.fields('email').errors.length).toBe(0)
        expect(form.fields('email').displayState).toBe('success')
        expectProjections(form.fields('email'))
      })
    })

    describe('form.meta.displayState (form-level rollup)', () => {
      it('rolls up a gated descendant error to the form banner', async () => {
        const form = makeForm()
        injectError(form, ['email'], 'email required')
        // Gate closed: nothing surfaced yet, at the leaf or the root.
        expect(form.meta.displayState).toBe('idle')
        await form.handleSubmit(() => {})()
        await nextTick()
        // Submit opens the gate; the now-visible leaf error rolls up to the
        // form root, so form.meta.show* can drive a form-level banner.
        expect(form.meta.displayState).toBe('error')
        expect(form.meta.showErrors).toBe(true)
      })

      it('greens once every field is valid and earned', async () => {
        const form = makeForm()
        form.setValue('email', 'a@b.c')
        form.setValue('profile.name', 'Ada')
        form.setValue('users.0.label', 'x')
        await form.handleSubmit(() => {})()
        await nextTick()
        expect(form.meta.displayState).toBe('success')
        expect(form.meta.showSuccess).toBe(true)
      })
    })
  })
}

function describeOverrideTier(
  label: string,
  makeForm: (
    pluginDefault: GetDisplayState | undefined,
    perFormConfig: GetDisplayState | undefined
  ) => FormLike
): void {
  describe(label, () => {
    function inject(form: FormLike) {
      form.setFieldErrors([
        { path: ['email'], message: 'required', formKey: form.key, code: 'test' },
      ])
    }

    // A reducer that surfaces errors purely on touch, ignoring the
    // submit arm of the default gate.
    const touchOnly: GetDisplayState = (_prev, { field }) =>
      field.errors.length > 0 && field.touched === true ? { display: 'error' } : { display: 'idle' }
    // "Always show when errors exist" — the eager reducer.
    const eager: GetDisplayState = (_prev, { field }) =>
      field.errors.length > 0 ? { display: 'error' } : { display: 'idle' }
    // "Never surface anything."
    const silent: GetDisplayState = () => ({ display: 'idle' })

    it('plugin-level override: custom predicate ignores submissionAttempts', async () => {
      const form = makeForm(touchOnly, undefined)
      inject(form)
      await form.handleSubmit(() => {})()
      await nextTick()
      expect(form.meta.submissionAttempts).toBeGreaterThan(0)
      // touched is still false (no DOM blur, no programmatic touch)
      expect(form.fields('email').displayState).toBe('idle')
      form.touch('email')
      await nextTick()
      expect(form.fields('email').displayState).toBe('error')
    })

    it('plugin-level override: eager predicate shows as soon as errors exist', async () => {
      const form = makeForm(eager, undefined)
      inject(form)
      await nextTick()
      expect(form.fields('email').displayState).toBe('error')
    })

    it('plugin-level override: silent predicate never surfaces even after submit', async () => {
      const form = makeForm(silent, undefined)
      inject(form)
      await form.handleSubmit(() => {})()
      await nextTick()
      expect(form.fields('email').displayState).toBe('idle')
    })

    it('per-form useForm override beats plugin-level', async () => {
      // Plugin says ALWAYS show; per-form overrides to NEVER surface.
      const form = makeForm(eager, silent)
      inject(form)
      await form.handleSubmit(() => {})()
      await nextTick()
      expect(form.fields('email').displayState).toBe('idle')
    })

    it('per-form useForm override beats plugin-level (touch-gated)', async () => {
      // Plugin says always; per-form gates on touched only.
      const form = makeForm(eager, touchOnly)
      inject(form)
      await form.handleSubmit(() => {})()
      await nextTick()
      expect(form.fields('email').displayState).toBe('idle')
      form.touch('email')
      await nextTick()
      expect(form.fields('email').displayState).toBe('error')
    })
  })
}

// -----------------------------------------------------------------------------
// v3 adapter
// -----------------------------------------------------------------------------

const v3Schema = zV3.object({
  email: zV3.string().min(1),
  profile: zV3.object({ name: zV3.string().min(1) }),
  users: zV3.array(zV3.object({ label: zV3.string().min(1) })),
})
const v3Defaults = {
  email: '',
  profile: { name: '' },
  users: [{ label: '' }],
}

describeAdapter('displayState — zod-v3 adapter', () =>
  asForm(
    mountWithApp(() =>
      useFormV3({
        schema: v3Schema,
        key: `display-state-v3-${Math.random()}`,
        strict: false,
        defaultValues: v3Defaults,
      })
    )
  )
)

describeOverrideTier('getDisplayState override resolution — zod-v3', (pluginDefault, perForm) =>
  asForm(
    mountWithApp(
      () =>
        useFormV3({
          schema: v3Schema,
          key: `display-state-override-v3-${Math.random()}`,
          strict: false,
          defaultValues: v3Defaults,
          ...(perForm === undefined ? {} : { getDisplayState: perForm }),
        }),
      pluginDefault === undefined ? {} : { defaults: { getDisplayState: pluginDefault } }
    )
  )
)

// -----------------------------------------------------------------------------
// v4 adapter
// -----------------------------------------------------------------------------

const v4Schema = zV4.object({
  email: zV4.string().min(1),
  profile: zV4.object({ name: zV4.string().min(1) }),
  users: zV4.array(zV4.object({ label: zV4.string().min(1) })),
})
const v4Defaults = {
  email: '',
  profile: { name: '' },
  users: [{ label: '' }],
}

describeAdapter('displayState — zod-v4 adapter', () =>
  asForm(
    mountWithApp(() =>
      useFormV4({
        schema: v4Schema,
        key: `display-state-v4-${Math.random()}`,
        strict: false,
        defaultValues: v4Defaults,
      })
    )
  )
)

describeOverrideTier('getDisplayState override resolution — zod-v4', (pluginDefault, perForm) =>
  asForm(
    mountWithApp(
      () =>
        useFormV4({
          schema: v4Schema,
          key: `display-state-override-v4-${Math.random()}`,
          strict: false,
          defaultValues: v4Defaults,
          ...(perForm === undefined ? {} : { getDisplayState: perForm }),
        }),
      pluginDefault === undefined ? {} : { defaults: { getDisplayState: pluginDefault } }
    )
  )
)

// -----------------------------------------------------------------------------
// Cross-cutting: omit'd args, public default heuristic, runtime safety
// -----------------------------------------------------------------------------

describe('getDisplayState — cross-cutting', () => {
  it('predicate runtime args literally omit the derived display keys', async () => {
    const derivedKeys = [
      'displayState',
      'showErrors',
      'showPending',
      'showSuccess',
      'showIdle',
      'firstError',
    ] as const
    const probe = {
      fieldPresent: [] as string[],
      formMetaPresent: [] as string[],
    }
    const form = asForm(
      mountWithApp(() =>
        useFormV4({
          schema: v4Schema,
          key: `omit-runtime-${Math.random()}`,
          strict: false,
          defaultValues: v4Defaults,
          getDisplayState: (_prev, { field, formMeta }) => {
            for (const k of derivedKeys) {
              if (k in (field as object)) probe.fieldPresent.push(k)
              if (k in (formMeta as object)) probe.formMetaPresent.push(k)
            }
            return { display: 'error' }
          },
        })
      )
    )
    form.setFieldErrors([{ path: ['email'], message: 'required', formKey: form.key, code: 'test' }])
    // Trigger evaluation
    void form.fields('email').displayState
    await nextTick()

    expect(probe.fieldPresent).toEqual([])
    expect(probe.formMetaPresent).toEqual([])
  })

  it('defaultDisplayState is publicly exported as a (prev, ctx) reducer', () => {
    expect(typeof defaultDisplayState).toBe('function')
    expect(defaultDisplayState.length).toBe(2)
  })

  it('defaultDisplayState composes inside a layered reducer', async () => {
    const layered: GetDisplayState = (prev, ctx) =>
      ctx.field.path[0] === 'urgent' ? { display: 'error' } : defaultDisplayState(prev, ctx)

    const form = asForm(
      mountWithApp(() =>
        useFormV4({
          schema: v4Schema,
          key: `composed-${Math.random()}`,
          strict: false,
          defaultValues: v4Defaults,
          getDisplayState: layered,
        })
      )
    )
    form.setFieldErrors([{ path: ['email'], message: 'required', formKey: form.key, code: 'test' }])
    // path[0] === 'urgent' is false for 'email' — falls through to the
    // default, which is 'idle' at this state (untouched, submissionAttempts=0).
    await nextTick()
    expect(form.fields('email').displayState).toBe('idle')
    // Trigger the default branch's error case.
    await form.handleSubmit(() => {})()
    await nextTick()
    expect(form.fields('email').displayState).toBe('error')
  })

  // The full synthetic gate / error / earned-success / container matrix
  // for the default reducer now lives in `display-reducer.test.ts`, where
  // it can inject `now` / `validatingSince` / `prev` deterministically and
  // also lock the anti-flash timing. Integration coverage of the same
  // verdicts (through a real mounted form) stays in the adapter blocks above.

  // PASS2-11 — a consumer predicate that throws must not take the
  // reactive surface down. The catch was already there (correct, never
  // throws into the app), but the throw was silently swallowed so a
  // misbehaving predicate stayed invisible. Standing diagnostic: warn
  // once in dev, fall back to the library default.
  it('consumer predicate throw: warns in dev once, falls back to default verdict', async () => {
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })

    let throws = 0
    const exploding: GetDisplayState = () => {
      throws += 1
      throw new Error('boom')
    }

    const form = asForm(
      mountWithApp(() =>
        useFormV4({
          schema: v4Schema,
          key: `throw-pred-${Math.random()}`,
          strict: false,
          defaultValues: v4Defaults,
          getDisplayState: exploding,
        })
      )
    )
    form.setFieldErrors([{ path: ['email'], message: 'required', formKey: form.key, code: 'test' }])
    // Read the field twice to exercise the predicate path on a hot
    // re-read; the warn should still fire once (dedup on the predicate
    // reference).
    const first = form.fields('email').displayState
    const second = form.fields('email').displayState

    warnSpy.mockRestore()
    expect(typeof first).toBe('string')
    expect(typeof second).toBe('string')
    // Library default returned the error verdict (an own-path error +
    // submissionAttempts=0 → 'idle' under the gate). The exact verdict
    // is the library default's call; what matters is the FALLBACK
    // landed, not what value it produced.
    expect(throws).toBeGreaterThan(0)
    const matchingWarns = warnings.filter(
      (w) => w.includes('getDisplayState') && w.includes('default')
    )
    expect(matchingWarns.length).toBe(1)
  })
})

describe('getDisplayState — anti-flash spinner timing (integration)', () => {
  // Fake timers drive both the engine's deadline `setTimeout` and the
  // injected `now` (vitest mocks `Date.now()`), so the show-delay /
  // min-visible thresholds are exercised deterministically. The form's
  // own validation runs on microtasks (not timers), which `await` and
  // `advanceTimersByTimeAsync` flush.
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function mountGatedRefine(): { form: FormLike; resolve: (ok: boolean) => void } {
    let resolveValidation: (ok: boolean) => void = () => {}
    const schema = zV4.object({
      email: zV4.string().refine(
        (val) => {
          // Empty rejects synchronously; any non-empty value parks on the
          // external gate so the test can sit inside the validating window.
          if (val.length === 0) return false
          return new Promise<boolean>((resolve) => {
            resolveValidation = resolve
          })
        },
        { error: 'invalid email' }
      ),
    })
    const form = asForm(
      mountWithApp(() =>
        useFormV4({
          schema,
          key: `pending-timing-${Math.random()}`,
          strict: false,
          defaultValues: { email: '' },
        } as never)
      )
    )
    return { form, resolve: (ok) => resolveValidation(ok) }
  }

  it('holds the verdict through show-delay, shows a held spinner, then the landed verdict', async () => {
    const { form, resolve } = mountGatedRefine()

    // Gate open + a landed error on the empty string.
    form.touch('email')
    await form.handleSubmit(() => {})()
    await nextTick()
    expect(form.fields('email').displayState).toBe('error')

    // Edit: change-mode validation starts and parks on the external gate.
    form.setValue('email', 'a@b.c')
    await nextTick()
    expect(form.fields('email').validating).toBe(true)
    // Inside the show-delay window: the prior verdict is HELD — no spinner
    // flash even though a validation is genuinely in flight. SWR keeps the
    // stale error in `errors` for direct readers.
    expect(form.fields('email').errors.length).toBeGreaterThan(0)
    expect(form.fields('email').displayState).toBe('error')
    expectProjections(form.fields('email'))

    // Cross the show-delay: now a long-running validation earns its spinner.
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.showDelay)
    expect(form.fields('email').displayState).toBe('pending')
    expectProjections(form.fields('email'))

    // Resolve still-invalid. The spinner is held for its minimum-visible
    // window even though validation has already settled.
    resolve(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(form.fields('email').validating).toBe(false)
    expect(form.fields('email').displayState).toBe('pending')

    // Past min-visible: the landed error replaces the spinner.
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.minVisible)
    expect(form.fields('email').displayState).toBe('error')
    expect(form.fields('email').errors.length).toBeGreaterThan(0)
    expectProjections(form.fields('email'))
  })

  it('fast validation never reveals the spinner (settles inside the show-delay)', async () => {
    const { form, resolve } = mountGatedRefine()
    form.touch('email')
    await form.handleSubmit(() => {})()
    await nextTick()
    expect(form.fields('email').displayState).toBe('error')

    form.setValue('email', 'a@b.c')
    await nextTick()
    expect(form.fields('email').validating).toBe(true)
    expect(form.fields('email').displayState).toBe('error')

    // Resolve valid BEFORE the show-delay elapses: no spinner is ever shown,
    // and the verdict moves straight from the held error to success.
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.showDelay - 1)
    resolve(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(form.fields('email').validating).toBe(false)
    expect(form.fields('email').displayState).toBe('success')
    expect(form.fields('email').showPending).toBe(false)
    expectProjections(form.fields('email'))
    // No orphaned engine timer once the field settled.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a long-running client-side async check surfaces pending (async-ness drives it, not a network round-trip)', async () => {
    // The UX story: `pending` reflects "validation is in flight across event-loop
    // turns," NOT "a request is open to a server." A heavy on-device computation
    // that yields — any non-blocking async work; here a timer stands in for it,
    // no fetch anywhere — drives the spinner exactly as a remote check would, so
    // the consumer never has to care whether validation runs on the client or
    // the server. (A synchronous BLOCKING computation is the one case that can't
    // show a spinner: it freezes the thread, so nothing renders until it returns.
    // The remedy is to run it async — off the main thread or yielding — which
    // earns pending for free.)
    const schema = zV4.object({
      email: zV4
        .string()
        .refine(
          (val) =>
            val.length === 0
              ? false
              : new Promise<boolean>((r) => setTimeout(() => r(val !== 'taken'), 5000)),
          { error: 'taken' }
        ),
    })
    const form = asForm(
      mountWithApp(() =>
        useFormV4({
          schema,
          key: `client-compute-${Math.random()}`,
          strict: false,
          defaultValues: { email: '' },
        } as never)
      )
    )
    // Open the gate. Empty rejects synchronously, so this submit doesn't await
    // the 5s timer.
    form.touch('email')
    await form.handleSubmit(() => {})()
    await nextTick()

    // Kick off the slow on-device computation.
    form.setValue('email', 'available')
    await nextTick()
    expect(form.fields('email').validating).toBe(true)
    // Held through the show-delay — a fast result would never flash here.
    expect(form.fields('email').displayState).not.toBe('pending')

    // Past the show-delay, the LOCAL computation is still churning → spinner.
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.showDelay)
    expect(form.fields('email').displayState).toBe('pending')
    expectProjections(form.fields('email'))

    // The 5s computation finishes on-device (no network) → the verdict lands.
    await vi.advanceTimersByTimeAsync(5000)
    expect(form.fields('email').validating).toBe(false)
    expect(form.fields('email').displayState).toBe('success')
  })

  it('a burst of keystrokes keeps re-arming the show-delay (no spinner mid-typing)', async () => {
    // Regression for the live /demos/display-state report: typing showed the
    // spinner with no perceptible delay. `validatingSince` re-anchors on every
    // run start, not just the streak's 0 → 1 edge — with `debounceMs: 0` a fast
    // burst keeps the validation count above 0 (the aborted run's decrement
    // lands a microtask AFTER the next run's increment), so anchoring at the
    // streak start would pin the show-delay to the FIRST keystroke and surface
    // the spinner mid-typing. Re-anchoring suppresses it until the user pauses.
    const { form, resolve } = mountGatedRefine()
    form.touch('email')
    await form.handleSubmit(() => {})()
    await nextTick()
    expect(form.fields('email').displayState).toBe('error')

    // Type continuously: a fresh value every 40ms across 200ms — twice the
    // 100ms show-delay — each edit aborting the prior parked validation and
    // starting a new one. The spinner must stay suppressed the whole time.
    for (const v of ['a@b.c', 'a@b.cc', 'a@b.ccc', 'a@b.cccc', 'a@b.ccccc']) {
      form.setValue('email', v)
      await vi.advanceTimersByTimeAsync(40)
      expect(form.fields('email').validating).toBe(true)
      expect(form.fields('email').showPending).toBe(false)
    }

    // Pause. Now a genuinely-still-running validation earns its spinner.
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.showDelay)
    expect(form.fields('email').displayState).toBe('pending')
    expectProjections(form.fields('email'))
    // (The mid-burst parked validations are torn down by the afterEach
    // unmount; `resolve` is unused here because after a burst the captured
    // resolver may belong to an already-aborted run.)
    void resolve
  })

  it('releases a held spinner when a long validation settles with an UNCHANGED verdict', async () => {
    // Locks the continuity-branch release path: a validation longer than
    // showDelay + minVisible holds `pending` with NO engine timer (it trusts
    // the settle to be a reactive event), so the settle MUST re-run the display
    // computed to release the spinner. Asserts the release happens on settle
    // with no timer to advance — even when the verdict is unchanged (same
    // error). (Note: this passes whether `fieldValidatingSince` is reactive or
    // plain, because the field computed also depends on the reactive validation
    // count; it guards the behaviour, not that specific mechanism.)
    const { form, resolve } = mountGatedRefine()
    form.touch('email')
    await form.handleSubmit(() => {})()
    await nextTick()
    expect(form.fields('email').displayState).toBe('error') // landed error on ''

    // Edit to another invalid value: the same 'invalid email' verdict lands.
    form.setValue('email', 'still-bad')
    await nextTick()
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.showDelay)
    expect(form.fields('email').displayState).toBe('pending')
    // Past min-visible while STILL validating: the continuity branch drops the
    // engine timer, so nothing is scheduled to release the spinner.
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.minVisible)
    expect(form.fields('email').displayState).toBe('pending')
    expect(vi.getTimerCount()).toBe(0)

    // Settle with the SAME verdict. With no engine timer pending, only the
    // reactive `validatingSince` delete can re-run the computed — flush
    // microtasks only, advance no timers.
    resolve(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(form.fields('email').validating).toBe(false)
    expect(form.fields('email').displayState).toBe('error')
    expectProjections(form.fields('email'))
  })

  it('re-validating a success field never flashes idle (validatingSince brackets the count)', async () => {
    // Live report: a valid (success) field, edited to another valid value,
    // flashed `idle` before the spinner. Root cause was a one-frame signal
    // disagreement at the START of a run — `field.validating` flips true (the
    // count increments) before `validatingSince` is stamped, so a synchronous
    // reader catches (validating: true, validatingSince: null). Told it was
    // "settled", the reducer returned the idle verdict (`valid` is clamped
    // false mid-run, no error, no earned success), which then poisoned the
    // held verdict for the rest of the window. The fix stamps `validatingSince`
    // BEFORE the count, so the two signals never disagree.
    const { form, resolve } = mountGatedRefine()

    // Reach success: open the gate, edit to a valid value, resolve inside the
    // show-delay so the spinner never shows and the verdict lands on success.
    form.touch('email')
    await form.handleSubmit(() => {})()
    await nextTick()
    form.setValue('email', 'a@b.c')
    await nextTick()
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.showDelay - 1)
    resolve(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(form.fields('email').displayState).toBe('success')

    // A synchronous subscriber records every display frame. The transient idle
    // exists only for one synchronous re-eval between the two bookkeeping
    // writes, so a flush:'pre' template smooths over it — a sync watch is what
    // surfaces the defect (and what a consumer's own sync watch would hit).
    const frames: DisplayState[] = []
    const stop = watch(
      () => form.fields('email').displayState,
      (s) => frames.push(s),
      {
        flush: 'sync',
      }
    )

    // Edit to another still-valid value and run the full spinner cycle.
    form.setValue('email', 'a@b.cd')
    await nextTick()
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.showDelay)
    expect(form.fields('email').displayState).toBe('pending')
    resolve(true)
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.minVisible)
    stop()

    expect(form.fields('email').displayState).toBe('success')
    // The crux: success → pending → success, with no idle frame in between.
    expect(frames).toContain('pending')
    expect(frames).not.toContain('idle')
  })

  it('a custom factory drives the clock at its own thresholds', async () => {
    let resolveValidation: (ok: boolean) => void = () => {}
    const schema = zV4.object({
      email: zV4.string().refine(
        (val) =>
          val.length === 0
            ? false
            : new Promise<boolean>((resolve) => {
                resolveValidation = resolve
              }),
        { error: 'invalid email' }
      ),
    })
    const form = asForm(
      mountWithApp(() =>
        useFormV4({
          schema,
          key: `custom-timing-${Math.random()}`,
          strict: false,
          defaultValues: { email: '' },
          // Tighter than the default: spinner after 30ms, held for 90ms.
          getDisplayState: makeDefaultDisplayState({ showDelay: 30, minVisible: 90 }),
        } as never)
      )
    )

    form.touch('email')
    await form.handleSubmit(() => {})()
    await nextTick()
    expect(form.fields('email').displayState).toBe('error')

    form.setValue('email', 'a@b.c')
    await nextTick()
    // Still held at the default's 100ms would be wrong — this factory shows
    // the spinner at 30ms. Just before, it is still held.
    await vi.advanceTimersByTimeAsync(29)
    expect(form.fields('email').displayState).toBe('error')
    await vi.advanceTimersByTimeAsync(1)
    expect(form.fields('email').displayState).toBe('pending')

    resolveValidation(false)
    await vi.advanceTimersByTimeAsync(0)
    // Held for the custom 90ms min-visible, not the default 120ms.
    expect(form.fields('email').displayState).toBe('pending')
    await vi.advanceTimersByTimeAsync(90)
    expect(form.fields('email').displayState).toBe('error')
  })

  it('reset() mid-spinner clears the held state and leaves no orphaned timer', async () => {
    const { form, resolve } = mountGatedRefine()
    const api = form as unknown as { reset: () => void }
    form.touch('email')
    await form.handleSubmit(() => {})()
    await nextTick()
    form.setValue('email', 'a@b.c')
    await nextTick()
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.showDelay)
    expect(form.fields('email').displayState).toBe('pending')

    api.reset()
    await nextTick()
    // After reset the gate is closed again and nothing is in flight, so the
    // verdict is idle — and the engine timer was cleared.
    expect(form.fields('email').displayState).toBe('idle')
    expect(vi.getTimerCount()).toBe(0)
    // Settle the now-orphaned validation so it can't write post-reset.
    resolve(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(form.fields('email').displayState).toBe('idle')
  })

  it('a second keystroke mid-spinner keeps the spinner continuous (no flash to a verdict)', async () => {
    const { form } = mountGatedRefine()
    form.touch('email')
    await form.handleSubmit(() => {})()
    await nextTick()

    form.setValue('email', 'a@b.c')
    await nextTick()
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.showDelay)
    expect(form.fields('email').displayState).toBe('pending')

    // Type again while the spinner is up: a fresh validation streak opens
    // before the first settled. The anchor carries over, so the spinner
    // stays continuous rather than flashing back to the held verdict.
    form.setValue('email', 'a@b.cd')
    await nextTick()
    expect(form.fields('email').displayState).toBe('pending')
    // It stays pending while validation remains in flight — never a verdict
    // frame between the two keystrokes.
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.showDelay + DEFAULT_TIMINGS.minVisible)
    expect(form.fields('email').displayState).toBe('pending')
  })

  it('a container shows one continuous spinner while descendants validate on offset starts', async () => {
    const resolvers: Array<(ok: boolean) => void> = []
    const gate = (val: string): boolean | Promise<boolean> =>
      val === '' ? false : new Promise<boolean>((r) => resolvers.push(r))
    const schema = zV4.object({
      profile: zV4.object({
        a: zV4.string().refine(gate, { error: 'bad a' }),
        b: zV4.string().refine(gate, { error: 'bad b' }),
      }),
    })
    const form = asForm(
      mountWithApp(() =>
        useFormV4({
          schema,
          key: `container-spinner-${Math.random()}`,
          strict: false,
          defaultValues: { profile: { a: '', b: '' } },
        } as never)
      )
    )
    // Open the gate for every field (both empty leaves fail).
    await form.handleSubmit(() => {})()
    await nextTick()

    // Leaf A starts; 30ms later leaf B joins the streak.
    form.setValue('profile.a', 'x')
    await nextTick()
    await vi.advanceTimersByTimeAsync(30)
    form.setValue('profile.b', 'y')
    await nextTick()

    // Cross the show-delay (anchored at A, the earliest leaf): the container
    // reads one spinner, and it stays continuous as B's own window passes.
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.showDelay)
    expect(form.fields('profile').displayState).toBe('pending')
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.minVisible + 50)
    expect(form.fields('profile').displayState).toBe('pending')

    // Both resolve invalid; after min-visible the container leaves pending.
    // Each leaf now carries a gated error (submit opened the gate), so the
    // container rolls them up and settles to error.
    resolvers.forEach((r) => r(false))
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.minVisible)
    expect(form.fields('profile').validating).toBe(false)
    expect(form.fields('profile').displayState).toBe('error')
  })

  it('100 fields, one validating: a single shared engine timer, the rest leave nothing', async () => {
    const base = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`f${i}`, zV4.string()]))
    let resolveF0: (ok: boolean) => void = () => {}
    const schema = zV4.object({
      ...base,
      f0: zV4
        .string()
        .refine((v) => (v === '' ? false : new Promise<boolean>((r) => (resolveF0 = r))), {
          error: 'bad',
        }),
    })
    const defaults = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`f${i}`, '']))
    const form = asForm(
      mountWithApp(() =>
        useFormV4({
          schema,
          key: `perf-${Math.random()}`,
          strict: false,
          defaultValues: defaults,
        } as never)
      )
    )
    await form.handleSubmit(() => {})()
    await nextTick()
    // Reading every field after submit leaves no timer: errors / idle are
    // terminal, only an active validation arms one.
    for (let i = 0; i < 100; i++) void form.fields(`f${i}`).displayState
    expect(vi.getTimerCount()).toBe(0)

    // Type into exactly one. The engine's single per-form timer is the only
    // one armed, no matter how many fields are read.
    form.setValue('f0', 'x')
    await nextTick()
    for (let i = 0; i < 100; i++) void form.fields(`f${i}`).displayState
    expect(form.fields('f0').validating).toBe(true)
    expect(vi.getTimerCount()).toBe(1)

    resolveF0(false)
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.showDelay + DEFAULT_TIMINGS.minVisible)
  })

  it('form submit cancels a held spinner timer and reveals the verdict at once', async () => {
    const { form, resolve } = mountGatedRefine()
    // Open the gate + land an error (empty value is synchronously invalid).
    await form.handleSubmit(() => {})()
    await nextTick()
    expect(form.fields('email').displayState).toBe('error')

    // Drive a spinner into its min-visible hold: shown, validation settled,
    // hold timer still armed.
    form.setValue('email', 'a@b.c')
    await nextTick()
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.showDelay)
    expect(form.fields('email').displayState).toBe('pending')
    resolve(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(form.fields('email').displayState).toBe('pending')
    expect(vi.getTimerCount()).toBe(1)

    // Submit. At submit entry (before its own validation even runs) the
    // handler cancels field validation AND clears the display engine, so the
    // leftover hold timer is gone and the verdict is no longer masked by it.
    const submitting = form.handleSubmit(() => {})()
    expect(vi.getTimerCount()).toBe(0)
    expect(form.fields('email').displayState).not.toBe('pending')

    // The submit re-validates (still invalid); the error shows, no spinner.
    resolve(false)
    await submitting
    await nextTick()
    expect(form.fields('email').displayState).toBe('error')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('wizard submit cancels a held spinner timer on its forms', async () => {
    let resolveValidation: (ok: boolean) => void = () => {}
    const schema = zV4.object({
      email: zV4.string().refine(
        (val) =>
          val.length === 0
            ? false
            : new Promise<boolean>((r) => {
                resolveValidation = r
              }),
        { error: 'invalid email' }
      ),
    })
    const { form, wizard } = mountWithApp(() => {
      const f = useFormV4({
        schema,
        key: `wiz-timing-${Math.random()}`,
        strict: false,
        defaultValues: { email: '' },
      } as never)
      const w = useWizard({ steps: [f], restore: false, persist: false })
      return { form: asForm(f), wizard: w }
    })

    // Clean first wizard submit opens the gate. The wizard validates via
    // process(), which does not write per-field errors to the store, so the
    // empty field reads idle (gate open, nothing surfaced yet) rather than
    // error — that is fine; we only need the gate open to drive a spinner.
    await wizard.handleSubmit(() => {})()
    await nextTick()
    expect(form.fields('email').displayState).toBe('idle')

    // Drive a spinner into its min-visible hold (change validation DOES write
    // the error, so the field carries a verdict under the spinner).
    form.setValue('email', 'a@b.c')
    await nextTick()
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.showDelay)
    expect(form.fields('email').displayState).toBe('pending')
    resolveValidation(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(form.fields('email').displayState).toBe('pending')
    expect(vi.getTimerCount()).toBe(1)

    // Second wizard submit. processOne re-validates (parks on the gate); the
    // per-form cancel runs once it resolves, dropping the held timer.
    const submitting = wizard.handleSubmit(() => {})()
    await vi.advanceTimersByTimeAsync(0)
    resolveValidation(false)
    await submitting
    await nextTick()
    expect(vi.getTimerCount()).toBe(0)
    expect(form.fields('email').displayState).toBe('error')
  })
})

describe('resetField — in-flight validation teardown', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('cancels an in-flight run on the path (no orphaned validating, no stale error write-back)', async () => {
    // Regression: resetField on a field mid-validation left the in-flight run
    // orphaned. In blur mode (the restore write schedules no fresh run) the
    // field kept `validating: true` after the reset, and when the orphan
    // settled it committed its verdict back over the errors resetField had
    // just cleared. resetField now cancels the subtree's runs first.
    let resolveValidation: (ok: boolean) => void = () => {}
    const schema = zV4.object({
      email: zV4
        .string()
        .refine(
          (val) =>
            val.length === 0 ? false : new Promise<boolean>((r) => (resolveValidation = r)),
          { error: 'invalid email' }
        ),
    })
    let api!: FormLike
    const Comp = defineComponent({
      setup() {
        api = asForm(
          useFormV4({
            schema,
            key: `resetfield-teardown-${Math.random()}`,
            strict: false,
            validateOn: 'blur',
            defaultValues: { email: '' },
          } as never)
        )
        return () =>
          withDirectives(h('input', { type: 'text' }), [
            [vRegister, (api as unknown as { register: (p: string) => unknown }).register('email')],
          ])
      },
    })
    const app = createApp(Comp).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    apps.push(app)
    const input = root.querySelector('input') as HTMLInputElement

    // Edit + blur → a blur-mode validation run starts and parks on the gate.
    input.value = 'a@b.c'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    input.dispatchEvent(new FocusEvent('focus'))
    input.dispatchEvent(new FocusEvent('blur'))
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.fields('email').validating).toBe(true)

    // Reset the field while validation is in flight.
    ;(api as unknown as { resetField: (p: readonly (string | number)[]) => void }).resetField([
      'email',
    ])
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    // The run is cancelled in lockstep: nothing left validating, errors clear,
    // and the verdict rests at idle (the reset closed the gate).
    expect(api.fields('email').validating).toBe(false)
    expect(api.fields('email').errors.length).toBe(0)
    expect(api.fields('email').displayState).toBe('idle')

    // The orphaned run resolving must NOT write its verdict back post-reset.
    resolveValidation(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(api.fields('email').validating).toBe(false)
    expect(api.fields('email').errors.length).toBe(0)
    expect(api.fields('email').displayState).toBe('idle')
    // No orphaned engine timer left running either.
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('getDisplayState — focus-out collapses the show-delay', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('blurring mid-validation surfaces the spinner within the settle grace (not the full window)', async () => {
    // UX: the show-delay only swallows the spinner during active typing. Focus
    // out while a slow check is in flight and the spinner appears within the
    // brief settle grace — not after the rest of a window the user has already
    // left. A fast check settles inside the grace and never flashes (the
    // sync-field DOM-gate test above covers that no-flash path).
    let resolveValidation: (ok: boolean) => void = () => {}
    const schema = zV4.object({
      email: zV4
        .string()
        .refine(
          (val) =>
            val.length === 0 ? false : new Promise<boolean>((r) => (resolveValidation = r)),
          { error: 'invalid email' }
        ),
    })
    let api!: FormLike
    const Comp = defineComponent({
      setup() {
        api = asForm(
          useFormV4({
            schema,
            key: `focusout-grace-${Math.random()}`,
            strict: false,
            validateOn: 'blur',
            defaultValues: { email: '' },
          } as never)
        )
        return () =>
          withDirectives(h('input', { type: 'text' }), [
            [vRegister, (api as unknown as { register: (p: string) => unknown }).register('email')],
          ])
      },
    })
    const app = createApp(Comp).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    apps.push(app)
    const input = root.querySelector('input') as HTMLInputElement

    // Type, then focus out — blur mode starts the (parked, slow) validation.
    input.value = 'a@b.c'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    input.dispatchEvent(new FocusEvent('focus'))
    input.dispatchEvent(new FocusEvent('blur'))
    await nextTick()

    // One settle grace later — far short of the show-delay — the spinner is up.
    await vi.advanceTimersByTimeAsync(FOCUS_OUT_GRACE)
    expect(api.fields('email').validating).toBe(true)
    expect(api.fields('email').displayState).toBe('pending')
    expectProjections(api.fields('email'))

    // Then settles to the landed verdict (held for the min-visible window).
    resolveValidation(false)
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.minVisible)
    expect(api.fields('email').displayState).toBe('error')
  })
})

describe('getDisplayState — success is earned (dirty + non-blank)', () => {
  /**
   * The green check only fires for a field the user filled with valid
   * content themselves. A pre-filled field left untouched, an empty
   * optional field that happens to pass, and the post-submit flood of
   * every still-valid field all stay idle rather than greening for free.
   */
  it('valid-but-unchanged and valid-but-blank stay idle; editing to a valid value greens', async () => {
    const schema = zV4.object({
      // Pre-filled with a valid value: valid from mount, not dirty until edited.
      handle: zV4.string().min(1),
      // Optional: valid while empty, so it exercises the blank guard.
      bio: zV4.string().optional(),
    })
    const form = asForm(
      mountWithApp(() =>
        useFormV4({
          schema,
          key: `earned-success-${Math.random()}`,
          strict: false,
          defaultValues: { handle: 'ada', bio: '' },
        } as never)
      )
    )

    // Force the gate open for every field.
    await form.handleSubmit(() => {})()
    await nextTick()
    expect(form.meta.submissionAttempts).toBeGreaterThan(0)

    // handle: valid + non-blank but NOT dirty (untouched default) → idle.
    expect(form.fields('handle').valid).toBe(true)
    expect(form.fields('handle').dirty).toBe(false)
    expect(form.fields('handle').displayState).toBe('idle')
    expectProjections(form.fields('handle'))

    // bio: valid (optional) but blank → idle.
    expect(form.fields('bio').valid).toBe(true)
    expect(form.fields('bio').displayState).toBe('idle')
    expectProjections(form.fields('bio'))

    // Edit handle to a new valid value → dirty + non-blank + valid → success.
    form.touch('handle')
    form.setValue('handle', 'champion')
    await new Promise((r) => setTimeout(r, 0))
    expect(form.fields('handle').dirty).toBe(true)
    expect(form.fields('handle').displayState).toBe('success')
    expectProjections(form.fields('handle'))
  })
})

describe('getDisplayState — reward early, punish late (DOM gate)', () => {
  const gateSchema = zV4.object({ email: zV4.string().email('Enter a valid email') })

  function mountInput(): { api: FormLike; input: HTMLInputElement } {
    const handle: { api?: FormLike } = {}
    const Comp = defineComponent({
      setup() {
        const api = useFormV4({
          schema: gateSchema,
          key: `gate-${Math.random()}`,
          strict: false,
          validateOn: 'blur',
        } as never) as unknown as FormLike & { register: (p: string) => unknown }
        handle.api = api
        return () =>
          withDirectives(h('input', { type: 'text' }), [[vRegister, api.register('email')]])
      },
    })
    const app = createApp(Comp).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    apps.push(app)
    if (handle.api === undefined) throw new Error('mountInput: api never set')
    return { api: handle.api, input: root.firstElementChild as HTMLInputElement }
  }

  function typeInto(input: HTMLInputElement, value: string): void {
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  it('a clean tab-through (focus then blur, no edit) keeps a hidden error idle', async () => {
    const { api, input } = mountInput()
    input.dispatchEvent(new FocusEvent('focus'))
    input.dispatchEvent(new FocusEvent('blur'))
    // validateOn:'blur' computes the (failing) verdict on blur, but the gate
    // needs interacted too, so a clean tab-through never surfaces it.
    await new Promise((r) => setTimeout(r, 0))
    expect(api.fields('email').touched).toBe(true)
    expect(api.fields('email').interacted).toBe(false)
    expect(api.fields('email').errors.length).toBeGreaterThan(0)
    expect(api.fields('email').displayState).toBe('idle')
    expectProjections(api.fields('email'))
  })

  it('stays quiet mid-entry, then reveals the error on blur', async () => {
    const { api, input } = mountInput()
    input.dispatchEvent(new FocusEvent('focus'))
    typeInto(input, 'not-an-email')
    await nextTick()
    // Edited but not yet blurred: interacted flips, touched does not, so the
    // first keystrokes stay quiet (punish late).
    expect(api.fields('email').interacted).toBe(true)
    expect(api.fields('email').displayState).toBe('idle')
    // Blur runs validateOn:'blur' and completes the gate → the error reveals.
    input.dispatchEvent(new FocusEvent('blur'))
    await new Promise((r) => setTimeout(r, 0))
    expect(api.fields('email').displayState).toBe('error')
    expectProjections(api.fields('email'))
  })

  // Regression: an earlier tab-through must not arm the error for the first
  // real edit. `touched` is sticky after the tab-through's blur, so the gate
  // `interacted && touched` fires the instant `interacted` flips on the first
  // keystroke — scolding the user mid-first-entry. Punish late means the
  // error should wait until the user leaves the field AFTER editing it.
  it('does not fire the error on the first keystroke after an earlier tab-through', async () => {
    const { api, input } = mountInput()

    // 1-3. Tab through without editing: focus then blur. touched flips, but
    // interacted stays false, so the (already failing) field stays quiet.
    input.dispatchEvent(new FocusEvent('focus'))
    input.dispatchEvent(new FocusEvent('blur'))
    await new Promise((r) => setTimeout(r, 0))
    expect(api.fields('email').touched).toBe(true)
    expect(api.fields('email').interacted).toBe(false)
    expect(api.fields('email').displayState).toBe('idle')

    // 4-6. Click back in and type the first character: the user's first real
    // edit. The error should NOT fire yet, since they have not left the field
    // since editing it.
    input.dispatchEvent(new FocusEvent('focus'))
    typeInto(input, 'a')
    await nextTick()
    expect(api.fields('email').interacted).toBe(true)
    expect(api.fields('email').displayState).toBe('idle')
  })
})

describe('container & form.meta rollup — gated, DOM-driven', () => {
  function mountRegistered(
    schema: unknown,
    paths: readonly string[],
    formOpts: Record<string, unknown> = {}
  ): {
    api: FormLike & { register: (p: string) => unknown }
    input: (p: string) => HTMLInputElement
  } {
    const handle: { api?: FormLike & { register: (p: string) => unknown } } = {}
    const Comp = defineComponent({
      setup() {
        const api = useFormV4({
          schema,
          key: `rollup-dom-${Math.random()}`,
          strict: false,
          ...formOpts,
        } as never) as unknown as FormLike & { register: (p: string) => unknown }
        handle.api = api
        return () =>
          h(
            'div',
            paths.map((p) =>
              withDirectives(h('input', { type: 'text', key: p }), [[vRegister, api.register(p)]])
            )
          )
      },
    })
    const app = createApp(Comp).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    apps.push(app)
    if (handle.api === undefined) throw new Error('mountRegistered: api never set')
    const els = Array.from(root.querySelectorAll('input'))
    const byPath = new Map<string, HTMLInputElement>()
    paths.forEach((p, i) => {
      const el = els[i]
      if (!(el instanceof HTMLInputElement)) throw new Error(`mountRegistered: no input for ${p}`)
      byPath.set(p, el)
    })
    const input = (p: string): HTMLInputElement => {
      const el = byPath.get(p)
      if (el === undefined) throw new Error(`mountRegistered: unknown path ${p}`)
      return el
    }
    return { api: handle.api, input }
  }

  function editAndBlur(input: HTMLInputElement, value: string): void {
    input.dispatchEvent(new FocusEvent('focus'))
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new FocusEvent('blur'))
  }

  it('a blurred valid sibling does not surface an untouched sibling error (per-child gate)', async () => {
    const schema = zV4.object({ a: zV4.string().min(1), b: zV4.string().min(1) })
    const { api, input } = mountRegistered(schema, ['a', 'b'], {
      defaultValues: { a: '', b: '' },
      validateOn: 'blur',
    })
    // Edit A to a valid value and blur it: A earns success, its gate opens.
    editAndBlur(input('a'), 'x')
    await new Promise((r) => setTimeout(r, 0))
    // B carries a committed error but was never touched (its gate is closed).
    api.setFieldErrors([{ path: ['b'], message: 'b required', formKey: api.key, code: 'test' }])
    await nextTick()
    expect(api.fields('a').displayState).toBe('success')
    expect(api.fields('b').displayState).toBe('idle')
    // The root must NOT surface B's ungated error just because A opened its gate.
    expect(api.meta.displayState).not.toBe('error')
  })

  it('an untouched optional sibling does not block container success', async () => {
    const schema = zV4.object({
      name: zV4.string().min(1),
      nickname: zV4.string().optional(),
    })
    const { api, input } = mountRegistered(schema, ['name', 'nickname'], {
      defaultValues: { name: '', nickname: '' },
      validateOn: 'blur',
    })
    editAndBlur(input('name'), 'Ada')
    await new Promise((r) => setTimeout(r, 0))
    expect(api.fields('name').displayState).toBe('success')
    expect(api.fields('nickname').displayState).toBe('idle')
    // name is earned and nothing is wrong; the idle optional doesn't hold green back.
    expect(api.meta.displayState).toBe('success')
  })

  it('an intermediate-container error rolls up to the form root once a descendant is blurred (no submit)', async () => {
    const schema = zV4.object({
      pw: zV4.object({ a: zV4.string(), b: zV4.string() }),
    })
    const { api, input } = mountRegistered(schema, ['pw.a', 'pw.b'], {
      defaultValues: { pw: { a: '', b: '' } },
      validateOn: 'blur',
    })
    // Open the intermediate object's gate by blurring one of its leaves...
    editAndBlur(input('pw.a'), 'x')
    await new Promise((r) => setTimeout(r, 0))
    // ...then pin a cross-field error at the object path itself (a non-leaf).
    api.setFieldErrors([{ path: ['pw'], message: 'must match', formKey: api.key, code: 'test' }])
    await nextTick()
    expect(api.fields('pw').displayState).toBe('error')
    // It rolls up to the root even though no LEAF carries the error.
    expect(api.meta.displayState).toBe('error')
  })

  it('a custom getDisplayState at a container is not overridden by the rollup', async () => {
    const neverError: GetDisplayState = () => ({ display: 'idle' })
    const schema = zV4.object({ profile: zV4.object({ name: zV4.string().min(1) }) })
    const form = asForm(
      mountWithApp(() =>
        useFormV4({
          schema,
          key: `rollup-custom-${Math.random()}`,
          strict: false,
          defaultValues: { profile: { name: '' } },
          getDisplayState: neverError,
        } as never)
      )
    )
    await form.handleSubmit(() => {})()
    await nextTick()
    // Empty name fails and the gate is open, but the consumer's reducer owns
    // container verdicts: the default-only rollup override never fires.
    expect(form.fields('profile').displayState).toBe('idle')
    expect(form.fields('profile.name').displayState).toBe('idle')
  })

  describe('with fake timers', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('pending wins over a rolled-up error, then the error lands once validation settles', async () => {
      let resolveB: (ok: boolean) => void = () => {}
      const schema = zV4.object({
        a: zV4.string().min(1),
        b: zV4
          .string()
          .refine((v) => (v === '' ? true : new Promise<boolean>((r) => (resolveB = r))), {
            error: 'bad b',
          }),
      })
      const form = asForm(
        mountWithApp(() =>
          useFormV4({
            schema,
            key: `rollup-pending-${Math.random()}`,
            strict: false,
            defaultValues: { a: '', b: '' },
          } as never)
        )
      )
      // Submit opens every gate and lands a's min(1) error (b='' settles sync).
      await form.handleSubmit(() => {})()
      await nextTick()
      // Park b's refine so the form has a validation in flight.
      form.setValue('b', 'go')
      await nextTick()
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.showDelay)
      // b is validating past the show-delay; pending wins over a's gated error.
      expect(form.meta.displayState).toBe('pending')
      // b settles valid; with nothing in flight, a's gated error rolls up.
      resolveB(true)
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.minVisible)
      expect(form.meta.displayState).toBe('error')
    })

    it('an untouched descendant validating does not flash a container spinner', async () => {
      let resolveB: (ok: boolean) => void = () => {}
      const schema = zV4.object({
        a: zV4.string().min(1),
        b: zV4
          .string()
          .refine((v) => (v === '' ? true : new Promise<boolean>((r) => (resolveB = r))), {
            error: 'bad b',
          }),
      })
      const { api, input } = mountRegistered(schema, ['a', 'b'], {
        defaultValues: { a: '', b: '' },
      })
      // Blur A (opens the container gate) without ever touching B.
      editAndBlur(input('a'), 'x')
      await vi.advanceTimersByTimeAsync(0)
      // Kick B's async validation programmatically — no interaction, gate closed.
      api.setValue('b', 'y')
      await nextTick()
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.showDelay + 50)
      // B would never show its own spinner (gate closed); the container must
      // not show one on its behalf, even though A opened the container gate.
      expect(api.fields('b').displayState).not.toBe('pending')
      expect(api.meta.displayState).not.toBe('pending')
      resolveB(true)
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.minVisible)
    })
  })
})

describe('getDisplayState — type-level guards', () => {
  it('ctx.field / ctx.formMeta omit the derived display keys; reducer returns a DisplayMachine', () => {
    type Field = DisplayCtx['field']
    type Meta = DisplayCtx['formMeta']

    // @ts-expect-error — `displayState` is omitted from ctx.field
    expectTypeOf<Field['displayState']>()
    // @ts-expect-error — `showErrors` is omitted from ctx.field
    expectTypeOf<Field['showErrors']>()
    // @ts-expect-error — `showPending` is omitted from ctx.field
    expectTypeOf<Field['showPending']>()
    // @ts-expect-error — `firstError` is omitted from ctx.field
    expectTypeOf<Field['firstError']>()
    // @ts-expect-error — `displayState` is omitted from ctx.formMeta
    expectTypeOf<Meta['displayState']>()
    // @ts-expect-error — `showSuccess` is omitted from ctx.formMeta
    expectTypeOf<Meta['showSuccess']>()

    // Every other FieldState key still reaches through, so authors keep
    // full IDE access to touched / dirty / valid / errors / path / etc.
    expectTypeOf<Field['touched']>().toEqualTypeOf<boolean>()
    expectTypeOf<Field['valid']>().toEqualTypeOf<boolean>()
    expectTypeOf<Meta['submissionAttempts']>().toEqualTypeOf<number>()

    // The injected clock + episode anchor are on ctx, not on the field.
    expectTypeOf<DisplayCtx['now']>().toEqualTypeOf<number>()
    expectTypeOf<DisplayCtx['validatingSince']>().toEqualTypeOf<number | null>()

    // The reducer's args are (prev: DisplayMachine, ctx: DisplayCtx) and it
    // returns the next DisplayMachine.
    expectTypeOf<Parameters<GetDisplayState>[0]>().toEqualTypeOf<DisplayMachine>()
    expectTypeOf<Parameters<GetDisplayState>[1]>().toEqualTypeOf<DisplayCtx>()
    expectTypeOf<ReturnType<GetDisplayState>>().toEqualTypeOf<DisplayMachine>()
    // `display` carries the same enum the FieldState projection exposes.
    expectTypeOf<DisplayMachine['display']>().toEqualTypeOf<DisplayState>()
  })
})
