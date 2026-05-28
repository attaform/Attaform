// @vitest-environment jsdom
/**
 * PASS2-S3 — the form-wide `lastValidatedSnapshot` `let` was
 * overwritten by whichever field's run committed last and was
 * compared whole-form in the blur-dedup. Two real consequences:
 *   - a programmatic edit to sibling B (between A blurs) made
 *     the dedup see "form changed" and SPURIOUSLY re-ran A's
 *     validation even though A's value never moved;
 *   - once CORE-P1a's subtree scope lands, a commit at B no
 *     longer validates A — but the shared snapshot would still
 *     advance, leaving A's dedup falsely skipping a real
 *     re-validation it needed.
 *
 * Fix: per-path snapshot `Map<PathKey, unknown>` keyed by the
 * commit scope; blur-dedup walks from the blurred path up to
 * the closest ancestor entry and extracts the subtree-at-path
 * from it for comparison. Under whole-form scope (today) every
 * commit lands at the root key, so all blurs share a single
 * entry — equivalent to the old `let`. Per-path keeps the
 * design correct under both scopes.
 *
 * Red-green: programmatic `setValue('b', …)` between A blurs
 * leaves A's subtree-at-path unchanged. Today's whole-form diff
 * spots B's diff and revalidates A; the fix's subtree-scoped
 * diff finds no change at A and skips. A refine-invocation
 * counter is the direct proxy.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, withDirectives, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'
import { vRegister } from '../../src/runtime/core/directive'

const drainMicrotasks = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

function buildV4() {
  let runs = 0
  const schema = zV4.object({
    a: zV4.string().refine(
      (v) => {
        runs += 1
        return v === 'good-a'
      },
      { message: 'a-invalid' }
    ),
    b: zV4.string(),
  })
  return { schema, runs: () => runs }
}

function buildV3() {
  let runs = 0
  const schema = zV3.object({
    a: zV3.string().refine(
      (v) => {
        runs += 1
        return v === 'good-a'
      },
      { message: 'a-invalid' }
    ),
    b: zV3.string(),
  })
  return { schema, runs: () => runs }
}

const adapters = [
  { name: 'v4', useForm: useFormV4, build: buildV4 },
  { name: 'v3', useForm: useFormV3, build: buildV3 },
] as const

describe.each(adapters)('per-path snapshot — $name', ({ useForm, build }) => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    document.body.innerHTML = ''
  })

  it("refocus-blur on A is not revalidated when a sibling's value changed but A's didn't", async () => {
    const { schema, runs } = build()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let api: any
    const App = defineComponent({
      setup() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        api = (useForm as any)({
          schema,
          key: 'per-path-snapshot',
          strict: false,
          validateOn: 'blur',
          defaultValues: { a: '', b: '' },
        })
        return () =>
          withDirectives(h('input', { 'data-id': 'a', type: 'text' }), [
            [vRegister, api.register('a')],
          ])
      },
    })
    const app = createApp(App).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    apps.push(app)
    await drainMicrotasks()

    const aInput = root.querySelector('input[data-id="a"]') as HTMLInputElement

    // Type into A, blur A. The first interactive blur runs A's refine
    // (and the whole-form pass) and commits a snapshot.
    aInput.dispatchEvent(new FocusEvent('focus'))
    aInput.value = 'nope'
    aInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    aInput.dispatchEvent(new FocusEvent('blur'))
    await drainMicrotasks()
    const runsAfterFirstBlur = runs()
    expect(runsAfterFirstBlur).toBeGreaterThan(0)

    // Programmatic edit to sibling B — blur-mode forms don't schedule
    // a validation on setValue, so no commit happens and the snapshot
    // is left wherever the first blur put it. Today's whole-form
    // diff would catch B's edit at root scope and revalidate A
    // spuriously; the per-path / subtree-scoped diff sees no change
    // at A's path and skips.
    api.setValue('b', 'changed')
    await drainMicrotasks()

    // Refocus A and blur with no edit on A. With the fix the dedup
    // skips; without it the diff sees B's change and re-runs A's refine.
    aInput.dispatchEvent(new FocusEvent('focus'))
    aInput.dispatchEvent(new FocusEvent('blur'))
    await drainMicrotasks()

    expect(runs()).toBe(runsAfterFirstBlur)
  })
})
