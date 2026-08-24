// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Pins the runtime shape of `form.errors.<preprocess-leaf>`.
 *
 * The `form.errors` proxy terminates at statically-known leaves and
 * surfaces `readonly ValidationError[]`. At a preprocess-wrapped leaf
 * the proxy must terminate too, even though the StorageShape at the
 * type level is `unknown`: the surface contract is the same.
 *
 * Before the slim-primitives fix, `slimPrimitivesOf` for a pipe with
 * a transform on the input side returned PERMISSIVE (full kind set),
 * making `isLeafAtPath` report `false`. The errors proxy then walked
 * past the leaf and handed back a callable sub-proxy instead of the
 * merged error array, breaking `form.errors.url[0]?.message` reads.
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

const SENTINEL = '__rejected__'

const schema = z.object({
  url: z.preprocess(
    (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : SENTINEL),
    z.string().refine(async (val) => val !== SENTINEL, {
      error: (issue) => {
        const val = issue.input as string
        return val === SENTINEL ? 'Rejected by refine.' : 'Other error.'
      },
    })
  ),
})

describe('form.errors at a preprocess leaf: terminates as an array, not a sub-proxy', () => {
  const unmounts: Array<() => void> = []
  afterEach(() => {
    while (unmounts.length > 0) unmounts.pop()?.()
  })

  it('at mount with no errors, form.errors.url is an empty array', () => {
    const { api, unmount } = mountForm(() => useForm({ schema, key: uniqueKey('pp-errors-empty') }))
    unmounts.push(unmount)

    expect(Array.isArray(api.errors.url)).toBe(true)
    expect(api.errors.url).toEqual([])
  })

  it('after async validation rejects, form.errors.url[0].message is the consumer string', async () => {
    const { api, unmount } = mountForm(() =>
      useForm({ schema, key: uniqueKey('pp-errors-rejected') })
    )
    unmounts.push(unmount)

    api.setValue('url', '')
    await api.parse('url', { commit: true })

    expect(Array.isArray(api.errors.url)).toBe(true)
    expect(api.errors.url.length).toBeGreaterThan(0)
    expect(typeof api.errors.url[0]?.message).toBe('string')
    expect(api.errors.url[0]?.message).toBe('Rejected by refine.')
  })
})
