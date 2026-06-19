// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * #420: removing a seeded array element must dirty the form, symmetrically
 * with adding one. The field VALUE always updated correctly both ways; only
 * the structural dirty verdict was asymmetric. A wholesale `setValue` that
 * shrank a never-rendered array anchored the identity baseline at the
 * already-shortened length (the realign ran after the in-place write), so the
 * removal read structurally pristine. The field-array `remove()` helper was
 * unaffected, because its op replay reconstructs the pre-op length and anchors
 * the baseline before splicing.
 *
 * Motivated by a checkbox group bound to one array path: un-checking a
 * pre-checked box (a removal) left a `:disabled="!form.meta.dirty"` Save button
 * disabled, so a record value already granted could not be revoked. Asserted
 * through the authoritative `setValue` (the checkbox assigner forwards to it),
 * with the `remove()` helper and the symmetric add as parity / regression
 * guards. Both adapters — same runtime contract.
 */

type DirtyForm = {
  meta: { dirty: boolean }
  setValue: (path: string, value: unknown) => void
  remove: (path: string, index: number) => void
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
  describe(`array element removal dirties the form (${label})`, () => {
    it('dirties when a seeded element is removed via wholesale setValue', () => {
      const form = build()
      expect(form.meta.dirty).toBe(false)
      form.setValue('tags', ['a', 'b']) // drop the seeded 'c'
      expect(form.values['tags']).toEqual(['a', 'b'])
      expect(form.meta.dirty).toBe(true)
    })

    it('stays dirty after removing then re-shrinking via setValue', () => {
      const form = build()
      form.setValue('tags', ['a', 'b'])
      form.setValue('tags', ['a'])
      expect(form.values['tags']).toEqual(['a'])
      expect(form.meta.dirty).toBe(true)
    })

    it('dirties when a seeded element is added (symmetric regression guard)', () => {
      const form = build()
      form.setValue('tags', ['a', 'b', 'c', 'd'])
      expect(form.meta.dirty).toBe(true)
    })

    it('dirties when a seeded element is removed via the remove() helper', () => {
      const form = build()
      form.remove('tags', 2)
      expect(form.values['tags']).toEqual(['a', 'b'])
      expect(form.meta.dirty).toBe(true)
    })

    it('stays pristine when setValue rewrites the array to its seeded value', () => {
      const form = build()
      form.setValue('tags', ['a', 'b', 'c'])
      expect(form.meta.dirty).toBe(false)
    })
  })
}

runSuite('v4', () =>
  mountWithApp(
    () =>
      useFormV4({
        schema: zV4.object({ tags: zV4.array(zV4.string()) }),
        key: `dirty-rm-v4-${Math.random()}`,
        defaultValues: { tags: ['a', 'b', 'c'] },
      }) as unknown as DirtyForm
  )
)

runSuite('v3', () =>
  mountWithApp(
    () =>
      useFormV3({
        schema: zV3.object({ tags: zV3.array(zV3.string()) }),
        key: `dirty-rm-v3-${Math.random()}`,
        defaultValues: { tags: ['a', 'b', 'c'] },
      }) as unknown as DirtyForm
  )
)
