// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * What a whole-wizard submit writes, and when.
 *
 * Two claims the docs make that nothing else held:
 *
 *   1. `wizard.handleSubmit` VALIDATES each step rather than submitting
 *      it, so a clean finish latches `wizard.done` and leaves every
 *      step's `submitted` alone. A rail that paints checkmarks off
 *      `statuses[key].submitted` after Finish would stay blank, and
 *      `wizard.done` is the read that answers "the wizard finished".
 *   2. The wizard bumps its own `submissionAttempts` (and each step's)
 *      BEFORE it calls `onSubmit`, so a read inside the callback already
 *      counts the run in progress. That is the OPPOSITE of the form's
 *      own `handleSubmit`, which bumps in its `finally` (pinned in
 *      `submission-attempts-ordering.test.ts`). Same field name,
 *      opposite timing, depending on which handler you are inside.
 */

function mountHarness<R>(setup: () => R): { app: App; result: R } {
  const handle: { result?: R } = {}
  const Comp = defineComponent({
    setup() {
      handle.result = setup()
      return () => h('div')
    },
  })
  const app = createApp(Comp).use(createAttaform())
  app.config.warnHandler = () => {}
  app.config.errorHandler = () => {}
  app.mount(document.createElement('div'))
  return { app, result: handle.result as R }
}

const settle = async (): Promise<void> => {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await nextTick()
}

const accountSchema = z.object({ email: z.string().min(3, 'too short') })
const noteSchema = z.object({ note: z.string().min(1, 'note required') })

describe('useWizard: what a whole-wizard submit writes', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('latches `done` on a clean finish without flipping any step `submitted`', async () => {
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'wsb-clean-account',
        defaultValues: { email: 'hello' },
      })
      const notes = useForm({
        schema: noteSchema,
        key: 'wsb-clean-notes',
        defaultValues: { note: 'ship it' },
      })
      return {
        wizard: useWizard({
          steps: [account, notes],
          restore: false,
          persist: false,
        }),
        account,
        notes,
      }
    })
    apps.push(app)
    await settle()

    await result.wizard.handleSubmit(() => {})()
    await settle()

    expect(result.wizard.done).toBe(true)
    // The wizard validated each form; neither was submitted.
    expect(result.wizard.statuses['wsb-clean-account']?.submitted).toBe(false)
    expect(result.wizard.statuses['wsb-clean-notes']?.submitted).toBe(false)
    expect(result.account.meta.submitted).toBe(false)
    expect(result.notes.meta.submitted).toBe(false)
  })

  it('counts the run in progress inside `onSubmit` (bumped before the callback)', async () => {
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'wsb-order-account',
        defaultValues: { email: 'hello' },
      })
      return {
        wizard: useWizard({ steps: [account, 'wsb-order-review'], restore: false, persist: false }),
        account,
      }
    })
    apps.push(app)
    await settle()

    const seen: { wizard: number; form: number }[] = []
    const finish = result.wizard.handleSubmit(() => {
      seen.push({
        wizard: result.wizard.submissionAttempts,
        form: result.account.meta.submissionAttempts,
      })
    })

    expect(result.wizard.submissionAttempts).toBe(0)
    await finish()
    await settle()

    // Read from inside the callback: the wizard counter and every step's
    // already include this run.
    expect(seen).toStrictEqual([{ wizard: 1, form: 1 }])
    expect(result.wizard.submissionAttempts).toBe(1)

    await finish()
    await settle()
    expect(seen[1]).toStrictEqual({ wizard: 2, form: 2 })
  })

  it('carries an affordance step through the same bookkeeping', async () => {
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'wsb-noop-account',
        defaultValues: { email: 'hello' },
      })
      return {
        wizard: useWizard({ steps: [account, 'wsb-noop-review'], restore: false, persist: false }),
        account,
      }
    })
    apps.push(app)
    await settle()

    await result.wizard.handleSubmit(() => {})()
    await settle()

    // The noop form behind a string slot is processed like any other step:
    // it validates trivially, and its `submitted` is left alone too. (Its
    // own meta is unreachable by design: a string slot's entry in
    // `wizard.forms` is typed `AnyForm`, which carries no schema surface.)
    expect(result.wizard.done).toBe(true)
    expect(result.wizard.statuses['wsb-noop-review']?.submitted).toBe(false)
    expect(result.wizard.statuses['wsb-noop-review']?.valid).toBe(true)
  })

  it('leaves `done` and `submitted` alone when a step fails validation', async () => {
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 'wsb-fail-account',
        defaultValues: { email: 'x' },
      })
      return {
        wizard: useWizard({ steps: [account], restore: false, persist: false }),
        account,
      }
    })
    apps.push(app)
    await settle()

    let onErrorAttempts = -1
    await result.wizard.handleSubmit(
      () => {},
      () => {
        onErrorAttempts = result.wizard.submissionAttempts
      }
    )()
    await settle()

    expect(result.wizard.done).toBe(false)
    expect(result.account.meta.submitted).toBe(false)
    // `onError` sees the same post-bump count `onSubmit` would.
    expect(onErrorAttempts).toBe(1)
  })
})
