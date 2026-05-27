// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Derived per-element state across a structural array mutation. Schema
 * verdicts and in-flight validation are NOT relocated with the element (they
 * are recomputed from the live value), so a structural op cleans them up
 * explicitly:
 *
 *   - schema errors at changed indices drop synchronously, so a verdict
 *     describing a slot's prior occupant can't show before revalidation
 *     repopulates from the new value;
 *   - a removed element's in-flight validation aborts, so a late async
 *     resolution can't write at the dead index and the form settles.
 *
 * Both adapters (v3 + v4) — same runtime contract.
 */

type TestForm = {
  handleSubmit: (onValid: () => void, onInvalid: () => void) => () => Promise<void>
  swap: (path: string, a: number, b: number) => void
  setValue: (path: string, value: unknown) => void
  remove: (path: string, index: number) => void
  values: Record<string, unknown[]>
  errors: (path: string) => Array<{ message: string }> | undefined
  meta: { validating: boolean }
}

const apps: App[] = []
afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
  document.body.innerHTML = ''
})

function mountWithApp(setup: () => TestForm): TestForm {
  const handle: { captured?: TestForm } = {}
  const App = defineComponent({
    setup() {
      handle.captured = setup()
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  apps.push(app)
  if (handle.captured === undefined) throw new Error('mountWithApp: setup never returned')
  return handle.captured
}

async function flushValidations(form: TestForm): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await nextTick()
    if (!form.meta.validating) break
  }
  await nextTick()
  await nextTick()
}

function runSuite(label: string, build: () => TestForm, buildAsync: () => TestForm): void {
  describe(`structural derived-state hygiene (${label})`, () => {
    it('drops a stale schema error at a swapped slot synchronously', async () => {
      const form = build()
      // Populate schema errors: 'ab' fails .min(3) at index 0; 'abc' passes.
      await form.handleSubmit(
        () => {},
        () => {}
      )()
      expect(form.errors('tags.0')?.length).toBeGreaterThan(0)
      expect(form.errors('tags.1')).toEqual([])

      // Swap → 'abc' into slot 0, 'ab' into slot 1. The verdict still keyed at
      // slot 0 describes the element that just left, so it must drop at once,
      // before the async revalidation runs.
      form.swap('tags', 0, 1)
      expect(form.errors('tags.0')).toEqual([])

      // Revalidation then repopulates at the invalid element's NEW slot.
      await flushValidations(form)
      expect(form.errors('tags.0')).toEqual([])
      expect(form.errors('tags.1')?.length).toBeGreaterThan(0)
    })

    it('settles cleanly when an element is removed mid async validation', async () => {
      const form = buildAsync()
      // Edit index 0 to kick off its async validation, then remove it while
      // that validation is still in flight.
      form.setValue('items.0', 'a')
      form.remove('items', 0)
      await flushValidations(form)

      // No hang, and no verdict resurrected at the now-removed tail index.
      expect(form.meta.validating).toBe(false)
      expect(form.errors('items.1')).toEqual([])
      expect(form.values['items']).toEqual(['bbb'])
    })
  })
}

// Async check resolves on the microtask queue so the validation chain is
// flushable through `nextTick` while still being genuinely in flight at the
// moment of the structural mutation.
const asyncCheck = async (v: string): Promise<boolean> => {
  await Promise.resolve()
  return v.length >= 3
}

runSuite(
  'v3',
  () =>
    mountWithApp(
      () =>
        useFormV3({
          schema: zV3.object({ tags: zV3.array(zV3.string().min(3, 'min3')) }),
          key: `sds-drop-v3-${Math.random()}`,
          strict: false,
          validateOn: 'change',
          debounceMs: 0,
          defaultValues: { tags: ['ab', 'abc'] },
        }) as unknown as TestForm
    ),
  () =>
    mountWithApp(
      () =>
        useFormV3({
          schema: zV3.object({ items: zV3.array(zV3.string().refine(asyncCheck, 'min3')) }),
          key: `sds-async-v3-${Math.random()}`,
          strict: false,
          validateOn: 'change',
          debounceMs: 0,
          defaultValues: { items: ['aa', 'bbb'] },
        }) as unknown as TestForm
    )
)

runSuite(
  'v4',
  () =>
    mountWithApp(
      () =>
        useFormV4({
          schema: zV4.object({ tags: zV4.array(zV4.string().min(3, 'min3')) }),
          key: `sds-drop-v4-${Math.random()}`,
          strict: false,
          validateOn: 'change',
          debounceMs: 0,
          defaultValues: { tags: ['ab', 'abc'] },
        }) as unknown as TestForm
    ),
  () =>
    mountWithApp(
      () =>
        useFormV4({
          schema: zV4.object({ items: zV4.array(zV4.string().refine(asyncCheck, 'min3')) }),
          key: `sds-async-v4-${Math.random()}`,
          strict: false,
          validateOn: 'change',
          debounceMs: 0,
          defaultValues: { items: ['aa', 'bbb'] },
        }) as unknown as TestForm
    )
)
