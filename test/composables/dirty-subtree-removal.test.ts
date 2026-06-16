// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * #420, folded-in sibling: removing a whole baseline-present subtree by writing
 * a non-container over it must dirty the form. `setValue('profile', undefined)`
 * (object) and `setValue('tags', undefined)` (array) both drop every leaf under
 * the path from the live value at once, so the present-leaf dirty walk never
 * visits the vanished leaves and the array identity tracker (array -> array
 * only) can't see it. A `removedSubtrees` record closes that gap.
 *
 * The mechanism is baseline-aware and self-clearing, so the guards below pin all
 * three edges: an optional section absent at construction stays pristine across
 * an add-then-remove; refilling the path with the seeded value lands pristine
 * (the leaf walk judges the refill), a different value dirties; and `reset()`
 * re-baselines so a prior removal stops counting. Both adapters.
 */

type DirtyForm = {
  meta: { dirty: boolean }
  setValue: (path: string, value: unknown) => void
  reset: () => void
  values: Record<string, unknown>
}

const apps: App[] = []
afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
  document.body.innerHTML = ''
})

function mountWithApp(setup: () => DirtyForm): DirtyForm {
  const handle: { captured?: DirtyForm } = {}
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

function runSuite(label: string, build: () => DirtyForm): void {
  describe(`subtree removal dirties the form (${label})`, () => {
    it('dirties when a seeded object subtree is set to undefined (B1)', () => {
      const form = build()
      expect(form.meta.dirty).toBe(false)
      form.setValue('profile', undefined)
      expect(form.values['profile']).toBeUndefined()
      expect(form.meta.dirty).toBe(true)
    })

    it('dirties when a seeded array subtree is set to undefined (B2)', () => {
      const form = build()
      expect(form.meta.dirty).toBe(false)
      form.setValue('tags', undefined)
      expect(form.values['tags']).toBeUndefined()
      expect(form.meta.dirty).toBe(true)
    })

    it('stays pristine removing an optional section absent at construction', () => {
      // `opt` is explicitly `undefined` in the defaults, so it has no baseline
      // (schema optionals named in the defaults are otherwise pre-filled with
      // slim values). Adding then removing it is a round-trip back to baseline,
      // so the baseline-presence gate must keep it out of `removedSubtrees`.
      const form = build()
      form.setValue('opt', { note: 'hi' })
      expect(form.meta.dirty).toBe(true)
      form.setValue('opt', undefined)
      expect(form.meta.dirty).toBe(false)
    })

    it('returns to pristine when the subtree is refilled with its seeded value', () => {
      const form = build()
      form.setValue('profile', undefined)
      expect(form.meta.dirty).toBe(true)
      form.setValue('profile', { name: 'Sam' })
      expect(form.meta.dirty).toBe(false)
    })

    it('stays dirty when the subtree is refilled with a different value', () => {
      const form = build()
      form.setValue('profile', undefined)
      form.setValue('profile', { name: 'Pat' })
      expect(form.meta.dirty).toBe(true)
    })

    it('rebaselines on reset after a subtree removal', () => {
      const form = build()
      form.setValue('profile', undefined)
      expect(form.meta.dirty).toBe(true)
      form.reset()
      expect(form.meta.dirty).toBe(false)
    })
  })
}

runSuite('v4', () =>
  mountWithApp(
    () =>
      useFormV4({
        schema: zV4.object({
          profile: zV4.object({ name: zV4.string() }).optional(),
          tags: zV4.array(zV4.string()).optional(),
          opt: zV4.object({ note: zV4.string() }).optional(),
        }),
        key: `dirty-subtree-v4-${Math.random()}`,
        defaultValues: { profile: { name: 'Sam' }, tags: ['x', 'y'], opt: undefined },
      }) as unknown as DirtyForm
  )
)

runSuite('v3', () =>
  mountWithApp(
    () =>
      useFormV3({
        schema: zV3.object({
          profile: zV3.object({ name: zV3.string() }).optional(),
          tags: zV3.array(zV3.string()).optional(),
          opt: zV3.object({ note: zV3.string() }).optional(),
        }),
        key: `dirty-subtree-v3-${Math.random()}`,
        defaultValues: { profile: { name: 'Sam' }, tags: ['x', 'y'], opt: undefined },
      }) as unknown as DirtyForm
  )
)
