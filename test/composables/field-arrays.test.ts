// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { useForm } from '../../src'
import { attachRegistryToApp, createRegistry } from '../../src/runtime/core/registry'
import type { UseFormReturnType } from '../../src/runtime/types/types-api'
import { fakeSchema } from '../utils/fake-schema'

/**
 * Runtime coverage for Phase 8.5 — typed array helpers.
 *
 * Each helper is a thin wrapper over read-array + slice + splice +
 * setValueAtPath. The tests pin runtime semantics that consumers depend
 * on (append goes to end, swap preserves siblings, replace never grows,
 * etc.) — if a future refactor moves the logic, these guarantee the
 * observable behaviour stays the same.
 *
 * Type-level rejections (non-array path, mismatched element shape) live
 * alongside the rest of the type-inference suite.
 */

type Post = { title: string; views: number }
type BlogForm = {
  title: string
  tags: string[]
  posts: Post[]
}

const defaults: BlogForm = {
  title: 'untitled',
  tags: [],
  posts: [],
}

function harness(initial?: Partial<BlogForm>) {
  let captured!: UseFormReturnType<BlogForm>
  const Probe = defineComponent({
    setup() {
      captured = useForm<BlogForm>({
        schema: fakeSchema<BlogForm>({ ...defaults, ...initial }),
        key: `fa-${Math.random().toString(36).slice(2)}`,
      })
      return () => h('div')
    },
  })
  const app = createApp(Probe)
  attachRegistryToApp(app, createRegistry())
  app.mount(document.createElement('div'))
  return { app, form: captured }
}

describe('useForm — field array helpers', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  describe('append', () => {
    it('adds an item at the end of a scalar array', () => {
      const { app, form } = harness({ tags: ['a', 'b'] })
      apps.push(app)
      form.append('tags', 'c')
      expect(form.values.tags).toEqual(['a', 'b', 'c'])
    })

    it('adds an object item at the end of an array-of-object path', () => {
      const { app, form } = harness({ posts: [{ title: 'first', views: 1 }] })
      apps.push(app)
      form.append('posts', { title: 'second', views: 0 })
      expect(form.values.posts).toEqual([
        { title: 'first', views: 1 },
        { title: 'second', views: 0 },
      ])
    })

    it('treats an unset (undefined) path as an empty array', () => {
      const { app, form } = harness()
      apps.push(app)
      form.append('tags', 'first')
      expect(form.values.tags).toEqual(['first'])
    })
  })

  describe('prepend', () => {
    it('adds an item at the start', () => {
      const { app, form } = harness({ tags: ['b', 'c'] })
      apps.push(app)
      form.prepend('tags', 'a')
      expect(form.values.tags).toEqual(['a', 'b', 'c'])
    })
  })

  describe('insert', () => {
    it('inserts at the given index, shifting subsequent items', () => {
      const { app, form } = harness({ tags: ['a', 'c'] })
      apps.push(app)
      form.insert('tags', 1, 'b')
      expect(form.values.tags).toEqual(['a', 'b', 'c'])
    })

    it('inserting past `length` appends (Array.splice clamping)', () => {
      const { app, form } = harness({ tags: ['a'] })
      apps.push(app)
      form.insert('tags', 99, 'b')
      expect(form.values.tags).toEqual(['a', 'b'])
    })
  })

  describe('remove', () => {
    it('removes the element at the given index and shifts the tail', () => {
      const { app, form } = harness({ tags: ['a', 'b', 'c'] })
      apps.push(app)
      form.remove('tags', 1)
      expect(form.values.tags).toEqual(['a', 'c'])
    })

    it('no-ops on an out-of-range index (never grows or shrinks incorrectly)', () => {
      const { app, form } = harness({ tags: ['a', 'b'] })
      apps.push(app)
      form.remove('tags', 5)
      expect(form.values.tags).toEqual(['a', 'b'])
      form.remove('tags', -1)
      expect(form.values.tags).toEqual(['a', 'b'])
    })
  })

  describe('swap', () => {
    it('exchanges two elements without disturbing siblings', () => {
      const { app, form } = harness({ tags: ['a', 'b', 'c', 'd'] })
      apps.push(app)
      form.swap('tags', 1, 2)
      expect(form.values.tags).toEqual(['a', 'c', 'b', 'd'])
    })

    it('no-ops on out-of-range indices', () => {
      const { app, form } = harness({ tags: ['a', 'b'] })
      apps.push(app)
      form.swap('tags', 0, 10)
      expect(form.values.tags).toEqual(['a', 'b'])
    })

    it('no-ops when a === b', () => {
      const { app, form } = harness({ tags: ['a', 'b'] })
      apps.push(app)
      const before = form.values.tags
      form.swap('tags', 1, 1)
      expect(form.values.tags).toEqual(before)
    })
  })

  describe('move', () => {
    it('moves an item from one index to another, preserving order elsewhere', () => {
      const { app, form } = harness({ tags: ['a', 'b', 'c', 'd'] })
      apps.push(app)
      form.move('tags', 0, 2)
      expect(form.values.tags).toEqual(['b', 'c', 'a', 'd'])
    })

    it('moves to 0 puts the item at the start', () => {
      const { app, form } = harness({ tags: ['a', 'b', 'c'] })
      apps.push(app)
      form.move('tags', 2, 0)
      expect(form.values.tags).toEqual(['c', 'a', 'b'])
    })

    it('clamps `to` to length (moving to past-end appends)', () => {
      const { app, form } = harness({ tags: ['a', 'b', 'c'] })
      apps.push(app)
      form.move('tags', 0, 99)
      expect(form.values.tags).toEqual(['b', 'c', 'a'])
    })
  })

  describe('replace', () => {
    it('replaces an element at the given index', () => {
      const { app, form } = harness({ tags: ['a', 'b', 'c'] })
      apps.push(app)
      form.replace('tags', 1, 'B')
      expect(form.values.tags).toEqual(['a', 'B', 'c'])
    })

    it('does NOT grow the array on out-of-range index', () => {
      const { app, form } = harness({ tags: ['a'] })
      apps.push(app)
      form.replace('tags', 3, 'BAD')
      expect(form.values.tags).toEqual(['a'])
    })

    it('replaces an object item', () => {
      const { app, form } = harness({ posts: [{ title: 'first', views: 1 }] })
      apps.push(app)
      form.replace('posts', 0, { title: 'second', views: 2 })
      expect(form.values.posts).toEqual([{ title: 'second', views: 2 }])
    })
  })

  describe('field-proxy enumeration over an array container', () => {
    it('exposes appended indices as own keys on form.fields.<arrayPath>', () => {
      const { app, form } = harness({ posts: [] })
      apps.push(app)
      form.append('posts', { title: 'first', views: 1 })
      form.append('posts', { title: 'second', views: 2 })
      // The template pattern `v-for="(item, idx) in form.fields.posts"`
      // reads ownKeys to drive iteration; without indices in the key
      // set, Vue renders zero rows even though the underlying array
      // has entries.
      expect(Object.keys(form.fields.posts)).toEqual(['0', '1'])
    })

    it('Object.entries yields one descended sub-proxy per live index', () => {
      const { app, form } = harness({ posts: [] })
      apps.push(app)
      form.append('posts', { title: 'first', views: 1 })
      form.append('posts', { title: 'second', views: 2 })
      const entries = Object.entries(form.fields.posts)
      expect(entries).toHaveLength(2)
      expect(entries.map(([k]) => k)).toEqual(['0', '1'])
      // Each entry value is a descended surface proxy (callable
      // function target). Identity matches dot-access to confirm the
      // descriptor returns the same proxy `form.fields.posts[idx]`
      // would yield — the load-bearing guarantee for v-for templates
      // that read `item.title.errors`, `item.sku.validating`, etc.
      const directAtZero = (form.fields.posts as unknown as Record<string, unknown>)['0']
      expect(entries[0]?.[1]).toBe(directAtZero)
      expect(typeof entries[0]?.[1]).toBe('function')
    })

    it('removed indices drop from the enumerated key set', () => {
      const { app, form } = harness({ posts: [] })
      apps.push(app)
      form.append('posts', { title: 'a', views: 1 })
      form.append('posts', { title: 'b', views: 2 })
      form.append('posts', { title: 'c', views: 3 })
      form.remove('posts', 1)
      expect(Object.keys(form.fields.posts)).toEqual(['0', '1'])
    })

    it('Vue v-for over form.fields.<arrayPath> renders one node per live index', async () => {
      let captured!: UseFormReturnType<BlogForm>
      const host = document.createElement('div')
      const Probe = defineComponent({
        setup() {
          captured = useForm<BlogForm>({
            schema: fakeSchema<BlogForm>({ ...defaults, posts: [] }),
            key: `fa-vfor-${Math.random().toString(36).slice(2)}`,
          })
          return { fields: captured.fields }
        },
        template: `<ul><li v-for="(_, idx) in fields.posts" :key="idx" data-row>{{ idx }}</li></ul>`,
      })
      const app = createApp(Probe)
      attachRegistryToApp(app, createRegistry())
      app.mount(host)
      apps.push(app)
      captured.append('posts', { title: 'first', views: 1 })
      captured.append('posts', { title: 'second', views: 2 })
      await new Promise((resolve) => setTimeout(resolve, 0))
      const rows = host.querySelectorAll('[data-row]')
      expect(rows.length).toBe(2)
    })
  })

  it('mutations trigger reactivity (form.values sees the update)', () => {
    const { app, form } = harness({ tags: ['a'] })
    apps.push(app)
    expect(form.values.tags).toEqual(['a'])
    form.append('tags', 'b')
    // Reading through the proxy re-tracks the underlying form ref, so
    // the second read reflects the post-mutation array.
    expect(form.values.tags).toEqual(['a', 'b'])
  })

  it('append flips dirty (newly-introduced leaves count as mutations)', () => {
    // Regression: previously the post-init originals capture treated
    // `append`'d items as "always pristine" because the new path's
    // first-seen value was recorded as its own baseline.
    const { app, form } = harness({ tags: [] })
    apps.push(app)
    expect(form.meta.dirty).toBe(false)
    form.append('tags', 'first')
    expect(form.meta.dirty).toBe(true)
  })

  it('remove flips dirty (removing an originals-tracked leaf is a mutation)', () => {
    const { app, form } = harness({ tags: ['a', 'b'] })
    apps.push(app)
    expect(form.meta.dirty).toBe(false)
    form.remove('tags', 0)
    expect(form.meta.dirty).toBe(true)
  })
})
