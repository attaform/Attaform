// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'
import { waitUntil } from '../utils/form-harness'

/**
 * Pins the "authored" set's lifecycle past construction.
 *
 * `authoredPaths` (the discriminator the schema-error filter uses to
 * decide whether to suppress a verdict at an undefined preprocess /
 * coerce leaf) is populated at construction from the consumer's
 * `defaultValues` argument and from the schema's declared
 * `.default(...)` chains. But the consumer can author paths AFTER
 * construction via three other surfaces, and each must update
 * `authoredPaths` so subsequent validation runs surface the verdict
 * the consumer asked for:
 *
 *   1. Async `defaultValues: async () => (...)` resolves on a
 *      microtask after construction.
 *   2. `form.reset(nextDefaultValues)` lands a fresh override on
 *      demand.
 *   3. `form.setValue(path, undefined)` explicitly writes undefined
 *      at a single path.
 *
 * Without authoring updates at each of these moments, the filter
 * would consult the stale construction-time set and incorrectly
 * suppress the verdict — same flicker pattern as the
 * construction-time bug, just deferred.
 */

const INVALID_URL = '__invalid__'

const schema = z.object({
  url: z.preprocess(
    (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : INVALID_URL),
    z.string().refine(async (val) => val !== INVALID_URL, {
      error: () => 'Please enter a URL.',
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

describe('authored-paths updates beyond construction', () => {
  const unmounts: Array<() => void> = []
  afterEach(() => {
    while (unmounts.length > 0) unmounts.pop()?.()
  })

  it('async defaultValues factory with explicit undefined: validation fires after resolve', async () => {
    const { api, unmount } = mountForm(() =>
      useForm({
        schema,
        key: uniqueKey('async-factory-undef'),
        defaultValues: async () => ({ url: undefined }),
      })
    )
    unmounts.push(unmount)

    // Construction baseline: no defaults, errors empty (suppressed
    // against the runtime "no value yet").
    await nextTick()

    // Lazy activation: kick the factory explicitly, then wait for the
    // validation verdict to land. The post-resolution validation sweep
    // runs through preprocess + refine asynchronously; poll the
    // positive signal (errors populated) rather than guessing a wall-
    // clock budget.
    await api.activate()
    await waitUntil(() => (api.errors.url.length > 0 ? true : null))

    // The factory landed `{ url: undefined }`. The path is now
    // authored — distinct from "no consumer input." Validation runs
    // through preprocess + refine and lands the verdict.
    expect(api.values.url).toBeUndefined()
    expect(api.errors.url.length).toBeGreaterThan(0)
    expect(api.errors.url[0]?.message).toBe('Please enter a URL.')
  })

  it('reset with explicit undefined: validation fires after reset', async () => {
    const { api, unmount } = mountForm(() => useForm({ schema, key: uniqueKey('reset-undef') }))
    unmounts.push(unmount)

    await nextTick()
    await new Promise((r) => setTimeout(r, 20))
    // Baseline: construction-time verdict suppressed (no authored).
    expect(api.errors.url).toEqual([])

    api.reset({ url: undefined })
    await waitUntil(() => (api.errors.url.length > 0 ? true : null))

    expect(api.values.url).toBeUndefined()
    expect(api.errors.url.length).toBeGreaterThan(0)
    expect(api.errors.url[0]?.message).toBe('Please enter a URL.')
  })

  it('setValue with explicit undefined: validation fires after the write', async () => {
    const { api, unmount } = mountForm(() =>
      useForm({
        schema,
        key: uniqueKey('setvalue-undef'),
        validateOn: 'change',
        debounceMs: 0,
      })
    )
    unmounts.push(unmount)

    await nextTick()
    await new Promise((r) => setTimeout(r, 20))
    expect(api.errors.url).toEqual([])

    // setValue with explicit undefined authors the path. The
    // change-mode validation sweep that follows the write picks up
    // the verdict.
    api.setValue('url', undefined as never)
    await waitUntil(() => (api.errors.url.length > 0 ? true : null))

    expect(api.values.url).toBeUndefined()
    expect(api.errors.url.length).toBeGreaterThan(0)
    expect(api.errors.url[0]?.message).toBe('Please enter a URL.')
  })
})
