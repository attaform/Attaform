// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * `form.meta.departAttempts` + wizard navigation reveal contract.
 *
 * Locks in the API and behavior added with `departAttempts`:
 *
 *  - The counter lives on `form.meta` alongside `submissionAttempts`,
 *    type-visible to consumers; both surface on the readonly meta proxy.
 *  - Wizard navigation (`next`, `back`, `goTo`) bumps the departing
 *    form's counter on real departures only — early-return guards
 *    (back from first, same-key goTo, next at terminal,
 *    activation failed) leave it alone.
 *  - `submissionAttempts` and `departAttempts` are accounting-distinct:
 *    `wizard.handleSubmit` moves submissionAttempts, wizard navigation
 *    moves departAttempts, `form.validate()` moves neither.
 *  - The depart arm of `defaultShouldShowErrors` reveals every error on
 *    a form once it has been departed — the user-facing payoff that
 *    motivated the change.
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

  it('failed wizard.next() bumps departAttempts and leaves submissionAttempts at 0', async () => {
    const { app, result } = mountHarness(() => {
      const b = useForm({ schema: permissiveSchema, key: 'dep-1-b' })
      const a = useForm({ schema: strictSchema, key: 'dep-1-a', next: b })
      const wizard = useWizard(a)
      return { a, b, wizard }
    })
    apps.push(app)
    expect(result.a.meta.departAttempts).toBe(0)
    expect(result.a.meta.submissionAttempts).toBe(0)
    await result.wizard.next()
    expect(result.wizard.current).toBe('dep-1-a') // blocked
    expect(result.a.meta.departAttempts).toBe(1)
    expect(result.a.meta.submissionAttempts).toBe(0)
  })

  it('successful wizard.next() also bumps departAttempts on the departed form', async () => {
    const { app, result } = mountHarness(() => {
      const b = useForm({ schema: permissiveSchema, key: 'dep-2-b' })
      const a = useForm({
        schema: strictSchema,
        key: 'dep-2-a',
        defaultValues: { email: 'a@a.com', password: 'longenough' },
        next: b,
      })
      const wizard = useWizard(a)
      return { a, b, wizard }
    })
    apps.push(app)
    await result.wizard.next()
    expect(result.wizard.current).toBe('dep-2-b')
    expect(result.a.meta.departAttempts).toBe(1)
    expect(result.b.meta.departAttempts).toBe(0)
    expect(result.a.meta.submissionAttempts).toBe(0)
  })

  it('wizard.next() with no `next` declaration does NOT bump (terminal step)', async () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: permissiveSchema, key: 'dep-3-a' })
      const wizard = useWizard(a)
      return { a, wizard }
    })
    apps.push(app)
    await result.wizard.next()
    expect(result.a.meta.departAttempts).toBe(0)
  })

  it('wizard.back() bumps the departing form on real backward navigation', async () => {
    const { app, result } = mountHarness(() => {
      const b = useForm({ schema: permissiveSchema, key: 'dep-4-b' })
      const a = useForm({
        schema: strictSchema,
        key: 'dep-4-a',
        defaultValues: { email: 'a@a.com', password: 'longenough' },
        next: b,
      })
      const wizard = useWizard(a)
      return { a, b, wizard }
    })
    apps.push(app)
    await result.wizard.next()
    expect(result.wizard.current).toBe('dep-4-b')
    const beforeA = result.a.meta.departAttempts
    const beforeB = result.b.meta.departAttempts
    result.wizard.back()
    expect(result.wizard.current).toBe('dep-4-a')
    expect(result.b.meta.departAttempts).toBe(beforeB + 1)
    expect(result.a.meta.departAttempts).toBe(beforeA) // a unaffected
  })

  it('wizard.back() from the first step is a no-op and does NOT bump', () => {
    const { app, result } = mountHarness(() => {
      const b = useForm({ schema: permissiveSchema, key: 'dep-5-b' })
      const a = useForm({ schema: permissiveSchema, key: 'dep-5-a', next: b })
      const wizard = useWizard(a)
      return { a, wizard }
    })
    apps.push(app)
    expect(result.wizard.current).toBe('dep-5-a')
    result.wizard.back()
    expect(result.wizard.current).toBe('dep-5-a')
    expect(result.a.meta.departAttempts).toBe(0)
  })

  it('wizard.goTo(otherKey) bumps the departing form', () => {
    const { app, result } = mountHarness(() => {
      const c = useForm({ schema: permissiveSchema, key: 'dep-6-c' })
      const b = useForm({ schema: permissiveSchema, key: 'dep-6-b', next: c })
      const a = useForm({ schema: permissiveSchema, key: 'dep-6-a', next: b })
      const wizard = useWizard(a)
      return { a, b, c, wizard }
    })
    apps.push(app)
    result.wizard.goTo('dep-6-c')
    expect(result.wizard.current).toBe('dep-6-c')
    expect(result.a.meta.departAttempts).toBe(1)
    expect(result.b.meta.departAttempts).toBe(0)
    expect(result.c.meta.departAttempts).toBe(0)
  })

  it('wizard.goTo(currentKey) is a no-op and does NOT bump', () => {
    const { app, result } = mountHarness(() => {
      const b = useForm({ schema: permissiveSchema, key: 'dep-7-b' })
      const a = useForm({ schema: permissiveSchema, key: 'dep-7-a', next: b })
      const wizard = useWizard(a)
      return { a, wizard }
    })
    apps.push(app)
    result.wizard.goTo('dep-7-a')
    expect(result.a.meta.departAttempts).toBe(0)
  })

  it('wizard.goTo(unknownKey) dev-warns and does NOT bump', () => {
    const { app, result } = mountHarness(() => {
      const b = useForm({ schema: permissiveSchema, key: 'dep-8-b' })
      const a = useForm({ schema: permissiveSchema, key: 'dep-8-a', next: b })
      const wizard = useWizard(a)
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

  it('wizard.handleSubmit failure bumps submissionAttempts but NOT departAttempts', async () => {
    const { app, result } = mountHarness(() => {
      const b = useForm({ schema: strictSchema, key: 'acc-1-b' })
      const a = useForm({
        schema: strictSchema,
        key: 'acc-1-a',
        defaultValues: { email: 'a@a.com', password: 'longenough' },
        next: b,
      })
      const wizard = useWizard(a)
      return { a, b, wizard }
    })
    apps.push(app)
    const onSubmit = result.wizard.handleSubmit(async () => {})
    await onSubmit()
    expect(result.a.meta.submissionAttempts).toBeGreaterThan(0)
    expect(result.b.meta.submissionAttempts).toBeGreaterThan(0)
    expect(result.a.meta.departAttempts).toBe(0)
    expect(result.b.meta.departAttempts).toBe(0)
  })

  it('form.validate() leaves both counters at 0', async () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: strictSchema, key: 'acc-2-a' })
      // validate() must be called inside an effect scope; reading the
      // ref inside setup keeps the watcher tied to this mount.
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

  it('after failed wizard.next(), every error field reports showErrors=true even when never touched', async () => {
    const { app, result } = mountHarness(() => {
      const b = useForm({ schema: permissiveSchema, key: 'show-1-b' })
      const a = useForm({ schema: strictSchema, key: 'show-1-a', next: b })
      const wizard = useWizard(a)
      return { a, wizard }
    })
    apps.push(app)
    expect(result.a.fields.email.touched).toBe(false)
    expect(result.a.fields.password.touched).toBe(false)
    expect(result.a.fields.email.showErrors).toBe(false)
    expect(result.a.fields.password.showErrors).toBe(false)
    await result.wizard.next()
    expect(result.a.meta.departAttempts).toBe(1)
    expect(result.a.fields.email.showErrors).toBe(true)
    expect(result.a.fields.password.showErrors).toBe(true)
  })

  it('after wizard.back() leaves an invalid step, its errors reveal on the way back', async () => {
    // Mirrors the user's deep-link scenario: a flow starts on step b,
    // user presses Back to a (departing b before ever editing it), then
    // returns. b's errors should be visible from departure onward.
    const { app, result } = mountHarness(() => {
      const b = useForm({ schema: strictSchema, key: 'show-2-b' })
      const a = useForm({
        schema: strictSchema,
        key: 'show-2-a',
        defaultValues: { email: 'a@a.com', password: 'longenough' },
        next: b,
      })
      const wizard = useWizard(a, { getServerActiveStep: () => 'show-2-b' })
      return { a, b, wizard }
    })
    apps.push(app)
    expect(result.wizard.current).toBe('show-2-b')
    expect(result.b.fields.email.showErrors).toBe(false)
    result.wizard.back()
    expect(result.b.meta.departAttempts).toBe(1)
    expect(result.b.fields.email.showErrors).toBe(true)
    expect(result.b.fields.password.showErrors).toBe(true)
  })
})

describe('form.reset() clears departAttempts', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('zeros departAttempts alongside the rest of the submission lifecycle', async () => {
    const { app, result } = mountHarness(() => {
      const b = useForm({ schema: permissiveSchema, key: 'rst-1-b' })
      const a = useForm({ schema: strictSchema, key: 'rst-1-a', next: b })
      const wizard = useWizard(a)
      return { a, wizard }
    })
    apps.push(app)
    await result.wizard.next()
    expect(result.a.meta.departAttempts).toBe(1)
    result.a.reset()
    expect(result.a.meta.departAttempts).toBe(0)
  })
})
