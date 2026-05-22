// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Pins the discriminator between "undefined as no-value-yet" (runtime
 * default at a preprocess / coerce leaf with no consumer input) and
 * "undefined as a consumer-supplied value" (defaultValues or a
 * schema-level `.default(undefined)`).
 *
 * The suppression filter applies to the FIRST case only: the runtime
 * doesn't run validation against state the consumer never authored.
 * The SECOND case is the consumer saying "yes, undefined is the
 * starting value, run it through preprocess like any other input" —
 * and the filter must leave that verdict alone so the configured
 * starting state gets validated.
 *
 * Without the discriminator, `useForm({ schema, defaultValues: { url:
 * undefined } })` would silently behave like `useForm({ schema })`,
 * hiding verdicts the consumer explicitly asked for.
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

const schemaWithExplicitDefault = z.object({
  url: z.preprocess(
    (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : INVALID_URL),
    z
      .string()
      .refine(async (val) => val !== INVALID_URL, { error: () => 'Please enter a URL.' })
      .default(undefined as never)
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

describe('preprocess suppression discriminator: runtime undefined vs consumer-supplied undefined', () => {
  const unmounts: Array<() => void> = []
  afterEach(() => {
    while (unmounts.length > 0) unmounts.pop()?.()
  })

  it('runtime undefined (no defaultValues, no schema default): suppressed at mount', async () => {
    const { api, unmount } = mountForm(() =>
      useForm({ schema, key: uniqueKey('edge-runtime-undef') })
    )
    unmounts.push(unmount)

    await nextTick()
    await new Promise((r) => setTimeout(r, 20))

    expect(api.values.url).toBeUndefined()
    expect(api.errors.url).toEqual([])
  })

  it('consumer-supplied undefined via defaultValues: validation fires at mount', async () => {
    const { api, unmount } = mountForm(() =>
      useForm({
        schema,
        key: uniqueKey('edge-defaultvalues-undef'),
        defaultValues: { url: undefined },
      })
    )
    unmounts.push(unmount)

    await nextTick()
    await new Promise((r) => setTimeout(r, 20))

    expect(api.values.url).toBeUndefined()
    expect(api.errors.url.length).toBeGreaterThan(0)
    expect(api.errors.url[0]?.message).toBe('Please enter a URL.')
  })

  it('schema-declared `.default(undefined)`: validation fires at mount', async () => {
    const { api, unmount } = mountForm(() =>
      useForm({
        schema: schemaWithExplicitDefault,
        key: uniqueKey('edge-schema-default-undef'),
      })
    )
    unmounts.push(unmount)

    await nextTick()
    await new Promise((r) => setTimeout(r, 20))

    expect(api.values.url).toBeUndefined()
    // The `.default(undefined as never)` cast widens the union so
    // form.errors.url surfaces as `ValidationError[] | undefined` —
    // narrow at the read site (the runtime behaviour, not the type,
    // is what this probe pins).
    const errs = api.errors.url ?? []
    expect(errs.length).toBeGreaterThan(0)
    expect(errs[0]?.message).toBe('Please enter a URL.')
  })
})

describe('defaultValues semantics: explicit undefined is a distinct signal from "key missing"', () => {
  const unmounts: Array<() => void> = []
  afterEach(() => {
    while (unmounts.length > 0) unmounts.pop()?.()
  })

  it('defaultValues: {} leaves schema `.default(5)` intact (count starts at 5)', async () => {
    const countSchema = z.object({ count: z.number().optional().default(5) })
    const { api, unmount } = mountForm(() =>
      useForm({ schema: countSchema, key: uniqueKey('count-empty-defaults') })
    )
    unmounts.push(unmount)

    await nextTick()

    expect(api.values.count).toBe(5)
  })

  it('defaultValues: { count: undefined } overrides the schema default to undefined', async () => {
    const countSchema = z.object({ count: z.number().optional().default(5) })
    const { api, unmount } = mountForm(() =>
      useForm({
        schema: countSchema,
        key: uniqueKey('count-explicit-undef'),
        defaultValues: { count: undefined },
      })
    )
    unmounts.push(unmount)

    await nextTick()

    // The consumer named the path with an explicit `undefined` — a
    // signal distinct from "key absent." Storage honors the override.
    expect(api.values.count).toBeUndefined()
  })
})
