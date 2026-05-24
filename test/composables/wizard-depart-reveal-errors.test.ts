// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * `form.meta.departAttempts` + wizard navigation reveal contract under
 * the v2 list-based wizard:
 *
 *  - The counter lives on `form.meta` alongside `submissionAttempts`,
 *    type-visible to consumers; both surface on the readonly meta
 *    proxy.
 *  - Wizard navigation (`next`, `back`, `goTo`) bumps the departing
 *    form's counter on real departures only — early-return guards
 *    (back from first, same-key goTo, next at terminal, unknown
 *    goTo) leave it alone. `next()` is pure positional navigation
 *    in v2; it always bumps the active form on success, never
 *    validates.
 *  - `submissionAttempts` and `departAttempts` are accounting-distinct:
 *    `wizard.handleSubmit` moves submissionAttempts on the relevant
 *    forms (intermediate → active only; final → all). Wizard
 *    navigation moves departAttempts. `form.validate()` moves
 *    neither.
 *  - The depart arm of `defaultShouldShowErrors` reveals every error
 *    on a form once it has been departed — the user-facing payoff
 *    that motivated the change.
 *  - `form.reset()` zeros departAttempts alongside the rest of the
 *    submission lifecycle.
 */

const strictSchema = z.object({
  email: z.email('Enter a valid email'),
  password: z.string().min(8, 'At least 8 characters'),
})

const permissiveSchema = z.object({
  name: z.string().optional(),
})

function mountHarness<R>(setup: () => R): { app: App; result: R } {
  const handle: { result?: R } = {}
  const App = defineComponent({
    setup() {
      handle.result = setup()
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.config.warnHandler = () => {}
  app.config.errorHandler = () => {}
  app.mount(document.createElement('div'))
  return { app, result: handle.result as R }
}

describe('wizard navigation bumps form.meta.departAttempts', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('wizard.next() bumps departAttempts on the departing form', async () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: strictSchema, key: 'dep-1-a' })
      const b = useForm({ schema: permissiveSchema, key: 'dep-1-b' })
      const wizard = useWizard({ steps: [a, b], restore: false, persist: false })
      return { a, b, wizard }
    })
    apps.push(app)
    expect(result.a.meta.departAttempts).toBe(0)
    expect(result.a.meta.submissionAttempts).toBe(0)
    await result.wizard.next()
    expect(result.wizard.currentStep).toBe('dep-1-b')
    expect(result.a.meta.departAttempts).toBe(1)
    expect(result.a.meta.submissionAttempts).toBe(0)
  })

  it('wizard.next() at the final step does NOT bump (no destination)', async () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: permissiveSchema, key: 'dep-3-a' })
      const wizard = useWizard({ steps: [a], restore: false, persist: false })
      return { a, wizard }
    })
    apps.push(app)
    await result.wizard.next()
    expect(result.a.meta.departAttempts).toBe(0)
  })

  it('wizard.back() bumps the departing form on real backward navigation', async () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: permissiveSchema, key: 'dep-4-a' })
      const b = useForm({ schema: permissiveSchema, key: 'dep-4-b' })
      const wizard = useWizard({ steps: [a, b], restore: false, persist: false })
      return { a, b, wizard }
    })
    apps.push(app)
    await result.wizard.next()
    expect(result.wizard.currentStep).toBe('dep-4-b')
    const beforeA = result.a.meta.departAttempts
    const beforeB = result.b.meta.departAttempts
    result.wizard.back()
    expect(result.wizard.currentStep).toBe('dep-4-a')
    expect(result.b.meta.departAttempts).toBe(beforeB + 1)
    expect(result.a.meta.departAttempts).toBe(beforeA)
  })

  it('wizard.back() from the first step is a no-op and does NOT bump', () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: permissiveSchema, key: 'dep-5-a' })
      const b = useForm({ schema: permissiveSchema, key: 'dep-5-b' })
      const wizard = useWizard({ steps: [a, b], restore: false, persist: false })
      return { a, wizard }
    })
    apps.push(app)
    expect(result.wizard.currentStep).toBe('dep-5-a')
    result.wizard.back()
    expect(result.wizard.currentStep).toBe('dep-5-a')
    expect(result.a.meta.departAttempts).toBe(0)
  })

  it('wizard.goTo(otherKey) bumps the departing form', () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: permissiveSchema, key: 'dep-6-a' })
      const b = useForm({ schema: permissiveSchema, key: 'dep-6-b' })
      const c = useForm({ schema: permissiveSchema, key: 'dep-6-c' })
      const wizard = useWizard({ steps: [a, b, c], restore: false, persist: false })
      return { a, b, c, wizard }
    })
    apps.push(app)
    result.wizard.goTo('dep-6-c')
    expect(result.wizard.currentStep).toBe('dep-6-c')
    expect(result.a.meta.departAttempts).toBe(1)
    expect(result.b.meta.departAttempts).toBe(0)
    expect(result.c.meta.departAttempts).toBe(0)
  })

  it('wizard.goTo(currentKey) is a no-op and does NOT bump', () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: permissiveSchema, key: 'dep-7-a' })
      const b = useForm({ schema: permissiveSchema, key: 'dep-7-b' })
      const wizard = useWizard({ steps: [a, b], restore: false, persist: false })
      return { a, wizard }
    })
    apps.push(app)
    result.wizard.goTo('dep-7-a')
    expect(result.a.meta.departAttempts).toBe(0)
  })

  it('wizard.goTo(unknownKey) dev-warns and does NOT bump', () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: permissiveSchema, key: 'dep-8-a' })
      const b = useForm({ schema: permissiveSchema, key: 'dep-8-b' })
      const wizard = useWizard({ steps: [a, b], restore: false, persist: false })
      return { a, wizard }
    })
    apps.push(app)
    result.wizard.goTo('dep-8-unknown')
    expect(result.a.meta.departAttempts).toBe(0)
  })
})

describe('departAttempts and submissionAttempts stay accounting-distinct', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('failed intermediate handleSubmit bumps submissionAttempts but NOT departAttempts', async () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: strictSchema, key: 'acc-1-a' })
      const b = useForm({ schema: strictSchema, key: 'acc-1-b' })
      const wizard = useWizard({ steps: [a, b], restore: false, persist: false })
      return { a, b, wizard }
    })
    apps.push(app)
    const onSubmit = result.wizard.handleSubmit(async () => {})
    await onSubmit()
    expect(result.wizard.currentStep).toBe('acc-1-a')
    expect(result.a.meta.submissionAttempts).toBeGreaterThan(0)
    expect(result.b.meta.submissionAttempts).toBe(0)
    expect(result.a.meta.departAttempts).toBe(0)
    expect(result.b.meta.departAttempts).toBe(0)
  })

  it('form.validate() leaves both counters at 0', async () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: strictSchema, key: 'acc-2-a' })
      const status = a.validate()
      void status.value
      return { a }
    })
    apps.push(app)
    await nextTick()
    expect(result.a.meta.submissionAttempts).toBe(0)
    expect(result.a.meta.departAttempts).toBe(0)
  })
})

describe('defaultShouldShowErrors reveals on the depart arm', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('forward depart from an untouched form leaves errors hidden (touched gate)', async () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: strictSchema, key: 'show-1-a' })
      const b = useForm({ schema: permissiveSchema, key: 'show-1-b' })
      const wizard = useWizard({ steps: [a, b], restore: false, persist: false })
      return { a, wizard }
    })
    apps.push(app)
    expect(result.a.meta.touched).toBe(false)
    expect(result.a.fields.email.showErrors).toBe(false)
    expect(result.a.fields.password.showErrors).toBe(false)
    await result.wizard.next()
    expect(result.a.meta.departAttempts).toBe(1)
    expect(result.a.meta.touched).toBe(false)
    expect(result.a.fields.email.showErrors).toBe(false)
    expect(result.a.fields.password.showErrors).toBe(false)
  })

  it('forward depart from a touched form reveals every own-path error — including untouched siblings', async () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: strictSchema, key: 'show-2-a' })
      const b = useForm({ schema: permissiveSchema, key: 'show-2-b' })
      const wizard = useWizard({ steps: [a, b], restore: false, persist: false })
      return { a, wizard }
    })
    apps.push(app)
    result.a.touch(['email'])
    expect(result.a.fields.email.touched).toBe(true)
    expect(result.a.fields.password.touched).toBe(false)
    expect(result.a.meta.touched).toBe(true)
    await result.wizard.next()
    expect(result.a.meta.departAttempts).toBe(1)
    expect(result.a.fields.email.showErrors).toBe(true)
    expect(result.a.fields.password.showErrors).toBe(true)
  })

  it('wizard.back() from a touched invalid step reveals every error — including untouched siblings', async () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({
        schema: strictSchema,
        key: 'show-3-a',
        defaultValues: { email: 'a@a.com', password: 'longenough' },
      })
      const b = useForm({ schema: strictSchema, key: 'show-3-b' })
      const wizard = useWizard({
        steps: [a, b],
        restore: () => ({ step: 'show-3-b' }),
        persist: false,
      })
      return { a, b, wizard }
    })
    apps.push(app)
    expect(result.wizard.currentStep).toBe('show-3-b')
    result.b.touch(['email'])
    expect(result.b.fields.password.touched).toBe(false)
    expect(result.b.fields.password.showErrors).toBe(false)
    result.wizard.back()
    expect(result.b.meta.departAttempts).toBe(1)
    expect(result.b.fields.email.showErrors).toBe(true)
    expect(result.b.fields.password.showErrors).toBe(true)
  })

  it('wizard.back() from an untouched step leaves its errors hidden', async () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({
        schema: strictSchema,
        key: 'show-4-a',
        defaultValues: { email: 'a@a.com', password: 'longenough' },
      })
      const b = useForm({ schema: strictSchema, key: 'show-4-b' })
      const wizard = useWizard({
        steps: [a, b],
        restore: () => ({ step: 'show-4-b' }),
        persist: false,
      })
      return { b, wizard }
    })
    apps.push(app)
    expect(result.wizard.currentStep).toBe('show-4-b')
    expect(result.b.meta.touched).toBe(false)
    result.wizard.back()
    expect(result.b.meta.departAttempts).toBe(1)
    expect(result.b.fields.email.showErrors).toBe(false)
    expect(result.b.fields.password.showErrors).toBe(false)
  })
})

describe('form.reset() clears departAttempts', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('zeros departAttempts alongside the rest of the submission lifecycle', async () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: strictSchema, key: 'rst-1-a' })
      const b = useForm({ schema: permissiveSchema, key: 'rst-1-b' })
      const wizard = useWizard({ steps: [a, b], restore: false, persist: false })
      return { a, wizard }
    })
    apps.push(app)
    await result.wizard.next()
    expect(result.a.meta.departAttempts).toBe(1)
    result.a.reset()
    expect(result.a.meta.departAttempts).toBe(0)
  })
})
