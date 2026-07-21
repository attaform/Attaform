// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  computed,
  createApp,
  defineComponent,
  h,
  nextTick,
  ref,
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

/**
 * `form.interact(path?)` — programmatic simulation of a full
 * focus -> edit -> blur over a subtree.
 *
 * The gap it closes: `form.touch()` writes `touched`, but the library
 * default display gate reads `blurredAfterInteraction`
 * (`display-state.ts` `isGateOpen`), which only a blur *following* an
 * edit sets — the asymmetry that keeps a bare tab-through from
 * revealing errors. So a seeded or imported value had no route to the
 * gate short of a form-wide submit, which is too blunt for one row of
 * a field array.
 *
 * Contract:
 *   - flips the whole ladder: touched + interacted +
 *     blurredAfterInteraction, so `isGateOpen` needs no change
 *   - runs the subtree's validation, so a not-yet-validated error is
 *     actually in the store to reveal
 *   - scopes to the path: siblings stay idle, `submissionAttempts`
 *     never moves
 *   - walks schema leaves, so it reaches never-mounted / `v-if`'d-away
 *     fields; the flags are sticky, so they stay revealed on remount
 *   - does NOT write DOM-owned `focused` / `blurred`
 *   - no-op on a disabled form
 *   - returns a promise that resolves once errors are committed and
 *     never rejects
 *
 * Mirrored across both adapters (v3 + v4) so the surface is
 * adapter-agnostic.
 */

const apps: App[] = []
afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function mountWithApp<T>(setup: () => T): T {
  const handle: { captured?: T } = {}
  const App = defineComponent({
    setup() {
      handle.captured = setup()
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  apps.push(app)
  if (handle.captured === undefined) throw new Error('mountWithApp: setup never returned')
  return handle.captured
}

type FieldLike = {
  touched: boolean
  interacted: boolean
  blurredAfterInteraction: boolean
  focused: boolean | null
  blurred: boolean | null
  dirty: boolean
  showErrors: boolean
  showSuccess: boolean
  displayState: string
}

type FormWithInteract = {
  interact: (path?: string | readonly (string | number)[]) => Promise<void>
  touch: (path?: string | readonly (string | number)[]) => void
  fields: (path?: string | readonly (string | number)[]) => FieldLike
  meta: { validating: boolean; submissionAttempts: number; showErrors: boolean }
  setValue: (path: string, value: unknown) => boolean
  values: (path?: string | readonly (string | number)[]) => unknown
  validateAsync: (path?: string) => Promise<unknown>
  reset: () => void
}

function asInteractable<F>(form: F): F & FormWithInteract {
  return form as unknown as F & FormWithInteract
}

// The seed is invalid everywhere, so any leaf that opens its gate
// reveals an error and any leaf that stays shut reads idle.
const SEED = {
  email: 'not-an-email',
  members: [
    { name: '', age: 10 },
    { name: '', age: 12 },
  ],
}

// -----------------------------------------------------------------------------
// Shared behaviour, parameterised by adapter
// -----------------------------------------------------------------------------

type MakeForm = () => FormWithInteract

const ADAPTERS: ReadonlyArray<{ name: string; makeForm: MakeForm }> = [
  {
    name: 'zod-v3',
    makeForm: () => {
      const schema = zV3.object({
        email: zV3.string().email(),
        members: zV3.array(
          zV3.object({ name: zV3.string().min(1), age: zV3.number().int().min(18) })
        ),
      })
      return asInteractable(
        mountWithApp(() =>
          useFormV3({
            schema,
            key: `interact-v3-${Math.random()}`,
            strict: false,
            defaultValues: SEED,
          })
        )
      )
    },
  },
  {
    name: 'zod-v4',
    makeForm: () => {
      const schema = zV4.object({
        email: zV4.string().email(),
        members: zV4.array(
          zV4.object({ name: zV4.string().min(1), age: zV4.number().int().min(18) })
        ),
      })
      return asInteractable(
        mountWithApp(() =>
          useFormV4({
            schema,
            key: `interact-v4-${Math.random()}`,
            strict: false,
            defaultValues: SEED,
          })
        )
      )
    },
  },
]

for (const { name, makeForm } of ADAPTERS) {
  describe(`form.interact — ${name} adapter`, () => {
    it('reveals a leaf that form.touch() leaves idle', async () => {
      const touchOnly = makeForm()
      touchOnly.touch('email')
      await nextTick()
      // The regression this API exists to fix: touched, but still idle.
      expect(touchOnly.fields('email').touched).toBe(true)
      expect(touchOnly.fields('email').showErrors).toBe(false)

      const form = makeForm()
      await form.interact('email')
      await nextTick()
      expect(form.fields('email').showErrors).toBe(true)
    })

    it('flips the whole interaction ladder', async () => {
      const form = makeForm()
      await form.interact('email')
      const f = form.fields('email')
      expect(f.touched).toBe(true)
      expect(f.interacted).toBe(true)
      expect(f.blurredAfterInteraction).toBe(true)
    })

    it('container path reveals every leaf under it, siblings stay idle', async () => {
      const form = makeForm()
      await form.interact(['members', 0])
      await nextTick()
      expect(form.fields(['members', 0, 'name']).showErrors).toBe(true)
      expect(form.fields(['members', 0, 'age']).showErrors).toBe(true)
      // The neighbouring row and the unrelated leaf are untouched —
      // this is the whole point over a form-wide submit.
      expect(form.fields(['members', 1, 'name']).showErrors).toBe(false)
      expect(form.fields(['members', 1, 'age']).showErrors).toBe(false)
      expect(form.fields('email').showErrors).toBe(false)
    })

    it('no-arg reveals every leaf in the form', async () => {
      const form = makeForm()
      await form.interact()
      await nextTick()
      expect(form.fields('email').showErrors).toBe(true)
      expect(form.fields(['members', 0, 'name']).showErrors).toBe(true)
      expect(form.fields(['members', 1, 'age']).showErrors).toBe(true)
    })

    it('segment-array and dotted-string forms agree', async () => {
      const form = makeForm()
      await form.interact('members.0.name')
      await nextTick()
      expect(form.fields(['members', 0, 'name']).showErrors).toBe(true)
      expect(form.fields(['members', 0, 'age']).showErrors).toBe(false)
    })

    it('never bumps submissionAttempts', async () => {
      const form = makeForm()
      await form.interact()
      expect(form.meta.submissionAttempts).toBe(0)
    })

    it('does not modify value', async () => {
      const form = makeForm()
      const before = JSON.stringify(form.values())
      await form.interact()
      expect(JSON.stringify(form.values())).toBe(before)
    })

    it('errors are committed by the time the promise resolves', async () => {
      const form = makeForm()
      await form.interact(['members', 1])
      // No trailing tick: awaiting `interact` alone must be enough.
      expect(form.fields(['members', 1, 'name']).showErrors).toBe(true)
    })

    it('leaves DOM-owned focused / blurred at their no-element null', async () => {
      const form = makeForm()
      await form.interact('email')
      const f = form.fields('email')
      expect(f.focused).toBe(null)
      expect(f.blurred).toBe(null)
    })

    it('is idempotent', async () => {
      const form = makeForm()
      await form.interact('email')
      await form.interact('email')
      await nextTick()
      expect(form.fields('email').showErrors).toBe(true)
      expect(form.fields('email').blurredAfterInteraction).toBe(true)
    })

    it('recovery stays live — fixing the value returns to idle', async () => {
      const form = makeForm()
      await form.interact('email')
      expect(form.fields('email').showErrors).toBe(true)
      form.setValue('email', 'real@example.com')
      await form.validateAsync()
      await nextTick()
      expect(form.fields('email').showErrors).toBe(false)
    })

    it('reset() clears the simulated ladder', async () => {
      const form = makeForm()
      await form.interact()
      expect(form.fields('email').blurredAfterInteraction).toBe(true)
      form.reset()
      await nextTick()
      expect(form.fields('email').blurredAfterInteraction).toBe(false)
      expect(form.fields('email').showErrors).toBe(false)
    })

    it('notifies an aggregate watcher once, not once per leaf', async () => {
      const form = makeForm()
      let runs = 0
      const watcher = computed(() => {
        runs += 1
        return form.fields(['members', 0]).blurredAfterInteraction
      })
      expect(watcher.value).toBe(false)
      const baseline = runs
      await form.interact(['members', 0])
      // Vue may re-evaluate once; more than that means the walk is
      // notifying per-leaf instead of batching.
      expect(watcher.value).toBe(true)
      expect(runs - baseline).toBeLessThanOrEqual(2)
    })

    it('dev-warns when the path resolves no fields', async () => {
      const form = makeForm()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await form.interact('nope.not.a.field')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('form.interact()'))
    })
  })
}

// -----------------------------------------------------------------------------
// Earned success — engagement, not net value change
// -----------------------------------------------------------------------------

describe('form.interact — a valid subtree earns its success check', () => {
  const schema = zV4.object({
    team: zV4.string().min(1, 'Name your team'),
    members: zV4.array(zV4.object({ name: zV4.string().min(1), email: zV4.string().email() })),
  })

  function makeSeeded(): FormWithInteract {
    return asInteractable(
      mountWithApp(() =>
        useFormV4({
          schema,
          key: `interact-success-${Math.random()}`,
          strict: false,
          defaultValues: {
            team: '',
            members: [{ name: 'Ada', email: 'ada@team.dev' }],
          },
        })
      )
    )
  }

  it('greens a seeded-valid row even though it was never edited (dirty stays false)', async () => {
    const form = makeSeeded()
    await form.interact(['members', 0])
    await nextTick()
    const name = form.fields(['members', 0, 'name'])
    // The point: success must not secretly hinge on dirtiness. The row
    // is valid and `interact` declared it engaged, so it greens.
    expect(name.displayState).toBe('success')
    expect(name.showSuccess).toBe(true)
  })

  it('still leaves an un-interacted valid field idle', async () => {
    const form = makeSeeded()
    await form.interact(['members', 0])
    await nextTick()
    // `team` is invalid AND un-interacted; the neighbouring reveal must
    // not drag it into any verdict.
    expect(form.fields('team').displayState).toBe('idle')
  })

  it('does not green the post-submit flood of untouched valid fields', async () => {
    // The regression guard for widening the success rule: a submit opens
    // every gate via submissionAttempts, but a valid field nobody engaged
    // with has neither `dirty` nor `interacted`, so it stays idle.
    const okSchema = zV4.object({ a: zV4.string().min(1), b: zV4.string().min(1) })
    const form = asInteractable(
      mountWithApp(() =>
        useFormV4({
          schema: okSchema,
          key: `interact-flood-${Math.random()}`,
          strict: false,
          defaultValues: { a: 'seeded', b: 'seeded' },
        } as never)
      )
    )
    await form.handleSubmit(() => {})()
    await nextTick()
    expect(form.meta.submissionAttempts).toBeGreaterThan(0)
    expect(form.fields('a').displayState).toBe('idle')
    expect(form.fields('b').displayState).toBe('idle')
  })
})

describe('earned success — a real user who edits and reverts', () => {
  const schema = zV4.object({ email: zV4.string().email('Enter a valid email') })

  it('greens on a net-unchanged edit, because engagement is what is rewarded', async () => {
    const handle: { api?: FormWithInteract } = {}
    const Comp = defineComponent({
      setup() {
        const api = useFormV4({
          schema,
          key: `interact-revert-${Math.random()}`,
          strict: false,
          validateOn: 'blur',
          defaultValues: { email: 'ada@team.dev' },
        } as never) as unknown as FormWithInteract & { register: (p: string) => unknown }
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
    const api = handle.api
    if (api === undefined) throw new Error('api never set')
    const input = root.firstElementChild as HTMLInputElement

    // Type something else, then put the original value back, then leave.
    input.value = 'other@team.dev'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.value = 'ada@team.dev'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('blur', { bubbles: true }))
    for (let i = 0; i < 20; i++) {
      await nextTick()
      if (!api.meta.validating) break
    }
    await nextTick()

    const f = api.fields('email')
    expect(f.interacted).toBe(true)
    expect(f.dirty).toBe(false)
    expect(f.displayState).toBe('success')
  })
})

// -----------------------------------------------------------------------------
// Disabled forms
// -----------------------------------------------------------------------------

describe('form.interact — disabled form', () => {
  const schema = zV4.object({ email: zV4.string().email() })

  it('is a no-op while the form is frozen', async () => {
    const form = asInteractable(
      mountWithApp(() =>
        useFormV4({
          schema,
          key: `interact-disabled-${Math.random()}`,
          strict: false,
          disabled: true,
          defaultValues: { email: 'not-an-email' },
        } as never)
      )
    )
    await form.interact()
    await nextTick()
    expect(form.fields('email').blurredAfterInteraction).toBe(false)
    expect(form.fields('email').showErrors).toBe(false)
  })

  it('stays quiet rather than dev-warning about the empty walk', async () => {
    const form = asInteractable(
      mountWithApp(() =>
        useFormV4({
          schema,
          key: `interact-disabled-quiet-${Math.random()}`,
          strict: false,
          disabled: true,
          defaultValues: { email: 'not-an-email' },
        } as never)
      )
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await form.interact()
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('form.interact()'))
  })
})

// -----------------------------------------------------------------------------
// Stickiness across unmount — the field-array-row-in-a-modal case
// -----------------------------------------------------------------------------

describe('form.interact — survives unmount', () => {
  const schema = zV4.object({ email: zV4.string().email('Enter a valid email') })

  it('a subtree interacted with while mounted stays revealed after it remounts', async () => {
    const shown = ref(true)
    const handle: { api?: FormWithInteract } = {}
    const Comp = defineComponent({
      setup() {
        const api = useFormV4({
          schema,
          key: `interact-remount-${Math.random()}`,
          strict: false,
          defaultValues: { email: 'not-an-email' },
        } as never) as unknown as FormWithInteract & { register: (p: string) => unknown }
        handle.api = api
        return () =>
          shown.value
            ? withDirectives(h('input', { type: 'text' }), [[vRegister, api.register('email')]])
            : h('div')
      },
    })
    const app = createApp(Comp).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    apps.push(app)
    const api = handle.api
    if (api === undefined) throw new Error('api never set')

    // Interact while the row is still mounted, the way a modal would
    // right before it closes.
    await api.interact('email')
    await nextTick()
    expect(api.fields('email').showErrors).toBe(true)

    // Close the modal.
    shown.value = false
    await nextTick()

    // Reopen it — the sticky flags must still have the gate open.
    shown.value = true
    await nextTick()
    await nextTick()
    expect(api.fields('email').blurredAfterInteraction).toBe(true)
    expect(api.fields('email').showErrors).toBe(true)
  })

  it('a real edit + blur after interact() still revalidates', async () => {
    // `interact` sets `interacted`, which is exactly the bit the
    // blur-revalidation path reads to decide whether a blur is the
    // "first interactive blur" that bypasses its value-equality dedup.
    // Having pre-set it must not cause a later genuine edit to be
    // deduped away and leave a stale verdict on screen.
    const handle: { api?: FormWithInteract } = {}
    const Comp = defineComponent({
      setup() {
        const api = useFormV4({
          schema,
          key: `interact-blur-${Math.random()}`,
          strict: false,
          validateOn: 'blur',
          defaultValues: { email: 'not-an-email' },
        } as never) as unknown as FormWithInteract & { register: (p: string) => unknown }
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
    const api = handle.api
    if (api === undefined) throw new Error('api never set')
    const input = root.firstElementChild as HTMLInputElement

    await api.interact('email')
    await nextTick()
    expect(api.fields('email').showErrors).toBe(true)

    // The user now genuinely fixes it and leaves the field.
    input.value = 'real@example.com'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('blur', { bubbles: true }))
    for (let i = 0; i < 20; i++) {
      await nextTick()
      if (!api.meta.validating) break
    }
    await nextTick()
    expect(api.fields('email').showErrors).toBe(false)
  })

  it('forwards through a wizard step handle', async () => {
    // `wizard.activeForm` is a catch-all forwarding proxy and
    // `wizard.forms[key]` hands back the raw form, so `interact` should
    // reach a step's fields with no wizard-side wiring. Pinned because
    // multistep is where per-section reveal matters most.
    const { wizard } = mountWithApp(() => {
      const f = useFormV4({
        schema,
        key: `interact-wizard-${Math.random()}`,
        strict: false,
        defaultValues: { email: 'not-an-email' },
      } as never)
      return { wizard: useWizard({ steps: [f], restore: false, persist: false }) }
    })

    const active = wizard.activeForm as unknown as FormWithInteract
    expect(typeof active.interact).toBe('function')
    await active.interact('email')
    await nextTick()
    expect(active.fields('email').showErrors).toBe(true)
  })

  it('reaches a leaf that was never mounted at all', async () => {
    const form = asInteractable(
      mountWithApp(() =>
        useFormV4({
          schema,
          key: `interact-unmounted-${Math.random()}`,
          strict: false,
          defaultValues: { email: 'not-an-email' },
        })
      )
    )
    // Nothing in this app ever rendered an input for `email`.
    await form.interact('email')
    await nextTick()
    expect(form.fields('email').showErrors).toBe(true)
  })
})
