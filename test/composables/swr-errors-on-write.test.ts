// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Pins the stale-while-revalidate semantic for schema-source errors.
 *
 * When the consumer edits a field that already carries a verdict, the
 * runtime keeps the prior verdict visible until a new validation
 * lands. The alternative — clearing errors at the write boundary —
 * produces an "error → no error → error" UI between "value changed"
 * and "next validation completed," which reads as a flicker when the
 * value is still invalid against the schema.
 *
 * Two cases pin the contract:
 *
 *   1. setValue alone does NOT clear schemaErrors at the write path.
 *      Render reflects the prior verdict until validation runs.
 *   2. parse({ commit: true }) REPLACES the verdict (not clear-then-re-add)
 *      when the new value is still invalid. Same path, different
 *      message — no empty window in between.
 */

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

const TAKEN = new Set(['https://google.com', 'https://apple.com'])

const schema = z.object({
  url: z.preprocess(
    (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : '__invalid__'),
    z.string().refine(
      async (val) => {
        if (val === '__invalid__') return false
        return !TAKEN.has(val)
      },
      {
        error: (issue) => {
          const val = issue.input as string
          return val === '__invalid__' ? "That doesn't look like a URL." : `${val} is taken.`
        },
      }
    )
  ),
})

describe('schema-source errors follow a stale-while-revalidate pattern across writes', () => {
  const unmounts: Array<() => void> = []
  afterEach(() => {
    while (unmounts.length > 0) unmounts.pop()?.()
  })

  it('setValue at the write path does not clear schemaErrors mid-flight', async () => {
    const { api, unmount } = mountForm(() =>
      useForm({
        schema,
        key: uniqueKey('swr-persists'),
        defaultValues: { url: 'https://google.com' },
      })
    )
    unmounts.push(unmount)

    // Land the initial verdict via the construction-time async seed
    // (strict + needsAsyncValidation). The seed runs on the next
    // microtask, then the async refine resolves.
    await nextTick()
    await new Promise((r) => setTimeout(r, 20))
    expect(api.errors.url.length).toBeGreaterThan(0)
    const initialMessage = api.errors.url[0]?.message
    expect(initialMessage).toContain('taken')

    // Edit the value. SWR contract: the prior verdict stays in place
    // until the next validation completes. The directive renders the
    // prior message against the new input — better than blanking the
    // field and re-surfacing the error a tick later.
    api.setValue('url', 'https://apple.com')

    expect(api.errors.url.length).toBeGreaterThan(0)
    expect(api.errors.url[0]?.message).toBe(initialMessage)
  })

  it('a follow-up validation replaces the prior verdict in a single transition', async () => {
    const { api, unmount } = mountForm(() =>
      useForm({
        schema,
        key: uniqueKey('swr-replaces'),
        defaultValues: { url: 'https://google.com' },
      })
    )
    unmounts.push(unmount)

    // Wait for the seed verdict.
    await nextTick()
    await new Promise((r) => setTimeout(r, 20))
    expect(api.errors.url[0]?.message).toBe('https://google.com is taken.')

    api.setValue('url', 'https://apple.com')

    // SWR: the prior verdict is still showing.
    expect(api.errors.url[0]?.message).toBe('https://google.com is taken.')

    // After the next validation lands, the message updates atomically.
    // Triggering a same-value write at a sibling path with validateOn
    // 'change' (default) drives the schema through one more validation
    // pass; in production the directive's blur / change listener does
    // the same.
    await api.parse({ commit: true })
    await nextTick()
    expect(api.errors.url[0]?.message).toBe('https://apple.com is taken.')
  })
})
