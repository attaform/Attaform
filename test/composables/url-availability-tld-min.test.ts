// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Pins the URL-availability demo's TLD policy: a parsed URL must have
 * a TLD of at least two characters. Mirrors the recipe page's
 * `formatUrl` semantic — the demo claims to gate against "real-world
 * domain shapes," and 1-character TLDs (`https://a.b`) are not real.
 *
 * Without this gate, the WHATWG URL parser accepts `https://a.b` as a
 * valid URL with host `a.b` and lets it through to the availability
 * check, which then reports "available" for an input that no real
 * signup form would accept.
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

const EMPTY_URL = '__atta:empty-url__'
const INVALID_URL = '__atta:invalid-url__'

function formatUrl(v: unknown): string {
  if (typeof v !== 'string') return INVALID_URL
  const trimmed = v.trim()
  if (trimmed.length === 0) return EMPTY_URL
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const parsed = new URL(withProtocol)
    // WHATWG URL accepts `https://a.b` and `https://ersdg` as
    // structurally valid; for a site-availability demo we want
    // domain-shaped hosts only, with a TLD that's at least two
    // characters.
    const dot = parsed.hostname.lastIndexOf('.')
    if (dot === -1) return INVALID_URL
    const tld = parsed.hostname.slice(dot + 1)
    if (tld.length < 2) return INVALID_URL
    return parsed.href.replace(/\/$/, '')
  } catch {
    return INVALID_URL
  }
}

const schema = z.object({
  url: z.preprocess(
    formatUrl,
    z.string().refine(async (val) => val !== EMPTY_URL && val !== INVALID_URL, {
      error: (issue) => {
        const val = issue.input as string
        return val === EMPTY_URL
          ? 'Please enter a URL.'
          : val === INVALID_URL
            ? "That doesn't look like a URL."
            : `${val} is already taken.`
      },
    })
  ),
})

describe('URL-availability demo: TLD must be at least two characters', () => {
  const unmounts: Array<() => void> = []
  afterEach(() => {
    while (unmounts.length > 0) unmounts.pop()?.()
  })

  it('rejects a 1-character TLD (https://a.b)', async () => {
    const { api, unmount } = mountForm(() => useForm({ schema, key: uniqueKey('tld-short') }))
    unmounts.push(unmount)

    api.setValue('url', 'a.b')
    await api.validateAsync('url')

    expect(api.errors.url[0]?.message).toBe("That doesn't look like a URL.")
  })

  it('rejects a host with no dot at all (https://ersdg)', async () => {
    const { api, unmount } = mountForm(() => useForm({ schema, key: uniqueKey('tld-nodot') }))
    unmounts.push(unmount)

    api.setValue('url', 'ersdg')
    await api.validateAsync('url')

    expect(api.errors.url[0]?.message).toBe("That doesn't look like a URL.")
  })

  it('accepts a 2-character TLD (something.co)', async () => {
    const { api, unmount } = mountForm(() => useForm({ schema, key: uniqueKey('tld-two') }))
    unmounts.push(unmount)

    api.setValue('url', 'something.co')
    await api.validateAsync('url')

    // Either no error (available) or the "taken" message — never the
    // "doesn't look like a URL" branch.
    expect(api.errors.url[0]?.message).not.toBe("That doesn't look like a URL.")
  })

  it('accepts a long TLD (project.engineering)', async () => {
    const { api, unmount } = mountForm(() => useForm({ schema, key: uniqueKey('tld-long') }))
    unmounts.push(unmount)

    api.setValue('url', 'project.engineering')
    await api.validateAsync('url')

    expect(api.errors.url[0]?.message).not.toBe("That doesn't look like a URL.")
  })
})
