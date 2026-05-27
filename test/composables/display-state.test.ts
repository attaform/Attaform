// @vitest-environment jsdom
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, withDirectives, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'
import { vRegister } from '../../src/runtime/core/directive'
import { defaultDisplayState } from '../../src'
import type {
  DisplayState,
  FieldState,
  FormMeta,
  GetDisplayState,
  ValidationError,
} from '../../src'

/**
 * `field.displayState` + the `getDisplayState` predicate.
 *
 * `field.displayState` is the single derived verdict on `FieldState`
 * (`'idle' | 'pending' | 'error' | 'success'`); the four `show*`
 * booleans are pure projections of it (`showErrors === (displayState ===
 * 'error')`, and so on). The heuristic `getDisplayState(field, formMeta)`
 * resolves through three tiers:
 *   1. Library default: one timing gate
 *      (`submissionAttempts > 0 || (interacted && touched)`), then
 *      precedence — `validating` → pending; own-path error → error;
 *      earned (`valid && !blank && dirty`) → success; else idle.
 *      Containers (intermediate AND root) only resolve to error on their
 *      own-path errors; leaves always satisfy the own-path filter when
 *      they have errors.
 *   2. `createAttaform({ defaults: { getDisplayState } })`.
 *   3. `useForm({ getDisplayState })`, wins over both above.
 *
 * The predicate runs unconditionally (it must see the no-error states to
 * resolve success / idle / pending). Its args (`field`, `formMeta`) are
 * `Omit`'d of the derived `displayState` / `show*` / `firstError` keys at
 * BOTH the type and runtime level, so a self-referential predicate is
 * impossible regardless of language (TS or JS).
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
  meta: { submissionAttempts: number; submitting: boolean; displayState: DisplayState }
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

    describe('default heuristic — container', () => {
      it('row-level container with ONLY descendant errors does not duplicate them (idle, not error)', async () => {
        const form = makeForm()
        injectError(form, ['users', 0, 'label'], 'label required')
        form.touch(['users', 0, 'label'])
        form.setValue('users.0.label', 'x')
        await nextTick()
        const row = form.fields('users.0')
        expect(row.errors.length).toBeGreaterThan(0)
        // Descendant errors are rendered by the descendant fields; the
        // container's own-path filter keeps it out of 'error' to avoid
        // UI duplication.
        expect(row.displayState).not.toBe('error')
        expect(row.showErrors).toBe(false)
        expectProjections(row)
      })

      it('container shows nothing when descendants have errors and timing conditions unmet', async () => {
        const form = makeForm()
        injectError(form, ['users', 0, 'label'], 'label required')
        await nextTick()
        const row = form.fields('users.0')
        expect(row.errors.length).toBeGreaterThan(0)
        expect(row.showErrors).toBe(false)
        expectProjections(row)
      })

      it('row-level container with its OWN error surfaces it after timing gate', async () => {
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

    describe('form.meta.displayState', () => {
      it('stays out of error when only descendant (leaf) errors exist (the leaves render their own)', async () => {
        const form = makeForm()
        injectError(form, ['email'], 'email required')
        expect(form.meta.displayState).toBe('idle')
        await form.handleSubmit(() => {})()
        await nextTick()
        // form.meta.displayState === rootFieldState.displayState with the
        // own-path filter applied at root. Leaf errors don't surface here
        // so the form banner can't duplicate them. Aggregate banners
        // should bind to form.meta.errorCount > 0 instead.
        expect(form.meta.displayState).not.toBe('error')
      })

      // Affirmative "root-level error fires form.meta error" coverage
      // lives in the cross-cutting synthetic test below; the integration
      // path needs an object-level schema refine to land an error at the
      // root path [], which isn't worth wiring per-adapter here.
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

    // A predicate that surfaces errors purely on touch, ignoring the
    // submit arm of the default gate.
    const touchOnly: GetDisplayState = (field) =>
      field.errors.length > 0 && field.touched === true ? 'error' : 'idle'
    // "Always show when errors exist" — the eager predicate.
    const eager: GetDisplayState = (field) => (field.errors.length > 0 ? 'error' : 'idle')
    // "Never surface anything."
    const silent: GetDisplayState = () => 'idle'

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
          getDisplayState: (field, formMeta) => {
            for (const k of derivedKeys) {
              if (k in (field as object)) probe.fieldPresent.push(k)
              if (k in (formMeta as object)) probe.formMetaPresent.push(k)
            }
            return 'error'
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

  it('defaultDisplayState is publicly exported and arity-2', () => {
    expect(typeof defaultDisplayState).toBe('function')
    expect(defaultDisplayState.length).toBe(2)
  })

  it('defaultDisplayState composes inside a layered predicate', async () => {
    const layered: GetDisplayState = (field, formMeta) =>
      field.path[0] === 'urgent' ? 'error' : defaultDisplayState(field, formMeta)

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

  it('defaultDisplayState tracks the documented heuristic on synthetic inputs', () => {
    const ownErrorField = {
      errors: [{ path: ['x'], message: 'm', formKey: 'k', code: 'c' }],
      touched: false,
      interacted: false,
      focused: false,
      validating: false,
      valid: false,
      path: ['x'],
    } as unknown as Omit<FieldState, 'displayState' | 'showErrors' | 'firstError'>
    const baseMeta = {
      submissionAttempts: 0,
    } as unknown as Omit<FormMeta, 'displayState' | 'showErrors' | 'firstError'>

    // Gate closed (no submit, not touched): idle even with an own error.
    expect(defaultDisplayState(ownErrorField, baseMeta)).toBe('idle')

    // Edited and blurred (interacted + touched), own error → error,
    // regardless of dirty.
    expect(
      defaultDisplayState(
        { ...ownErrorField, interacted: true, touched: true, focused: false },
        baseMeta
      )
    ).toBe('error')

    // Re-focused after engaging (interacted + touched + focused): the gate
    // carries no not-focused term, so it stays open and the error persists
    // through the re-focus instead of vanishing mid-fix.
    expect(
      defaultDisplayState(
        { ...ownErrorField, interacted: true, touched: true, focused: true },
        baseMeta
      )
    ).toBe('error')

    // Tabbed through without editing (touched but NOT interacted): a clean
    // tab-through never engages the gate → idle.
    expect(
      defaultDisplayState({ ...ownErrorField, interacted: false, touched: true }, baseMeta)
    ).toBe('idle')

    // First keystrokes, not yet blurred (interacted but NOT touched): the
    // error stays quiet mid-entry until the user leaves the field → idle.
    expect(
      defaultDisplayState(
        { ...ownErrorField, interacted: true, touched: false, focused: true },
        baseMeta
      )
    ).toBe('idle')

    // Currently validating (gate open via interacted + touched): pending
    // wins over the stale error verdict.
    expect(
      defaultDisplayState(
        { ...ownErrorField, interacted: true, touched: true, focused: false, validating: true },
        baseMeta
      )
    ).toBe('pending')
    expect(
      defaultDisplayState({ ...ownErrorField, validating: true }, {
        ...baseMeta,
        submissionAttempts: 1,
      } as typeof baseMeta)
    ).toBe('pending')

    // After first submit attempt: error regardless of touched/focused.
    expect(
      defaultDisplayState(ownErrorField, {
        ...baseMeta,
        submissionAttempts: 1,
      } as typeof baseMeta)
    ).toBe('error')

    // Post-submit aggression: focused + untouched + own error still
    // resolves to error. The user signalled they're done editing by
    // hitting submit; transient mid-edit hiding no longer applies.
    expect(
      defaultDisplayState({ ...ownErrorField, touched: false, focused: true }, {
        ...baseMeta,
        submissionAttempts: 1,
      } as typeof baseMeta)
    ).toBe('error')

    // No error + valid + earned (dirty + non-blank) + gate open → success.
    const validField = {
      errors: [],
      touched: true,
      interacted: true,
      focused: false,
      validating: false,
      valid: true,
      blank: false,
      dirty: true,
      path: ['x'],
    } as unknown as Omit<FieldState, 'displayState' | 'showErrors' | 'firstError'>
    expect(defaultDisplayState(validField, baseMeta)).toBe('success')

    // No error + NOT yet valid (e.g. async first pass pending) + gate open → idle.
    expect(defaultDisplayState({ ...validField, valid: false }, baseMeta)).toBe('idle')

    // Valid but UNEARNED: success is withheld so the green check only ever
    // means the user put valid content there themselves.
    //   Blank (an empty optional field that happens to pass) → idle.
    expect(defaultDisplayState({ ...validField, blank: true }, baseMeta)).toBe('idle')
    //   Not dirty (a pre-filled field merely tabbed through) → idle.
    expect(defaultDisplayState({ ...validField, dirty: false }, baseMeta)).toBe('idle')
    //   The post-submit flood: a valid, non-blank, but untouched field
    //   stays idle even with the gate forced open by a submit attempt.
    expect(
      defaultDisplayState({ ...validField, dirty: false }, {
        ...baseMeta,
        submissionAttempts: 1,
      } as typeof baseMeta)
    ).toBe('idle')

    // Container with ONLY descendant errors: idle even after submit. The
    // own-path filter blocks the container from resolving to error and
    // duplicating leaf-rendered messages.
    const containerOnlyDescendantErrors = {
      errors: [{ path: ['x', 'y'], message: 'm', formKey: 'k', code: 'c' }],
      touched: true,
      focused: false,
      validating: false,
      valid: false,
      path: ['x'],
    } as unknown as Omit<FieldState, 'displayState' | 'showErrors' | 'firstError'>
    expect(
      defaultDisplayState(containerOnlyDescendantErrors, {
        ...baseMeta,
        submissionAttempts: 1,
      } as typeof baseMeta)
    ).toBe('idle')
  })
})

describe('getDisplayState — pending during validating', () => {
  /**
   * Pending contract: when a verdict is in flight, `field.errors`
   * retains the stale entry (no flicker to empty) under stale-while-
   * revalidate, but `field.displayState` resolves to `'pending'` because
   * the application is recomputing and a spinner narrates the current
   * state honestly. The error returns the moment validation completes if
   * the new verdict still has issues.
   */
  it('async refine: pending during validation, error when verdict lands', async () => {
    let resolveValidation: (ok: boolean) => void = () => {}
    const schema = zV4.object({
      email: zV4.string().refine(
        (val) => {
          // Reject empty; for any non-empty value, await the
          // externally-resolved gate so the test can observe the
          // mid-validation window.
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
          key: `pending-validating-${Math.random()}`,
          strict: false,
          defaultValues: { email: '' },
        } as never)
      )
    )

    // Touch + submit so the timing gate is open. Mount-time validation
    // produces a verdict on the empty string ("invalid email").
    form.touch('email')
    await form.handleSubmit(() => {})()
    await nextTick()
    expect(form.fields('email').errors.length).toBeGreaterThan(0)
    expect(form.fields('email').displayState).toBe('error')

    // Edit to a non-empty value. Change-mode validation schedules; the
    // async refine pauses on the externally-resolved gate.
    form.setValue('email', 'a@b.c')
    await nextTick()
    expect(form.fields('email').validating).toBe(true)
    // SWR: the stale error stays in `errors`, so consumers reading the
    // store directly still see something while the new verdict resolves.
    expect(form.fields('email').errors.length).toBeGreaterThan(0)
    // But displayState resolves to 'pending' during the recompute window.
    expect(form.fields('email').displayState).toBe('pending')
    expect(form.fields('email').showPending).toBe(true)
    expect(form.fields('email').showErrors).toBe(false)

    // Resolve the validation as STILL invalid. The new verdict lands,
    // validating returns to false, displayState flips back to 'error'.
    resolveValidation(false)
    await new Promise((r) => setTimeout(r, 0))
    expect(form.fields('email').validating).toBe(false)
    expect(form.fields('email').errors.length).toBeGreaterThan(0)
    expect(form.fields('email').displayState).toBe('error')
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
})

describe('getDisplayState — type-level guards', () => {
  it('predicate signature omits the derived display keys on field and formMeta args', () => {
    type Field = Parameters<GetDisplayState>[0]
    type Meta = Parameters<GetDisplayState>[1]

    // @ts-expect-error — `displayState` is omitted from the predicate's field arg
    expectTypeOf<Field['displayState']>()
    // @ts-expect-error — `showErrors` is omitted from the predicate's field arg
    expectTypeOf<Field['showErrors']>()
    // @ts-expect-error — `showPending` is omitted from the predicate's field arg
    expectTypeOf<Field['showPending']>()
    // @ts-expect-error — `firstError` is omitted from the predicate's field arg
    expectTypeOf<Field['firstError']>()
    // @ts-expect-error — `displayState` is omitted from the predicate's formMeta arg
    expectTypeOf<Meta['displayState']>()
    // @ts-expect-error — `showSuccess` is omitted from the predicate's formMeta arg
    expectTypeOf<Meta['showSuccess']>()

    // Every other FieldState key still reaches through, so authors keep
    // full IDE access to touched / dirty / valid / errors / path / etc.
    expectTypeOf<Field['touched']>().toEqualTypeOf<boolean>()
    expectTypeOf<Field['valid']>().toEqualTypeOf<boolean>()
    expectTypeOf<Meta['submissionAttempts']>().toEqualTypeOf<number>()

    // The predicate returns the DisplayState enum.
    expectTypeOf<ReturnType<GetDisplayState>>().toEqualTypeOf<DisplayState>()
  })
})
