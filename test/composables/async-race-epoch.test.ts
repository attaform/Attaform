// @vitest-environment jsdom
/**
 * PASS2-2 — concurrent per-path async field validations had only
 * a per-path AbortController and no form-level epoch counter, so
 * two runs on DIFFERENT paths could both commit whole-form verdicts.
 * Whichever Promise settled LAST replaced the previously-committed
 * error map — even when its verdict was computed against pre-edit
 * state. Common with slow server-uniqueness refines: type B after A,
 * B's verdict commits first, then A's slow uniqueness check resolves
 * with the pre-B form and clobbers B's just-committed errors.
 *
 * The fix is a form-level monotonic schedule epoch + a re-check
 * immediately before `applySchemaErrorsForSubtree([], …)`: a run
 * whose `myEpoch <= lastCommittedEpoch` is dropped (a fresher
 * verdict already landed). Per-path abort still guards same-path
 * rapid typing; the epoch guards cross-path races.
 *
 * The race is forced deterministically by handing each `.refine`
 * a manually-resolvable Promise. Run() chain order:
 *   1. setValue A → run() → microtask → reads form.value @ pre-B,
 *      validateAtPath fires refines for a (value='X') and b (value='').
 *   2. setValue B → run() → microtask → reads form.value @ post-B,
 *      validateAtPath fires refines for a (value='X') and b (value='Y').
 *   3. Resolve call-2's refines → call 2 commits empty error map.
 *   4. Resolve call-1's refines with FAIL → without the epoch gate,
 *      call 1's commit OVERWRITES with stale failures.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'

async function drainMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

function buildSchemaV4() {
  const resolvers: Array<(v: boolean) => void> = []
  const schema = zV4.object({
    a: zV4.string().refine(
      (_value) =>
        new Promise<boolean>((r) => {
          resolvers.push(r)
        }),
      { message: 'a-invalid' }
    ),
    b: zV4.string().refine(
      (_value) =>
        new Promise<boolean>((r) => {
          resolvers.push(r)
        }),
      { message: 'b-invalid' }
    ),
  })
  return { schema, resolvers }
}

function buildSchemaV3() {
  const resolvers: Array<(v: boolean) => void> = []
  const schema = zV3.object({
    a: zV3.string().refine(
      (_value) =>
        new Promise<boolean>((r) => {
          resolvers.push(r)
        }),
      { message: 'a-invalid' }
    ),
    b: zV3.string().refine(
      (_value) =>
        new Promise<boolean>((r) => {
          resolvers.push(r)
        }),
      { message: 'b-invalid' }
    ),
  })
  return { schema, resolvers }
}

const adapters = [
  { name: 'v4', useForm: useFormV4, build: buildSchemaV4 },
  { name: 'v3', useForm: useFormV3, build: buildSchemaV3 },
] as const

describe.each(adapters)('async-race epoch — $name', ({ useForm, build }) => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    document.body.innerHTML = ''
  })

  it('drops a stale call-1 commit that resolves AFTER a fresher call-2 commit', async () => {
    const { schema, resolvers } = build()
    // useForm has v3-or-v4 union under describe.each — single inline
    // cast is the cleanest tool here (mirrors the
    // field-validation-counts-migration pattern).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let api: any
    const App = defineComponent({
      setup() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        api = (useForm as any)({
          schema,
          key: 'async-race-epoch',
          strict: false,
          defaultValues: { a: '', b: '' },
          validateOn: 'change',
          debounceMs: 0,
        })
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    apps.push(app)

    // Drain any construction-time validation refines so the count
    // below starts from a clean baseline.
    await drainMicrotasks()
    const constructionRefines = resolvers.length
    // Construction-time refines (if any) resolve TRUE so they don't
    // contaminate the test's error-map assertions.
    for (let i = 0; i < constructionRefines; i++) resolvers[i](true)
    await drainMicrotasks()

    // Edit A first; drain so A's run() reads form.value at the
    // pre-B microtask boundary and fires its refine pair.
    api.setValue('a', 'X')
    await drainMicrotasks()
    const afterAEdit = resolvers.length
    const callOneRefines = afterAEdit - constructionRefines
    expect(callOneRefines).toBeGreaterThanOrEqual(2)

    // Edit B; drain so B's run() reads form.value at the post-B
    // microtask boundary and fires its own refine pair.
    api.setValue('b', 'Y')
    await drainMicrotasks()
    const callTwoRefines = resolvers.length - afterAEdit
    expect(callTwoRefines).toBeGreaterThanOrEqual(2)

    // Resolve call-2's refines TRUE first → call 2's validateAtPath
    // promise settles with success → empty error map committed.
    for (let i = afterAEdit; i < resolvers.length; i++) resolvers[i](true)
    await drainMicrotasks()
    expect(api.errors.a).toEqual([])
    expect(api.errors.b).toEqual([])

    // Resolve call-1's refines FALSE → call 1's promise settles with
    // failure. Without the epoch gate: applySchemaErrorsForSubtree
    // overwrites the empty map with stale failures. With the gate:
    // call 1 is dropped (myEpoch <= lastCommittedEpoch).
    for (let i = constructionRefines; i < afterAEdit; i++) resolvers[i](false)
    await drainMicrotasks()

    expect(api.errors.a).toEqual([])
    expect(api.errors.b).toEqual([])
  })
})
