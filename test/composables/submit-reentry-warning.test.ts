// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'
import { awaitSettle } from '../utils/form-harness'

/**
 * `handleSubmit`'s re-entry guard swallows a submit that arrives while
 * another is in flight, which is what keeps a double-click from POSTing
 * twice. The swallow is the whole point, so it stays silent for a
 * DOM-driven double submit: a second click is user input, and there is
 * nothing for the consumer to fix.
 *
 * A call carrying no event is code, though, and a swallowed programmatic
 * call is the hardest failure in the API to find: the callback never runs,
 * `submitting` never flips, and no error, `submitError` or `firstOwnError`
 * appears. Dev names it so the loss is visible.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUseForm = (opts: any) => any

const adapters = [
  { name: 'v4', useForm: useFormV4 as AnyUseForm, z: zV4 },
  { name: 'v3', useForm: useFormV3 as AnyUseForm, z: zV3 as unknown as typeof zV4 },
] as const

const REENTRY = 'already in flight'

describe.each(adapters)('handleSubmit re-entry guard — $name', ({ useForm, z }) => {
  const apps: App[] = []
  afterEach(() => {
    for (const app of apps.splice(0)) app.unmount()
    vi.restoreAllMocks()
  })

  const formKey = `reentry-${Math.random().toString(36).slice(2)}`

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function mountForm(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle: any = {}
    const App = defineComponent({
      setup() {
        handle.form = useForm({
          key: formKey,
          schema: z.object({ name: z.string() }),
          defaultValues: { name: 'Ada' },
        })
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.config.warnHandler = () => {}
    app.mount(document.createElement('div'))
    apps.push(app)
    return handle
  }

  // Collected at the call rather than read back off the spy, so the
  // assertions work on plain strings.
  function captureWarnings(): string[] {
    const lines: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(' '))
    })
    return lines
  }

  it('warns when a programmatic submit is swallowed, and says the callback never ran', async () => {
    const warnings = captureWarnings()
    const { form } = mountForm()
    await awaitSettle()

    let innerRan = 0
    const inner = form.handleSubmit(() => {
      innerRan += 1
    })
    await form.handleSubmit(async () => {
      await inner()
    })()
    await awaitSettle()

    expect(innerRan).toBe(0)
    const lines = warnings.filter((line) => line.includes(REENTRY))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('[attaform] handleSubmit')
    expect(lines[0]).toContain(formKey)
    expect(lines[0]).toContain('its callback never ran')
  })

  it('stays silent when the swallowed submit came from a DOM event', async () => {
    const warnings = captureWarnings()
    const { form } = mountForm()
    await awaitSettle()

    let ran = 0
    const submit = form.handleSubmit(async () => {
      ran += 1
      await Promise.resolve()
    })
    // The classic double-click: two events, one submission.
    await Promise.all([submit(new Event('submit')), submit(new Event('submit'))])
    await awaitSettle()

    expect(ran).toBe(1)
    expect(warnings.filter((line) => line.includes(REENTRY))).toHaveLength(0)
  })

  it('does not warn for sequential submits, which are not swallowed', async () => {
    const warnings = captureWarnings()
    const { form } = mountForm()
    await awaitSettle()

    let ran = 0
    const submit = form.handleSubmit(() => {
      ran += 1
    })
    await submit()
    await submit()
    await awaitSettle()

    expect(ran).toBe(2)
    expect(warnings.filter((line) => line.includes(REENTRY))).toHaveLength(0)
  })
})
