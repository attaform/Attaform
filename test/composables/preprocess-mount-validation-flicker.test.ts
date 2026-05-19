// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { nextTick } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Pins the clear-on-write contract: a `setValue` at a path invalidates
 * any prior schema-source verdict at that path. Without this, the
 * construction-time async-validation seed runs against the no-write-
 * mutation default (`undefined` at preprocess leaves), the preprocess
 * fn returns its INVALID_URL sentinel, refine rejects, and the stale
 * "doesn't look like a URL" error sits in `form.errors.url` — invisible
 * until the field is touched, then visible for the brief window
 * between "user blurred" and "new validation completed."
 *
 * The fix lives at the write boundary: `setValueAtPath` clears
 * schemaErrors at the path it just wrote, so the next render shows
 * "no error" until the new validation lands. Eliminates the flicker
 * and also handles any "stale error from a prior value" pattern.
 */

const EMPTY_URL = '__empty__'
const INVALID_URL = '__invalid__'

const schema = z.object({
  url: z.preprocess(
    (v: unknown) => {
      if (typeof v !== 'string') return INVALID_URL
      const trimmed = v.trim()
      if (trimmed.length === 0) return EMPTY_URL
      return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    },
    z.string().refine(async (val) => val !== EMPTY_URL && val !== INVALID_URL, {
      error: (issue) => {
        const val = issue.input as string
        return val === EMPTY_URL
          ? 'Please enter a URL.'
          : val === INVALID_URL
            ? "That doesn't look like a URL."
            : 'Other.'
      },
    })
  ),
})

function mountForm<R>(setup: () => R): { api: R; unmount: () => void } {
  let captured: R | undefined
  const App = defineComponent({
    setup() {
      captured = setup()
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.mount(document.createElement('div'))
  return { api: captured as R, unmount: () => app.unmount() }
}

function uniqueKey(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`
}

describe('setValue clears stale schemaErrors at the write path', () => {
  const unmounts: Array<() => void> = []
  afterEach(() => {
    while (unmounts.length > 0) unmounts.pop()?.()
  })

  it('mount-time validation seeds an error against undefined; first setValue clears it', async () => {
    const { api, unmount } = mountForm(() =>
      useForm({ schema, key: uniqueKey('flicker-blur'), validateOn: 'blur' })
    )
    unmounts.push(unmount)

    // Let the construction-time async-validation seed settle. It
    // populates schemaErrors with an INVALID_URL verdict because
    // storage at the preprocess leaf is undefined.
    await nextTick()
    await new Promise((r) => setTimeout(r, 5))
    expect(api.errors.url.length).toBeGreaterThan(0)

    // The first write at the path drops the stale verdict. The
    // directive renders against this state in the gap between
    // "user blurred" and "new validation completed."
    api.setValue('url', 'xyz')
    expect(api.errors.url).toEqual([])
  })

  it('setValue at a different path leaves errors at sibling paths intact', async () => {
    const twoFieldSchema = z.object({
      url: z.preprocess(
        (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : INVALID_URL),
        z.string().refine(async (val) => val !== INVALID_URL, {
          error: () => 'url invalid',
        })
      ),
      name: z.string().refine((s) => s.length > 0, { error: 'name required' }),
    })
    const { api, unmount } = mountForm(() =>
      useForm({ schema: twoFieldSchema, key: uniqueKey('flicker-sibling') })
    )
    unmounts.push(unmount)

    await nextTick()
    await new Promise((r) => setTimeout(r, 5))

    // Seed both errors.
    await api.validateAsync()

    // Verify both surfaces have errors before the write.
    expect(api.errors.url.length).toBeGreaterThan(0)
    expect(api.errors.name.length).toBeGreaterThan(0)

    // Writing to `name` must not touch `url`'s errors.
    api.setValue('name', 'Alex')
    expect(api.errors.name).toEqual([])
    expect(api.errors.url.length).toBeGreaterThan(0)
  })
})
