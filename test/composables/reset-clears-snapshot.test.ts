// @vitest-environment jsdom
/**
 * PASS2-14 — `reset()` cleared field records, errors, and pending
 * validations but did NOT clear the per-path snapshot map. A reset
 * back to a value that happens to equal the pre-reset state then
 * had a survivor entry in `pathSnapshots` matching the post-reset
 * form, so the next focus/blur cycle's dedup found "no change"
 * against a stale snapshot and SKIPPED revalidation — leaving the
 * cleared error bucket cleared and the refine never re-running.
 * The audit calls this latent: today's first-interactive-blur
 * force-run masks it for the most common tab-through, but any
 * post-reset focus/blur cycle WITHOUT a fresh interactive edit
 * (still possible: a `setFocus(false)` from a script, a refocus
 * after an unrelated form action) lands in the wrong-skip branch.
 *
 * Fix: `reset()` clears `pathSnapshots` and resets the epoch
 * counters, so the post-reset blur dedup falls through to a
 * real revalidation.
 *
 * Red-green: pre-reset blur commits `{a:'bad'}` into the snapshot
 * map. `reset({ a: 'bad' })` mirrors the value so the form's
 * post-reset state structurally equals the survivor snapshot;
 * the field records' `interacted` flag is reset to `false` so
 * the firstInteractiveBlur gate doesn't force the next run. The
 * next focus/blur dedup either finds nothing (fix) and runs
 * validation, or finds the stale snapshot (bug) and skips.
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
  })
  return { schema, runs: () => runs }
}

const adapters = [
  { name: 'v4', useForm: useFormV4, build: buildV4 },
  { name: 'v3', useForm: useFormV3, build: buildV3 },
] as const

describe.each(adapters)('reset clears snapshot map — $name', ({ useForm, build }) => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    document.body.innerHTML = ''
  })

  it('post-reset blur dedup runs validation even when the value matches a pre-reset snapshot', async () => {
    const { schema, runs } = build()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let api: any
    const App = defineComponent({
      setup() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        api = (useForm as any)({
          schema,
          key: 'reset-clears-snapshot',
          strict: false,
          validateOn: 'blur',
          defaultValues: { a: '' },
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

    // Type into A, blur A. The firstInteractiveBlur force-run lands
    // the validation and writes `{a:'bad'}` into the snapshot map.
    aInput.dispatchEvent(new FocusEvent('focus'))
    aInput.value = 'bad'
    aInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    aInput.dispatchEvent(new FocusEvent('blur'))
    await drainMicrotasks()
    const runsAfterFirstBlur = runs()
    expect(runsAfterFirstBlur).toBeGreaterThan(0)

    // Reset to a value matching the post-blur state. The reset
    // clears errors and zeroes the field's `interacted` flag, so
    // the next blur is NOT a firstInteractiveBlur — it lands in
    // the dedup branch. Without the fix the survivor snapshot
    // matches the live form, and dedup skips.
    api.reset({ a: 'bad' })
    await drainMicrotasks()

    aInput.dispatchEvent(new FocusEvent('focus'))
    aInput.dispatchEvent(new FocusEvent('blur'))
    await drainMicrotasks()

    // With the fix: snapshot map cleared in `reset()`, the dedup
    // can't match against anything, and the validation re-runs.
    expect(runs()).toBeGreaterThan(runsAfterFirstBlur)
  })
})
