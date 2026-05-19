// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { nextTick } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Pins suppression of construction-time validation verdicts at
 * unsupplied preprocess / coerce leaves.
 *
 * The adapter's `validateAtPath` drops issues whose path resolves to
 * a `z.preprocess` / `z.coerce.X()` wrapper AND whose data is
 * undefined. Without the filter the construction-time async-validation
 * seed runs against the no-write-mutation default (`undefined` at
 * those leaves), the preprocess fn returns its INVALID-shape sentinel,
 * refine rejects, and the verdict lands in `schemaErrors` invisible
 * until the field is touched-and-dirty — flickering into view the
 * moment the consumer starts typing.
 *
 * Suppression is targeted: as soon as the consumer supplies a value
 * (via `defaultValues` or `setValue`), validation runs normally and
 * legitimate verdicts surface.
 */

const EMPTY_URL = '__empty__'
const INVALID_URL = '__invalid__'

const schema = z.object({
  url: z.preprocess(
    (v: unknown) => {
      if (typeof v !== 'string') return INVALID_URL
      const trimmed = v.trim()
      if (trimmed.length === 0) return EMPTY_URL
      return trimmed
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

describe('preprocess / coerce leaves: mount-time verdicts against undefined are suppressed', () => {
  const unmounts: Array<() => void> = []
  afterEach(() => {
    while (unmounts.length > 0) unmounts.pop()?.()
  })

  it('no defaultValues + async-refine schema: schemaErrors stays empty at mount', async () => {
    const { api, unmount } = mountForm(() =>
      useForm({ schema, key: uniqueKey('mount-suppress'), validateOn: 'blur' })
    )
    unmounts.push(unmount)

    // Wait through the queued microtask + the async refine's resolve.
    await nextTick()
    await new Promise((r) => setTimeout(r, 20))

    expect(api.values.url).toBeUndefined()
    expect(api.errors.url).toEqual([])
  })

  it('suppression is targeted: defaultValues at the leaf re-enables the verdict', async () => {
    const { api, unmount } = mountForm(() =>
      useForm({
        schema,
        key: uniqueKey('mount-supplied'),
        defaultValues: { url: '' },
      })
    )
    unmounts.push(unmount)

    await nextTick()
    await new Promise((r) => setTimeout(r, 20))

    // Storage holds the consumer's empty string; preprocess returns
    // EMPTY_URL; refine rejects with the "Please enter a URL" message.
    // The verdict IS legitimate (against a value the consumer supplied)
    // and must surface in schemaErrors.
    expect(api.values.url).toBe('')
    expect(api.errors.url.length).toBeGreaterThan(0)
    expect(api.errors.url[0]?.message).toBe('Please enter a URL.')
  })
})
