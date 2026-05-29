// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * COMP-W1 + COMP-W4 invariant: a bare function slot whose body does
 * not read `ctx.currentKey` must NOT re-fire on wizard navigation.
 * Only the slot's own tracked reactive reads should invalidate its
 * resolution.
 *
 * The audit pinned this as P1 perf because pre-fix every `next` /
 * `back` / `goTo` writes `activeKey`, which invalidates the `slotCtx`
 * computed (`use-wizard.ts:282`) and cascades into `compiledSteps` —
 * re-running every bare function slot's resolver. A 50-step wizard
 * with eager function slots therefore re-runs all 50 resolvers per
 * navigation, even ones whose body is independent of the active step.
 *
 * The fix unifies bare function slots on the same getter-style ctx
 * `lazy()` slots already receive (`use-wizard.ts:341` `lazyCtx`): the
 * `currentKey` dep is only established when the slot body actually
 * reads it.
 */

const schema = z.object({ email: z.string().optional() })

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

describe('useWizard — bare function slot resolver-call accounting (COMP-W1)', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('a bare function slot that does not read ctx.currentKey fires once and stays cached across navigation', async () => {
    let resolverCalls = 0
    const { app, result } = mountHarness(() => {
      const entry = useForm({ schema, key: 'comp-w1-entry' })
      const middle = useForm({ schema, key: 'comp-w1-middle' })
      const final = useForm({ schema, key: 'comp-w1-final' })
      return useWizard({
        steps: [
          entry,
          // Bare function slot — no `lazy()` wrapper, no reactive
          // reads inside the body. Should fire once on initial
          // compile and never again, regardless of how many times
          // the wizard navigates around it.
          () => {
            resolverCalls += 1
            return middle
          },
          final,
        ],
        restore: false,
        persist: false,
      })
    })
    apps.push(app)

    expect(resolverCalls).toBe(1)
    expect(result.steps.map((s) => s.key)).toEqual([
      'comp-w1-entry',
      'comp-w1-middle',
      'comp-w1-final',
    ])

    await result.next() // entry → middle
    await result.next() // middle → final
    result.back() //         final → middle
    result.goTo('comp-w1-entry')

    // Pre-fix: `compiledSteps` reads `slotCtx.value` which reads
    // `activeKey.value`, so each navigation invalidates the
    // compile-pass computed and the bare function slot re-fires.
    // Pre-fix resolverCalls === 5 (1 setup + 4 navigations).
    // Post-fix: the getter-style ctx never establishes the
    // activeKey dep because the slot body never reads
    // ctx.currentKey, so resolverCalls stays at 1.
    expect(resolverCalls).toBe(1)
  })

  it('a bare function slot that reads ctx.currentKey re-fires on navigation as expected', async () => {
    let resolverCalls = 0
    let lastSeenCurrentKey: string | undefined
    const { app, result } = mountHarness(() => {
      const entry = useForm({ schema, key: 'comp-w1-rdk-entry' })
      const middle = useForm({ schema, key: 'comp-w1-rdk-middle' })
      const final = useForm({ schema, key: 'comp-w1-rdk-final' })
      return useWizard({
        steps: [
          entry,
          (ctx) => {
            resolverCalls += 1
            lastSeenCurrentKey = ctx.currentKey
            return middle
          },
          final,
        ],
        restore: false,
        persist: false,
      })
    })
    apps.push(app)

    // Sanity: the slot observed at least the initial compile.
    const initialCalls = resolverCalls
    expect(initialCalls).toBeGreaterThanOrEqual(1)
    expect(lastSeenCurrentKey).toBe('comp-w1-rdk-entry')

    await result.next() // → middle: ctx.currentKey changes, slot re-fires.
    expect(resolverCalls).toBeGreaterThan(initialCalls)
    expect(lastSeenCurrentKey).toBe('comp-w1-rdk-middle')
  })
})
