// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Pins the storage default at a schema-side input normalizer leaf.
 *
 * `z.preprocess(fn, inner)` and `z.coerce.X()` declare a write boundary
 * the schema cannot describe in advance (the input type is `unknown`).
 * When the consumer does NOT supply a `defaultValues` entry for such
 * a leaf, storage initialises to `undefined` rather than synthesising
 * the inner schema's slim concrete. The truthful surface: "no value
 * yet, awaiting consumer input."
 *
 * The earlier behaviour walked through the pipe to the inner schema
 * and emitted the inner's falsy (e.g. `''` for `z.string()`), which
 * lied about whether the consumer had supplied anything.
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

describe('preprocess / coerce leaves default to undefined when no defaultValues supplied', () => {
  const unmounts: Array<() => void> = []
  afterEach(() => {
    while (unmounts.length > 0) unmounts.pop()?.()
  })

  it('z.preprocess(fn, z.string()): storage defaults to undefined', () => {
    const schema = z.object({
      url: z.preprocess((v) => v, z.string()),
    })
    const { api, unmount } = mountForm(() => useForm({ schema, key: uniqueKey('pp-default') }))
    unmounts.push(unmount)

    expect(api.values.url).toBeUndefined()
  })

  it('z.preprocess wrapping a refined inner: storage defaults to undefined', () => {
    const schema = z.object({
      url: z.preprocess(
        (v) => v,
        z.string().refine(() => true)
      ),
    })
    const { api, unmount } = mountForm(() =>
      useForm({ schema, key: uniqueKey('pp-default-refine') })
    )
    unmounts.push(unmount)

    expect(api.values.url).toBeUndefined()
  })

  it('z.preprocess wrapping an ASYNC-refined inner: storage defaults to undefined', () => {
    const schema = z.object({
      url: z.preprocess(
        (v) => v,
        z.string().refine(async () => true)
      ),
    })
    const { api, unmount } = mountForm(() =>
      useForm({ schema, key: uniqueKey('pp-default-async-refine') })
    )
    unmounts.push(unmount)

    expect(api.values.url).toBeUndefined()
  })

  it('z.coerce.number(): storage defaults to undefined', () => {
    const schema = z.object({ count: z.coerce.number() })
    const { api, unmount } = mountForm(() => useForm({ schema, key: uniqueKey('coerce-default') }))
    unmounts.push(unmount)

    expect(api.values.count).toBeUndefined()
  })

  it('z.preprocess with explicit defaultValues: storage holds the consumer write', () => {
    const schema = z.object({
      url: z.preprocess((v) => v, z.string()),
    })
    const { api, unmount } = mountForm(() =>
      useForm({
        schema,
        key: uniqueKey('pp-default-with-defaults'),
        defaultValues: { url: 'example.com' },
      })
    )
    unmounts.push(unmount)

    expect(api.values.url).toBe('example.com')
  })

  it('z.preprocess wrapping z.string().default(N): storage honors the schema default', () => {
    const schema = z.object({
      url: z.preprocess((v) => v, z.string().default('https://attaform.dev')),
    })
    const { api, unmount } = mountForm(() =>
      useForm({ schema, key: uniqueKey('pp-default-inner-default') })
    )
    unmounts.push(unmount)

    expect(api.values.url).toBe('https://attaform.dev')
  })

  it('z.coerce.number().default(N): storage honors the schema default', () => {
    const schema = z.object({ count: z.coerce.number().default(42) })
    const { api, unmount } = mountForm(() =>
      useForm({ schema, key: uniqueKey('coerce-default-value') })
    )
    unmounts.push(unmount)

    expect(api.values.count).toBe(42)
  })

  it('z.preprocess inner default + consumer defaultValues: consumer write wins', () => {
    const schema = z.object({
      url: z.preprocess((v) => v, z.string().default('https://schema-default')),
    })
    const { api, unmount } = mountForm(() =>
      useForm({
        schema,
        key: uniqueKey('pp-both-defaults'),
        defaultValues: { url: 'https://consumer-default' },
      })
    )
    unmounts.push(unmount)

    expect(api.values.url).toBe('https://consumer-default')
  })
})
