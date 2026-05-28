// @vitest-environment jsdom
/**
 * PASS2-9 — `fieldValidationCounts` (the per-path in-flight async-
 * validation counter that backs `field.validating`) was not relocated
 * across array structural mutations alongside the other path-keyed
 * maps. An async validation that landed mid-`move` left the spinner
 * on the OLD outer index (now occupied by a different element) until
 * the next validation pass overwrote the entry — visible flicker on a
 * row that wasn't actually validating.
 *
 * The fix plugs `fieldValidationCounts` into the existing
 * `migrateMapSubtree` sweep in `migrateArrayElementState`, mirroring
 * the treatment of `fields` / `originals` / `userErrors`. We pin it
 * by reading the FormStore directly via `inject(kFormContext)`,
 * seeding the counter at a pre-mutation index, replaying the array
 * move, and asserting the entry follows the element. Going through
 * the real async-validation pipeline would couple the test to
 * scheduler timing the migration semantics don't depend on.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, inject, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'
import { kFormContext } from '../../src/runtime/core/registry'
import { canonicalizePath } from '../../src/runtime/core/paths'
import type { FormStore } from '../../src/runtime/core/create-form-store'
import type { GenericForm } from '../../src/runtime/types/types-core'

const schemaV4 = zV4.object({ tags: zV4.array(zV4.string()) })
const schemaV3 = zV3.object({ tags: zV3.array(zV3.string()) })
const defaults = { tags: ['a', 'b', 'c'] }

const adapters = [
  { name: 'v4', useForm: useFormV4, schema: schemaV4 },
  { name: 'v3', useForm: useFormV3, schema: schemaV3 },
] as const

describe.each(adapters)('fieldValidationCounts migration — $name', ({ useForm, schema }) => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  function mountOne(): {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    form: any
    store: FormStore<GenericForm>
  } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let form: any
    let store: FormStore<GenericForm> | undefined
    const Root = defineComponent({
      setup() {
        // Anonymous useForm (no `key`) so the FormStore is provided as
        // `kFormContext` to descendants — see use-abstract-form.ts:493.
        form = useForm({
          schema,
          strict: false,
          defaultValues: defaults,
        })
        return () => h(Child)
      },
    })
    const Child = defineComponent({
      setup() {
        store = inject(kFormContext)
        return () => h('div')
      },
    })
    const app = createApp(Root).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    apps.push(app)
    if (store === undefined) throw new Error('kFormContext was not injected')
    return { form, store }
  }

  const key = (path: readonly (string | number)[]) => canonicalizePath(path).key

  it('move relocates the counter from old index to new index', () => {
    const { form, store } = mountOne()
    store.fieldValidationCounts.set(key(['tags', 1]), 1)

    form.move('tags', 1, 0)

    expect(store.fieldValidationCounts.get(key(['tags', 0]))).toBe(1)
    expect(store.fieldValidationCounts.has(key(['tags', 1]))).toBe(false)
  })

  it('swap relocates counters in both directions', () => {
    const { form, store } = mountOne()
    store.fieldValidationCounts.set(key(['tags', 0]), 1)
    store.fieldValidationCounts.set(key(['tags', 2]), 2)

    form.swap('tags', 0, 2)

    expect(store.fieldValidationCounts.get(key(['tags', 0]))).toBe(2)
    expect(store.fieldValidationCounts.get(key(['tags', 2]))).toBe(1)
  })

  it('remove drops the counter at the removed index and shifts the rest down', () => {
    const { form, store } = mountOne()
    store.fieldValidationCounts.set(key(['tags', 0]), 1)
    store.fieldValidationCounts.set(key(['tags', 2]), 2)

    form.remove('tags', 0)

    // Pre-op `tags.0` ('a', counter=1) is vacated and dropped. Pre-op
    // `tags.1` ('b', no counter) shifts to index 0 — no counter to migrate.
    // Pre-op `tags.2` ('c', counter=2) shifts to index 1.
    expect(store.fieldValidationCounts.has(key(['tags', 0]))).toBe(false)
    expect(store.fieldValidationCounts.get(key(['tags', 1]))).toBe(2)
    expect(store.fieldValidationCounts.has(key(['tags', 2]))).toBe(false)
  })

  it('insert shifts counters at and past the insert position up by one', () => {
    const { form, store } = mountOne()
    store.fieldValidationCounts.set(key(['tags', 1]), 1)

    form.insert('tags', 1, 'X')

    // tags.1 → tags.2.
    expect(store.fieldValidationCounts.get(key(['tags', 2]))).toBe(1)
    expect(store.fieldValidationCounts.has(key(['tags', 1]))).toBe(false)
  })
})
