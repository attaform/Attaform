// @vitest-environment jsdom
import { describe, expect, expectTypeOf, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { historyPlugin } from '../../src/history'
import { createAttaform } from '../../src/runtime/core/plugin'
import type {
  DisplayState,
  UseFormReturnType,
  ValidationError,
} from '../../src/runtime/types/types-api'

/**
 * Pins the public surface of `useForm()`'s return value against
 * accidental drift. Two failure modes this guards against:
 *
 *   1. A property silently moves between `api`, `api.meta`, and
 *      `api.history` — types vs. runtime drift.
 *   2. A method is introduced/removed/renamed without the surface
 *      contract being updated.
 *
 * The architecture:
 *
 *   ┌─ Lives directly on `api` ───────────────────────────────┐
 *   │  setValue, handleSubmit, parse, reset,                  │
 *   │  resetField, register, fields, errors, values, key,     │
 *   │  meta, history, …                                       │
 *   └─────────────────────────────────────────────────────────┘
 *
 *   ┌─ Lives on `api.meta` ───────────────────────────────────┐
 *   │  dirty, valid, submitting, submissionAttempts, submitError,    │
 *   │  showErrors, firstError, …                              │
 *   └─────────────────────────────────────────────────────────┘
 *
 *   ┌─ Lives on `api.history` ────────────────────────────────┐
 *   │  undo(), redo(), clear(), canUndo, canRedo, size        │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Form-level actions and field accessors sit at the top level;
 * form-level status flags sit on `meta`; undo/redo lives entirely
 * on `history`.
 *
 * Absence checks use type-level assertions (`@ts-expect-error`) rather
 * than runtime `=== undefined`, because the FieldState proxy returns a
 * stub callable for unknown property reads (a separate bug — see
 * round-2 chaos probe). The compile-time check is the canonical surface
 * contract; the runtime check is subordinate.
 */

const schema = z.object({
  name: z.string(),
  email: z.string().email(),
})

type Api = UseFormReturnType<z.output<typeof schema>>

function mountForm(): { app: App; api: Api } {
  const handle: { api?: Api } = {}
  const App = defineComponent({
    setup() {
      handle.api = useForm({
        schema,
        key: `surface-contract-${Math.random().toString(36).slice(2)}`,
        history: historyPlugin(),
        defaultValues: { name: '', email: '' },
      })
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.mount(document.createElement('div'))
  return { app, api: handle.api as Api }
}

describe('API surface contract — actions on `api`, status on `api.meta`, history on `api.history`', () => {
  it('undo/redo + flags live on `api.history` — both methods and reactive flags', () => {
    const { api } = mountForm()

    // Runtime — methods are functions, flags are unwrapped primitives
    // (the `readonly(reactive({...}))` bundle auto-unwraps ComputedRef
    // fields on access).
    expect(typeof api.history.undo).toBe('function')
    expect(typeof api.history.redo).toBe('function')
    expect(typeof api.history.clear).toBe('function')
    expect(typeof api.history.canUndo).toBe('boolean')
    expect(typeof api.history.canRedo).toBe('boolean')
    expect(typeof api.history.size).toBe('number')

    // Type-level pin — same shape.
    expectTypeOf(api.history.undo).toEqualTypeOf<() => boolean>()
    expectTypeOf(api.history.redo).toEqualTypeOf<() => boolean>()
    expectTypeOf(api.history.clear).toEqualTypeOf<() => void>()
    expectTypeOf(api.history.canUndo).toEqualTypeOf<boolean>()
    expectTypeOf(api.history.canRedo).toEqualTypeOf<boolean>()
    expectTypeOf(api.history.size).toEqualTypeOf<number>()
  })

  it('history surface does NOT leak onto `api` or `api.meta` (consolidation is exclusive)', () => {
    const { api } = mountForm()

    // The pre-consolidation addresses must not resurrect. If a future
    // change accidentally restores them (e.g. by re-adding `undo` to
    // `UseFormReturnType`), the @ts-expect-error stops being needed and
    // the `Unused @ts-expect-error directive` lint trips, forcing the
    // contract update.
    // @ts-expect-error api.undo lives at api.history.undo now
    void api.undo
    // @ts-expect-error api.redo lives at api.history.redo now
    void api.redo
    // @ts-expect-error api.canUndo lives at api.history.canUndo now
    void api.canUndo
    // @ts-expect-error api.canRedo lives at api.history.canRedo now
    void api.canRedo
    // @ts-expect-error api.historySize lives at api.history.size now
    void api.historySize
    // @ts-expect-error api.meta.canUndo lives at api.history.canUndo now
    void api.meta.canUndo
    // @ts-expect-error api.meta.canRedo lives at api.history.canRedo now
    void api.meta.canRedo
    // @ts-expect-error api.meta.historySize lives at api.history.size now
    void api.meta.historySize
  })

  it('mutating actions live directly on `api`', () => {
    const { api } = mountForm()

    expect(typeof api.setValue).toBe('function')
    expect(typeof api.reset).toBe('function')
    expect(typeof api.resetField).toBe('function')
    expect(typeof api.handleSubmit).toBe('function')
    expect(typeof api.parse).toBe('function')
    // validateAsync was absorbed by parse(path?, { commit: true }).
    expect('validateAsync' in api).toBe(false)
    // The interaction-flag pair. They are siblings on purpose:
    // `touch` writes the descriptive `touched` flag, `interact`
    // simulates a full focus -> edit -> blur and drives the default
    // display gate. Neither may quietly migrate onto `meta`.
    expect(typeof api.touch).toBe('function')
    expect(typeof api.interact).toBe('function')
  })

  it('`interact` returns an awaitable that never rejects', async () => {
    const { api } = mountForm()

    const returned = api.interact('email')
    expect(typeof returned.then).toBe('function')
    await expect(returned).resolves.toBeUndefined()
    // An unresolvable path must still settle rather than throw. Uses
    // the segment-array arm, which is deliberately loose — the
    // `FlatPath` arm rejects a bogus dotted path at compile time.
    await expect(api.interact(['not', 'a', 'real', 'path'])).resolves.toBeUndefined()
  })

  it('form-level reactive flags live on `api.meta` (not `api`)', () => {
    const { api } = mountForm()

    // Status flags — the canonical `meta` surface.
    expect(typeof api.meta.dirty).toBe('boolean')
    expect(typeof api.meta.valid).toBe('boolean')
    expect(typeof api.meta.submitting).toBe('boolean')
    expect(typeof api.meta.submissionAttempts).toBe('number')

    // displayState + the show* projections + firstError on the rolled-up meta.
    expect(['idle', 'pending', 'error', 'success']).toContain(api.meta.displayState)
    expect(typeof api.meta.showErrors).toBe('boolean')
    expect(typeof api.meta.showPending).toBe('boolean')
    expect(typeof api.meta.showSuccess).toBe('boolean')
    expect(typeof api.meta.showIdle).toBe('boolean')
    expect(['undefined', 'object']).toContain(typeof api.meta.firstError)
    // Own-bucket accessors: the exact-path counterpart to errors /
    // firstError. On meta these read the root [] bucket (the banner).
    expect(Array.isArray(api.meta.ownErrors)).toBe(true)
    expect(['undefined', 'object']).toContain(typeof api.meta.firstOwnError)
    expectTypeOf(api.meta.ownErrors).toEqualTypeOf<readonly ValidationError[]>()
    expectTypeOf(api.meta.firstOwnError).toEqualTypeOf<ValidationError | undefined>()
    expect(typeof api.meta.id).toBe('string')
    expect(api.meta.aria.errorId).toBe(`${api.meta.id}-error`)
    // The root is not an array element, so its identity key is empty.
    expect(api.meta.key).toBe('')
    expectTypeOf(api.meta.key).toEqualTypeOf<string>()

    // Type-level absence at the top level.
    // @ts-expect-error api.dirty must NOT exist; use api.meta.dirty
    void api.dirty
    // @ts-expect-error api.valid must NOT exist; use api.meta.valid
    void api.valid
    // @ts-expect-error api.submitting must NOT exist; use api.meta.submitting
    void api.submitting
    // @ts-expect-error api.submissionAttempts must NOT exist; use api.meta.submissionAttempts
    void api.submissionAttempts
  })

  it('field accessors live directly on `api`', () => {
    const { api } = mountForm()

    // The three surface ROOTS are callable proxies — `api.fields(path)`
    // / `api.errors(path)` / `api.values(path)` is the aggregate API, so
    // `typeof` is 'function' at the root and only at the root.
    expect(typeof api.fields).toBe('function')
    expect(typeof api.errors).toBe('function')
    expect(typeof api.values).toBe('function')
    expect(typeof api.register).toBe('function')
    expect(typeof api.key).toBe('string')

    // Below the root, nodes are non-callable: a leaf FieldState view is
    // a plain object (`api.fields.email()` would throw), so `typeof` is
    // 'object', not 'function'.
    expect(typeof api.fields.email).toBe('object')
    expect(typeof api.values.email).toBe('string')
  })

  it('per-field state surfaces status directly on the FieldState', () => {
    const { api } = mountForm()
    const emailField = api.fields.email

    expect(typeof emailField.dirty).toBe('boolean')
    expect(typeof emailField.valid).toBe('boolean')
    expect(typeof emailField.touched).toBe('boolean')
    expect(typeof emailField.interacted).toBe('boolean')
    expect(typeof emailField.blurredAfterInteraction).toBe('boolean')
    expect(['idle', 'pending', 'error', 'success']).toContain(emailField.displayState)
    expect(typeof emailField.showErrors).toBe('boolean')
    expect(typeof emailField.showPending).toBe('boolean')
    expect(typeof emailField.showSuccess).toBe('boolean')
    expect(typeof emailField.showIdle).toBe('boolean')

    // Error accessors: subtree (errors / firstError) and exact-path
    // (ownErrors / firstOwnError). A leaf has no descendants, so its own
    // bucket IS its subtree — the same array reference.
    expect(Array.isArray(emailField.errors)).toBe(true)
    expect(Array.isArray(emailField.ownErrors)).toBe(true)
    expect(['undefined', 'object']).toContain(typeof emailField.firstError)
    expect(['undefined', 'object']).toContain(typeof emailField.firstOwnError)
    expect(emailField.ownErrors).toBe(emailField.errors)

    // Stable id + aria satellites for accessibility wiring.
    expect(typeof emailField.id).toBe('string')
    expect(emailField.id.length).toBeGreaterThan(0)
    expect(emailField.aria.errorId).toBe(`${emailField.id}-error`)
    expect(emailField.aria.descriptionId).toBe(`${emailField.id}-description`)
    // A scalar leaf is not an array element, so its identity key is empty.
    expect(emailField.key).toBe('')

    expectTypeOf(emailField.dirty).toEqualTypeOf<boolean>()
    expectTypeOf(emailField.valid).toEqualTypeOf<boolean>()
    expectTypeOf(emailField.touched).toEqualTypeOf<boolean>()
    expectTypeOf(emailField.interacted).toEqualTypeOf<boolean>()
    expectTypeOf(emailField.blurredAfterInteraction).toEqualTypeOf<boolean>()
    expectTypeOf(emailField.displayState).toEqualTypeOf<DisplayState>()
    expectTypeOf(emailField.showErrors).toEqualTypeOf<boolean>()
    expectTypeOf(emailField.showPending).toEqualTypeOf<boolean>()
    expectTypeOf(emailField.showSuccess).toEqualTypeOf<boolean>()
    expectTypeOf(emailField.showIdle).toEqualTypeOf<boolean>()
    expectTypeOf(emailField.ownErrors).toEqualTypeOf<readonly ValidationError[]>()
    expectTypeOf(emailField.firstOwnError).toEqualTypeOf<ValidationError | undefined>()
    expectTypeOf(emailField.id).toEqualTypeOf<string>()
    expectTypeOf(emailField.key).toEqualTypeOf<string>()
  })

  it('per-field history does NOT exist today (pinned for the consolidation question)', () => {
    const { api } = mountForm()
    const emailField = api.fields.email

    // Type-level absence — future per-field history (e.g.
    // `api.fields.email.history.{undo, redo, canUndo}`) is meant to
    // break the directives below intentionally.
    // @ts-expect-error per-field history is not part of the contract today
    void emailField.history
    // @ts-expect-error per-field undo is not part of the contract today
    void emailField.undo
    // @ts-expect-error per-field redo is not part of the contract today
    void emailField.redo

    // Note: runtime `emailField.undo` returns `[Function undefined]`
    // because the FieldState proxy stubs unknown property reads as
    // callables (separate bug — see round-2 chaos probe). The
    // type-level absence above is the canonical contract; runtime
    // probing here would fail-positive.
  })
})
