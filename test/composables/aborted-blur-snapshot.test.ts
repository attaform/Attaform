// @vitest-environment jsdom
/**
 * PASS2-3 — `run()` wrote `lastValidatedSnapshot` at run-START,
 * BEFORE the post-resolve abort re-check. A path-scoped
 * `validateAsync(other)` calls `cancelFieldValidation()`
 * synchronously, aborting the in-flight blur run for the
 * interactively-blurred path — but the snapshot had already
 * advanced. The blur-dedup at the next focus/blur cycle then
 * compared the (unchanged) form value to the advanced snapshot,
 * SKIPPED revalidation, and surfaced no error for a field that
 * was actually invalid: `displayState === 'success'` instead of
 * `'error'`.
 *
 * The fix moves the snapshot write past the abort + epoch
 * checks, into the applied branch — so the snapshot advances
 * only for verdicts that actually commit.
 *
 * Repro forces the race deterministically with async refines:
 *   1. Type into A so the directive flips `interacted`, then
 *      blur A. `run()` queues the validate microtask.
 *   2. SYNCHRONOUSLY call `validateAsync('b')` —
 *      `cancelFieldValidation()` aborts A's pending run before
 *      its `.then` ever fires; `validateAsync` writes for B only.
 *   3. Refocus A, blur unchanged. Without the fix, the snapshot
 *      from step 1 makes the dedup skip → A shows success.
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

function buildSchemaV4() {
  return zV4.object({
    a: zV4.string().refine(async (v) => v === 'good-a', { message: 'a-invalid' }),
    b: zV4.string().refine(async (v) => v === 'good-b', { message: 'b-invalid' }),
  })
}

function buildSchemaV3() {
  return zV3.object({
    a: zV3.string().refine(async (v) => v === 'good-a', { message: 'a-invalid' }),
    b: zV3.string().refine(async (v) => v === 'good-b', { message: 'b-invalid' }),
  })
}

const adapters = [
  { name: 'v4', useForm: useFormV4, buildSchema: buildSchemaV4 },
  { name: 'v3', useForm: useFormV3, buildSchema: buildSchemaV3 },
] as const

describe.each(adapters)('aborted-blur snapshot — $name', ({ useForm, buildSchema }) => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    document.body.innerHTML = ''
  })

  it('an aborted blur run does not skip the next blur — invalid A still surfaces error', async () => {
    const schema = buildSchema()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let api: any
    const App = defineComponent({
      setup() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        api = (useForm as any)({
          schema,
          key: 'aborted-snapshot',
          strict: false,
          validateOn: 'blur',
          defaultValues: { a: '', b: '' },
        })
        return () =>
          h('div', [
            withDirectives(h('input', { 'data-id': 'a', type: 'text' }), [
              [vRegister, api.register('a')],
            ]),
            withDirectives(h('input', { 'data-id': 'b', type: 'text' }), [
              [vRegister, api.register('b')],
            ]),
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

    // Edit A invalid through the DOM — the directive flips `interacted`
    // on path 'a', which arms the upcoming blur to be an interactive blur.
    aInput.dispatchEvent(new FocusEvent('focus'))
    aInput.value = 'invalid'
    aInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    // Blur A: `markFocused(false)` schedules an immediate blur-mode run.
    // Inside `run()`, the bug writes the snapshot AT THIS POINT, before
    // the post-resolve abort check. The validate microtask is queued.
    aInput.dispatchEvent(new FocusEvent('blur'))

    // Synchronously interleave a path-scoped `validateAsync('b')` so
    // `cancelFieldValidation()` aborts A's pending run before its
    // `.then` ever fires. `validateAsync('b')` writes only B's bucket.
    void api.validateAsync('b')

    await drainMicrotasks()
    // Sanity — A's verdict was aborted, so A's bucket stays empty.
    expect(api.errors.a).toEqual([])

    // Refocus A and blur without typing. The blur-dedup compares
    // current form.value against the snapshot. With the bug, the
    // step-1 snapshot makes the dedup say "no change" and skip; A
    // stays "success" with no error. With the fix, the snapshot
    // didn't advance (the aborted run never reached the applied
    // branch), so the dedup falls through, validation runs, and
    // A's error commits.
    aInput.dispatchEvent(new FocusEvent('focus'))
    aInput.dispatchEvent(new FocusEvent('blur'))
    await drainMicrotasks()

    expect(api.errors.a.length).toBeGreaterThan(0)
    expect(api.fields('a').displayState).toBe('error')
  })
})
