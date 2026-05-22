// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * `useWizard` exposes the current step as a triple:
 *
 *   - `current`     — the active step's key (or `undefined` if no forms)
 *   - `activeForm`  — the active step's form handle (or `undefined`)
 *   - `activeIndex` — the active step's 0-based index (or `-1`)
 *
 * `activeForm` and `activeIndex` are derived getters — they update
 * synchronously when `goTo` / `next` / `back` flips `current`.
 *
 * These exist so a consumer can write
 *   `wizard.activeForm?.handleSubmit(...)`
 * without re-deriving the form-by-key lookup themselves.
 */

const schema = z.object({ email: z.string() })

function mountWizardHarness<R>(setup: () => R): { app: App; result: R } {
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

describe('useWizard — activeForm + activeIndex', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('activeForm is the form whose key matches current', () => {
    const { app, result } = mountWizardHarness(() => {
      const c = useForm({ schema, key: 'c' })
      const b = useForm({ schema, key: 'b', next: c })
      const a = useForm({ schema, key: 'a', next: b })
      return useWizard(a)
    })
    apps.push(app)
    expect(result.activeForm?.key).toBe('a')
    result.next()
    expect(result.activeForm?.key).toBe('b')
    result.goTo('c')
    expect(result.activeForm?.key).toBe('c')
    result.back()
    expect(result.activeForm?.key).toBe('b')
  })

  it('activeIndex is the 0-based index of the active step', () => {
    const { app, result } = mountWizardHarness(() => {
      const c = useForm({ schema, key: 'c' })
      const b = useForm({ schema, key: 'b', next: c })
      const a = useForm({ schema, key: 'a', next: b })
      return useWizard(a)
    })
    apps.push(app)
    expect(result.activeIndex).toBe(0)
    result.next()
    expect(result.activeIndex).toBe(1)
    result.goTo('c')
    expect(result.activeIndex).toBe(2)
    result.back()
    expect(result.activeIndex).toBe(1)
  })

  it('activeForm tracks the same form identity as the forms array entry', () => {
    const { app, result } = mountWizardHarness(() => {
      const b = useForm({ schema, key: 'b' })
      const a = useForm({ schema, key: 'a', next: b })
      return useWizard(a)
    })
    apps.push(app)
    expect(result.activeForm).toBe(result.allForms[0])
    result.next()
    expect(result.activeForm).toBe(result.allForms[1])
  })
})
