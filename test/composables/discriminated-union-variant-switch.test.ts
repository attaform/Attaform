// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { z } from 'zod'
import { z as zV3 } from 'zod-v3'
import { isUnset, unset, useForm } from '../../src/zod'
import { historyPlugin } from '../../src/history'
import type { UseFormReturn } from '../../src/zod'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { AttaformErrorCode } from '../../src/runtime/core/error-codes'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { UseFormReturnType } from '../../src/runtime/types/types-api'

/**
 * When a discriminator value changes, storage at the union's parent
 * path reshapes to the active variant's slim default. Without that,
 * `setValue('notify.channel', 'sms')` against
 * `{ channel: 'email', address: 'a@b' }` would leave `address` sitting
 * beside `channel: 'sms'`, a shape no variant matches.
 *
 * The contract:
 *   1. Foreign keys, present only in the OLD variant, are removed.
 *   2. Missing keys of the NEW variant get the schema's slim default
 *      at that sub-path.
 *   3. The discriminator key carries the new value.
 *   4. Numeric and bigint leaves of the new variant auto-mark blank,
 *      under the same storage-versus-display rule that governs
 *      mount-time blank.
 */

const profileSchema = z.object({
  name: z.string(),
  notify: z.discriminatedUnion('channel', [
    z.object({ channel: z.literal('email'), address: z.string().min(3) }),
    z.object({ channel: z.literal('sms'), number: z.string().min(7) }),
  ]),
})
// A loose API type: these tests deliberately write cross-variant paths
// (`setValue('notify.address', ...)` while sms is active, and the
// reverse), which the strict inferred type correctly rejects. Casting
// `setValue` once to a permissive signature keeps a `never` cast off
// every call site.
type ProfileApi = Omit<UseFormReturnType<z.output<typeof profileSchema>>, 'setValue'> & {
  setValue: (path: string, value: unknown) => boolean
  values: {
    name: string
    notify: { channel: string } & Record<string, unknown>
  }
}

function mountProfile(): { app: App; api: ProfileApi } {
  const handle: { api?: ProfileApi } = {}
  const App = defineComponent({
    setup() {
      handle.api = useForm({
        schema: profileSchema,
        key: 'du-variant-switch',
        defaultValues: {
          name: '',
          notify: { channel: 'email', address: '' },
        },
      }) as unknown as ProfileApi
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.mount(document.createElement('div'))
  return { app, api: handle.api as ProfileApi }
}

describe('discriminated-union variant switch — storage reshape', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it("removes the old variant's foreign keys when the discriminator changes", async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('notify.address', 'old@example.com')
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'email', address: 'old@example.com' })

    api.setValue('notify.channel', 'sms')
    await nextTick()

    // `address` belongs to the email variant alone, so it does not
    // survive the switch.
    expect((api.values.notify as Record<string, unknown>)['address']).toBeUndefined()
  })

  it("fills the new variant's missing keys with the schema's slim defaults", async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('notify.channel', 'sms')
    await nextTick()

    // `number` is a `z.string().min(7)`, so its slim default is `''`.
    // This assertion is about the structural reshape; refinement-class
    // errors are covered elsewhere.
    expect(api.values.notify).toEqual({ channel: 'sms', number: '' })
  })

  it('preserves the new discriminator value', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('notify.channel', 'sms')
    await nextTick()
    expect(api.values.notify.channel).toBe('sms')

    api.setValue('notify.channel', 'email')
    await nextTick()
    expect(api.values.notify.channel).toBe('email')
  })

  it('round-trips between variants without leaking keys across both directions', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('notify.address', 'first@example.com')
    api.setValue('notify.channel', 'sms')
    await nextTick()
    // sms has no prior memory, so it falls back to the slim default,
    // and the email-only `address` does not leak across the switch.
    expect(api.values.notify).toEqual({ channel: 'sms', number: '' })

    api.setValue('notify.number', '5551234')
    api.setValue('notify.channel', 'email')
    await nextTick()
    // Memory restores the previously-typed `address` (variant memory
    // is on by default). The sms-only `number` does not leak.
    expect(api.values.notify).toEqual({ channel: 'email', address: 'first@example.com' })
  })

  it('writing the same discriminator value is a no-op (no spurious reshape)', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('notify.address', 'kept@example.com')
    await nextTick()
    const before = api.values.notify

    api.setValue('notify.channel', 'email')
    await nextTick()

    expect(api.values.notify).toEqual({ channel: 'email', address: 'kept@example.com' })
    // Identity short-circuit: no replacement when the discriminator
    // didn't actually change.
    expect(api.values.notify).toBe(before)
  })

  it('does not interfere with non-discriminator writes inside the union', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('notify.address', 'no-reshape@example.com')
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'email', address: 'no-reshape@example.com' })
  })

  it('peer fields outside the union are not touched by the reshape', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('name', 'Ada')
    api.setValue('notify.channel', 'sms')
    await nextTick()

    expect(api.values.name).toBe('Ada')
  })
})

describe('discriminated-union variant switch — error reactivity', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it("surfaces the new variant's required-field errors after submit replays validation", async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    // Fill the email variant cleanly so validation passes there.
    api.setValue('name', 'Ada')
    api.setValue('notify.address', 'ada@example.com')
    await nextTick()

    // After the switch to sms, `notify.number` is required and `''`,
    // failing `.min(7)`. The validation pipeline, here handleSubmit,
    // re-parses against the new effective shape.
    api.setValue('notify.channel', 'sms')
    await nextTick()

    const submit = api.handleSubmit(
      () => {},
      () => {}
    )
    await submit()
    await nextTick()

    // schemaErrors carries the refinement issue against the new
    // variant's required string. The length assertion is deliberate:
    // `.toBeDefined()` would pass on an empty array, which is the case
    // being guarded.
    expect(api.errors('notify.number')).toHaveLength(1)
  })

  it('parse({ commit: true }) reflects the new variant in the returned response', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('name', 'Ada')
    api.setValue('notify.address', 'ada@example.com')
    api.setValue('notify.channel', 'sms')
    await nextTick()

    const response = await api.parse({ commit: true })
    expect(response.success).toBe(false)
    expect(response.errors?.some((e) => e.path.join('.') === 'notify.number')).toBe(true)
  })
})

describe('discriminated-union variant switch — numeric variant blank auto-mark', () => {
  const numericVariantSchema = z.object({
    payout: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('flat'), amount: z.string() }),
      z.object({ kind: z.literal('tiered'), threshold: z.number() }),
    ]),
  })
  // A loose API type for the same reason as ProfileApi above:
  // cross-variant writes during the switch.
  type NumericApi = Omit<UseFormReturnType<z.output<typeof numericVariantSchema>>, 'setValue'> & {
    setValue: (path: string, value: unknown) => boolean
    values: { payout: { kind: string } & Record<string, unknown> }
  }

  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  function mountNumeric(): NumericApi {
    const handle: { api?: NumericApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: numericVariantSchema,
          key: 'du-numeric-variant',
          defaultValues: { payout: { kind: 'flat', amount: 'one-time' } },
        }) as unknown as NumericApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    return handle.api as NumericApi
  }

  it('switching into a variant whose required leaf is numeric auto-marks blank + emits a derived error', async () => {
    const api = mountNumeric()

    // Initially flat / amount, a string leaf, so no auto-mark.
    expect(api.errors('payout.threshold')).toEqual([])

    api.setValue('payout.kind', 'tiered')
    await nextTick()

    // After the switch `payout.threshold` exists with slim default `0`
    // and storage diverges from display, so auto-mark fires and the
    // derived error appears reactively.
    expect((api.values.payout as Record<string, unknown>)['threshold']).toBe(0)
    expect(api.errors('payout.threshold')?.[0]?.code).toBe(AttaformErrorCode.NoValueSupplied)
  })
})

describe('discriminated-union variant switch — whole-union write', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it("writing the union wholesale doesn't leak the OLD variant's keys", async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('notify.address', 'first@example.com')
    await nextTick()

    // Replace the union's parent with a complete sms-variant value. On
    // a whole-object write at the union path the runtime fills
    // structural gaps from the SMS variant's default, not the first
    // (email) one, or `address: ''` would leak back in.
    api.setValue('notify', { channel: 'sms', number: '5551234' })
    await nextTick()

    expect(api.values.notify).toEqual({ channel: 'sms', number: '5551234' })
  })

  it('whole-union write fills missing variant-specific keys from the matched variant default', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    // Consumer specifies discriminator only; the variant default
    // fills the rest.
    api.setValue('notify', { channel: 'sms' })
    await nextTick()

    expect(api.values.notify).toEqual({ channel: 'sms', number: '' })
  })
})

describe('discriminated-union variant switch — wrapped DU', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  // `notify` is `DU(...)` wrapped in `.default(...)`. Wrapping is
  // structurally transparent, so the reshape peels through wrappers
  // when locating the union one level above the discriminator key.
  it('reshapes when the DU is wrapped in `.default(...)`', async () => {
    const wrappedSchema = z.object({
      notify: z
        .discriminatedUnion('channel', [
          z.object({ channel: z.literal('email'), address: z.string() }),
          z.object({ channel: z.literal('sms'), number: z.string() }),
        ])
        .default({ channel: 'email', address: '' }),
    })
    type WrappedApi = Omit<UseFormReturnType<z.output<typeof wrappedSchema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { notify: { channel: string } & Record<string, unknown> }
    }

    const handle: { api?: WrappedApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: wrappedSchema,
          key: 'du-wrapped-default',
        }) as unknown as WrappedApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as WrappedApi

    api.setValue('notify.address', 'before@example.com')
    await nextTick()

    api.setValue('notify.channel', 'sms')
    await nextTick()

    expect(api.values.notify).toEqual({ channel: 'sms', number: '' })
  })
})

describe('discriminated-union variant switch — array <-> non-array path', () => {
  // One variant carries `payload` as an array of records; the other
  // does not carry `payload` at all. The container proxy at
  // `form.fields.payload` mounts an Array target on first read (driven
  // by `isArrayPath`) and is cached per segments key. A variant
  // switch that removes `payload`, or restores it from variant memory,
  // has to leave that cached proxy agreeing with the live shape: live
  // indices when the array is present, zero length when it is not, and
  // never claiming to be an array when the path holds something else.

  const arrayOrSingleSchema = z.object({
    body: z.discriminatedUnion('mode', [
      z.object({
        mode: z.literal('list'),
        payload: z.array(z.object({ value: z.string() })),
      }),
      z.object({ mode: z.literal('single'), text: z.string() }),
    ]),
  })

  type ArrayOrSingleApi = Omit<
    UseFormReturnType<z.output<typeof arrayOrSingleSchema>>,
    'setValue' | 'append' | 'remove'
  > & {
    setValue: (path: string, value: unknown) => boolean
    append: (path: string, item: unknown) => void
    remove: (path: string, idx: number) => void
    values: { body: { mode: string } & Record<string, unknown> }
  }

  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  function mount(): ArrayOrSingleApi {
    const handle: { api?: ArrayOrSingleApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: arrayOrSingleSchema,
          key: `du-array-vs-single-${Math.random().toString(36).slice(2)}`,
          defaultValues: { body: { mode: 'list', payload: [] } },
        }) as unknown as ArrayOrSingleApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    return handle.api as ArrayOrSingleApi
  }

  it('field-proxy at the array path enumerates the live entries while the variant is active', async () => {
    const api = mount()
    api.append('body.payload', { value: 'first' })
    api.append('body.payload', { value: 'second' })
    await nextTick()
    const fieldsAtPayload = (api.fields as unknown as { body: { payload: unknown } }).body.payload
    expect(Array.isArray(fieldsAtPayload)).toBe(true)
    expect(Object.keys(fieldsAtPayload as object)).toEqual(['0', '1'])
    expect((fieldsAtPayload as unknown as { length: number }).length).toBe(2)
  })

  it('after switching away from the array variant, the field proxy reports zero entries', async () => {
    const api = mount()
    api.append('body.payload', { value: 'first' })
    api.append('body.payload', { value: 'second' })
    await nextTick()
    const fieldsAtPayload = (api.fields as unknown as { body: { payload: unknown } }).body.payload
    // Warm the cache as the array variant.
    expect(Object.keys(fieldsAtPayload as object)).toEqual(['0', '1'])

    api.setValue('body.mode', 'single')
    await nextTick()
    expect(api.values.body.mode).toBe('single')
    expect(api.values.body['payload']).toBeUndefined()

    // The held reference still points at the pre-switch Array-target
    // proxy, since proxy targets are immutable, but `liveKeysAtPath`
    // reads `state.form.value` on every enumeration. So `Object.keys`
    // and `length` drop to zero and v-for renders no stale rows from
    // the previous variant.
    expect(Object.keys(fieldsAtPayload as object)).toEqual([])
    expect((fieldsAtPayload as unknown as { length: number }).length).toBe(0)
  })

  it('a fresh read after the switch returns a non-array-targeted proxy (Array.isArray flips)', async () => {
    const api = mount()
    api.append('body.payload', { value: 'first' })
    await nextTick()
    // Warm the cache as the array variant.
    const stale = (api.fields as unknown as { body: { payload: unknown } }).body.payload
    expect(Array.isArray(stale)).toBe(true)

    api.setValue('body.mode', 'single')
    await nextTick()

    // The container cache keys off (segments, shape), so with the live
    // value now `undefined` the next fresh read produces an
    // object-target proxy and `Array.isArray` reports the truth.
    const fresh = (api.fields as unknown as { body: { payload: unknown } }).body.payload
    expect(Array.isArray(fresh)).toBe(false)
    expect(fresh).not.toBe(stale)

    // Held-reference contract: the proxy target is immutable, so
    // the OLD reference still reports as an array. Documented as
    // a caveat for consumers who cache proxy references across
    // variant switches (template `v-for` always re-reads through
    // `form.fields.<path>` and gets the fresh proxy).
    expect(Array.isArray(stale)).toBe(true)
  })

  it('an inactive-variant container path is an absent node, then a live array once active', async () => {
    const api = mount()
    // Move to the `single` variant where `payload` (a list-only key)
    // doesn't exist. Model P: an inactive-variant node reads `undefined`
    // (no phantom object-target proxy to hold), so consumers re-read
    // through `form.fields.<path>` after a flip rather than caching a
    // reference minted while the path was absent.
    api.setValue('body.mode', 'single')
    await nextTick()
    expect((api.fields as unknown as { body: { payload: unknown } }).body.payload).toBeUndefined()

    // Flip into the list variant and add items: a fresh read returns a
    // live array-targeted proxy that enumerates the entries.
    api.setValue('body.mode', 'list')
    await nextTick()
    api.append('body.payload', { value: 'a' })
    api.append('body.payload', { value: 'b' })
    await nextTick()

    const fresh = (api.fields as unknown as { body: { payload: unknown } }).body.payload
    expect(Array.isArray(fresh)).toBe(true)
    expect((fresh as unknown as { length: number }).length).toBe(2)
    expect(Object.keys(fresh as object)).toEqual(['0', '1'])
  })

  it('switching back into the array variant restores enumeration of the restored items', async () => {
    const api = mount()
    api.append('body.payload', { value: 'first' })
    api.append('body.payload', { value: 'second' })
    await nextTick()
    const fieldsAtPayload = (api.fields as unknown as { body: { payload: unknown } }).body.payload
    expect(Object.keys(fieldsAtPayload as object)).toEqual(['0', '1'])

    api.setValue('body.mode', 'single')
    await nextTick()
    expect(Object.keys(fieldsAtPayload as object)).toEqual([])

    // Variant memory restores the prior `payload` entries; the
    // SAME cached proxy must reflect them again.
    api.setValue('body.mode', 'list')
    await nextTick()
    expect(Array.isArray((api.values.body as { payload?: unknown }).payload)).toBe(true)
    expect(Object.keys(fieldsAtPayload as object)).toEqual(['0', '1'])
  })
})

describe('z.union (non-discriminated) — array-vs-object shape collision at the same path', () => {
  // Zod's `z.union` allows the same key to be array-shaped in one
  // branch and record-shaped in another. The form value at that
  // path can flip between shapes via `setValue`. The cached
  // container proxy needs to follow: a fresh read after the flip
  // must return a proxy whose target matches the new shape, so
  // `Array.isArray` and `v-for` agree with reality.
  const unionSchema = z.object({
    payload: z.union([z.array(z.object({ value: z.string() })), z.record(z.string(), z.string())]),
  })

  type UnionApi = Omit<UseFormReturnType<z.output<typeof unionSchema>>, 'setValue' | 'append'> & {
    setValue: (path: string, value: unknown) => boolean
    append: (path: string, item: unknown) => void
    values: { payload: unknown }
  }

  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  function mount(initial: 'array' | 'object'): UnionApi {
    const handle: { api?: UnionApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: unionSchema,
          key: `union-shape-${Math.random().toString(36).slice(2)}`,
          defaultValues: { payload: initial === 'array' ? [] : ({} as Record<string, string>) },
        }) as unknown as UnionApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    return handle.api as UnionApi
  }

  it('Array.isArray tracks the live shape across the array-to-record flip on fresh reads', async () => {
    const api = mount('array')
    api.append('payload', { value: 'first' })
    await nextTick()

    const arrayProxy = (api.fields as unknown as { payload: unknown }).payload
    expect(Array.isArray(arrayProxy)).toBe(true)
    expect(Object.keys(arrayProxy as object)).toEqual(['0'])

    // Force-flip the live shape to an object.
    api.setValue('payload', { red: 'r', green: 'g' })
    await nextTick()
    expect(api.values.payload).toEqual({ red: 'r', green: 'g' })

    const objectProxy = (api.fields as unknown as { payload: unknown }).payload
    expect(Array.isArray(objectProxy)).toBe(false)
    expect(objectProxy).not.toBe(arrayProxy)
    expect(Object.keys(objectProxy as object).sort()).toEqual(['green', 'red'])
  })

  it('a held Array-target reference tracks live record keys after a flip to object shape', async () => {
    const api = mount('array')
    api.append('payload', { value: 'first' })
    api.append('payload', { value: 'second' })
    await nextTick()

    const heldArr = (api.fields as unknown as { payload: unknown }).payload
    expect(Array.isArray(heldArr)).toBe(true)
    expect((heldArr as { length: number }).length).toBe(2)
    expect(Object.keys(heldArr as object)).toEqual(['0', '1'])

    // Force-flip the live shape to a record.
    api.setValue('payload', { red: 'r', green: 'g', blue: 'b' })
    await nextTick()

    // The held Array-target proxy retraps `length` and `ownKeys` on
    // every read, so live record keys surface through it. Both array
    // and record shapes flow through `liveKeysAtPath`, so the length
    // reports the live key count either way.
    expect((heldArr as { length: number }).length).toBe(3)
    expect(Object.keys(heldArr as object).sort()).toEqual(['blue', 'green', 'red'])

    // Inherent caveat: the cached Array target is locked, so the
    // host-level `Array.isArray` check stays true even though the
    // live shape is now a record. Fresh reads through
    // `form.fields.<path>` produce a function-target proxy that
    // reports the truth.
    expect(Array.isArray(heldArr)).toBe(true)
    const fresh = (api.fields as unknown as { payload: unknown }).payload
    expect(Array.isArray(fresh)).toBe(false)
    expect(fresh).not.toBe(heldArr)
  })

  it('Array.isArray tracks the live shape across the record-to-array flip on fresh reads', async () => {
    const api = mount('object')
    api.setValue('payload', { red: 'r' })
    await nextTick()
    const objectProxy = (api.fields as unknown as { payload: unknown }).payload
    expect(Array.isArray(objectProxy)).toBe(false)

    api.setValue('payload', [{ value: 'a' }, { value: 'b' }])
    await nextTick()
    const arrayProxy = (api.fields as unknown as { payload: unknown }).payload
    expect(Array.isArray(arrayProxy)).toBe(true)
    expect(Object.keys(arrayProxy as object)).toEqual(['0', '1'])
    expect(arrayProxy).not.toBe(objectProxy)
  })
})

describe('surface proxy — per-consumer cache isolation', () => {
  // Two `useForm` calls with the same key share the underlying form
  // store (the registry de-dupes by key), but each call gets its own
  // `buildFormApi` and therefore its own container cache. This pins
  // that contract: independent proxies, shared live state.
  const apps: App[] = []
  const sharedSchema = z.object({ posts: z.array(z.object({ title: z.string() })) })
  type SharedApi = Omit<UseFormReturnType<z.output<typeof sharedSchema>>, 'append'> & {
    append: (path: string, item: unknown) => void
  }
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  function mount(): { a: SharedApi; b: SharedApi } {
    const handle: { a?: SharedApi; b?: SharedApi } = {}
    const App = defineComponent({
      setup() {
        handle.a = useForm({
          schema: sharedSchema,
          key: 'shared-isolation',
          defaultValues: { posts: [] },
        }) as unknown as SharedApi
        handle.b = useForm({
          schema: sharedSchema,
          key: 'shared-isolation',
          defaultValues: { posts: [] },
        }) as unknown as SharedApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    return { a: handle.a as SharedApi, b: handle.b as SharedApi }
  }

  it('two consumers of the same form key see the same live state through independent proxies', async () => {
    const { a, b } = mount()
    a.append('posts', { title: 'first' })
    a.append('posts', { title: 'second' })
    await nextTick()

    const fieldsAFromA = (a.fields as unknown as { posts: unknown }).posts
    const fieldsAFromB = (b.fields as unknown as { posts: unknown }).posts

    // Independent proxy identities (per-consumer caches).
    expect(fieldsAFromA).not.toBe(fieldsAFromB)

    // Shared live state through both proxies.
    expect(Object.keys(fieldsAFromA as object)).toEqual(['0', '1'])
    expect(Object.keys(fieldsAFromB as object)).toEqual(['0', '1'])

    // Writes through consumer B propagate to consumer A's proxy
    // because the underlying form store is shared by key.
    b.append('posts', { title: 'third' })
    await nextTick()
    expect(Object.keys(fieldsAFromA as object)).toEqual(['0', '1', '2'])
    expect(Object.keys(fieldsAFromB as object)).toEqual(['0', '1', '2'])
  })
})

describe('discriminated-union variant switch — DU inside an array', () => {
  const arraySchema = z.object({
    events: z.array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('click'), x: z.number() }),
        z.object({ type: z.literal('text'), value: z.string() }),
      ])
    ),
  })
  type ArrayApi = Omit<UseFormReturnType<z.output<typeof arraySchema>>, 'setValue'> & {
    setValue: (path: string, value: unknown) => boolean
    values: { events: Array<{ type: string } & Record<string, unknown>> }
  }

  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it("switching a DU element's discriminator inside an array reshapes that element only", async () => {
    const handle: { api?: ArrayApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: arraySchema,
          key: 'du-array',
          defaultValues: {
            events: [
              { type: 'click', x: 5 },
              { type: 'text', value: 'a' },
            ],
          },
        }) as unknown as ArrayApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as ArrayApi

    api.setValue('events.0.type', 'text')
    await nextTick()

    expect(api.values.events[0]).toEqual({ type: 'text', value: '' })
    // Sibling elements unchanged.
    expect(api.values.events[1]).toEqual({ type: 'text', value: 'a' })
  })
})

describe('discriminated-union variant switch — zod v3 adapter', () => {
  const v3Schema = zV3.object({
    notify: zV3.discriminatedUnion('channel', [
      zV3.object({ channel: zV3.literal('email'), address: zV3.string() }),
      zV3.object({ channel: zV3.literal('sms'), number: zV3.string() }),
    ]),
  })
  type V3Api = Omit<UseFormReturnType<zV3.infer<typeof v3Schema>>, 'setValue'> & {
    setValue: (path: string, value: unknown) => boolean
    values: { notify: { channel: string } & Record<string, unknown> }
  }

  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  function mountV3(): V3Api {
    const handle: { api?: V3Api } = {}
    const App = defineComponent({
      setup() {
        handle.api = useFormV3({
          schema: v3Schema,
          key: 'du-variant-switch-v3',
          defaultValues: { notify: { channel: 'email', address: '' } },
        }) as unknown as V3Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    return handle.api as V3Api
  }

  it('reshapes storage on discriminator change in v3', async () => {
    const api = mountV3()

    api.setValue('notify.address', 'old@example.com')
    await nextTick()

    api.setValue('notify.channel', 'sms')
    await nextTick()

    expect(api.values.notify).toEqual({ channel: 'sms', number: '' })
  })

  it('round-trip restores typed data with the v3 adapter (parity with v4)', async () => {
    const api = mountV3()

    api.setValue('notify.address', 'remembered@example.com')
    api.setValue('notify.channel', 'sms')
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'sms', number: '' })

    api.setValue('notify.channel', 'email')
    await nextTick()
    expect(api.values.notify).toEqual({
      channel: 'email',
      address: 'remembered@example.com',
    })
  })
})

/**
 * Variant memory is a per-form-instance side channel: it snapshots the
 * outgoing variant's subtree on a discriminated-union switch and
 * restores it on switch-back. On by default (`rememberVariants: true`),
 * opted out with `useForm({ rememberVariants: false })`.
 *
 * Memory is keyed by absolute union path (`PathKey`), so every DU at
 * every nesting depth gets its own independent memory map. Memory
 * never reaches `form.value`, never serializes, and clears on
 * `reset()` / whole-form replace / `resetField` of an ancestor.
 */

function mountProfileWith(options: { rememberVariants?: boolean } = {}): {
  app: App
  api: ProfileApi
} {
  const handle: { api?: ProfileApi } = {}
  const App = defineComponent({
    setup() {
      handle.api = useForm({
        schema: profileSchema,
        key: `du-variant-memory-${Math.random().toString(36).slice(2)}`,
        defaultValues: {
          name: '',
          notify: { channel: 'email', address: '' },
        },
        ...(options.rememberVariants !== undefined
          ? { rememberVariants: options.rememberVariants }
          : {}),
      }) as unknown as ProfileApi
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.mount(document.createElement('div'))
  return { app, api: handle.api as ProfileApi }
}

describe('variant memory — round-trip preserves typed data', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('email → sms → email restores the typed address', async () => {
    const { app, api } = mountProfileWith()
    apps.push(app)

    api.setValue('notify.address', 'foo@bar.com')
    api.setValue('notify.channel', 'sms')
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'sms', number: '' })

    api.setValue('notify.channel', 'email')
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'email', address: 'foo@bar.com' })
  })

  it('sms → email → sms restores the typed number', async () => {
    const { app, api } = mountProfileWith()
    apps.push(app)

    api.setValue('notify.channel', 'sms')
    api.setValue('notify.number', '5551234')
    api.setValue('notify.channel', 'email')
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'email', address: '' })

    api.setValue('notify.channel', 'sms')
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'sms', number: '5551234' })
  })

  it('three-way variants round-trip correctly', async () => {
    const triSchema = z.object({
      pick: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), av: z.string() }),
        z.object({ kind: z.literal('b'), bv: z.string() }),
        z.object({ kind: z.literal('c'), cv: z.string() }),
      ]),
    })
    type TriApi = Omit<UseFormReturnType<z.output<typeof triSchema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { pick: { kind: string } & Record<string, unknown> }
    }
    const handle: { api?: TriApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: triSchema,
          key: 'du-variant-memory-tri',
          defaultValues: { pick: { kind: 'a', av: '' } },
        }) as unknown as TriApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as TriApi

    api.setValue('pick.av', 'aaa')
    api.setValue('pick.kind', 'b')
    api.setValue('pick.bv', 'bbb')
    api.setValue('pick.kind', 'c')
    api.setValue('pick.cv', 'ccc')
    await nextTick()

    api.setValue('pick.kind', 'a')
    await nextTick()
    expect(api.values.pick).toEqual({ kind: 'a', av: 'aaa' })

    api.setValue('pick.kind', 'b')
    await nextTick()
    expect(api.values.pick).toEqual({ kind: 'b', bv: 'bbb' })

    api.setValue('pick.kind', 'c')
    await nextTick()
    expect(api.values.pick).toEqual({ kind: 'c', cv: 'ccc' })
  })

  it('successive round-trips capture the latest typed value, not a stale earlier one', async () => {
    // Implicit reactivity-detachment check: if the snapshot were a
    // live Vue proxy into the orphaned subtree, successive switches
    // could surface earlier or mutated values. Each round-trip must
    // see the value typed in the immediately-prior occupancy of the
    // variant.
    const { app, api } = mountProfileWith()
    apps.push(app)

    for (const candidate of ['first@x.io', 'second@y.io', 'third@z.io']) {
      api.setValue('notify.address', candidate)
      api.setValue('notify.channel', 'sms')
      await nextTick()
      api.setValue('notify.channel', 'email')
      await nextTick()
      expect(api.values.notify).toEqual({ channel: 'email', address: candidate })
    }
  })
})

describe('variant memory — Case B whole-union write', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('partial whole-union write restores from memory + applies overrides', async () => {
    const { app, api } = mountProfileWith()
    apps.push(app)

    api.setValue('notify.address', 'kept@example.com')
    api.setValue('notify.channel', 'sms')
    await nextTick()

    // Whole-union back to email with only the discriminator. Memory
    // baseline (`address: 'kept@example.com'`) survives; consumer
    // doesn't override it.
    api.setValue('notify', { channel: 'email' })
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'email', address: 'kept@example.com' })
  })

  it('whole-union write with all keys overrides memory', async () => {
    const { app, api } = mountProfileWith()
    apps.push(app)

    api.setValue('notify.address', 'old@example.com')
    api.setValue('notify.channel', 'sms')
    await nextTick()

    // The consumer supplies the full email shape, and an explicit
    // override wins over the memory baseline.
    api.setValue('notify', { channel: 'email', address: 'override@example.com' })
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'email', address: 'override@example.com' })
  })
})

describe('variant memory — same-discriminator Case B', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('whole-union write with same discriminator does NOT touch memory', async () => {
    // Setup memory: typed address, switch to sms (memory captures
    // email = { channel: email, address: 'baseline@x.io' }).
    const { app, api } = mountProfileWith()
    apps.push(app)
    api.setValue('notify.address', 'baseline@x.io')
    api.setValue('notify.channel', 'sms')
    api.setValue('notify.number', '7777777')
    await nextTick()

    // Same-discriminator Case B: setValue('notify', { channel: 'sms', ... })
    // while already on sms. Memory must NOT be consulted (no restore
    // to a prior sms value); just the merge.
    api.setValue('notify', { channel: 'sms', number: '8888888' })
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'sms', number: '8888888' })

    // Verify the email memory is intact: switching back must restore
    // the originally-typed address, not anything affected by the
    // same-disc Case B above.
    api.setValue('notify.channel', 'email')
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'email', address: 'baseline@x.io' })
  })

  it('subsequent switch-out captures the post-merge state, not pre-merge', async () => {
    const { app, api } = mountProfileWith()
    apps.push(app)
    api.setValue('notify.channel', 'sms')
    api.setValue('notify.number', '1111111')
    await nextTick()

    // Same-disc Case B updates number to '2222222'.
    api.setValue('notify', { channel: 'sms', number: '2222222' })
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'sms', number: '2222222' })

    // Switch out (sms → email) snapshots the LIVE state ('2222222'),
    // and a switch back must restore that value.
    api.setValue('notify.channel', 'email')
    api.setValue('notify.channel', 'sms')
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'sms', number: '2222222' })
  })
})

describe('variant memory — opt-out (rememberVariants: false)', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('does NOT preserve typed data across switches', async () => {
    const { app, api } = mountProfileWith({ rememberVariants: false })
    apps.push(app)

    api.setValue('notify.address', 'foo@bar.com')
    api.setValue('notify.channel', 'sms')
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'sms', number: '' })

    api.setValue('notify.channel', 'email')
    await nextTick()
    // With memory disabled the typed address is gone and the slim
    // default `address: ''` returns.
    expect(api.values.notify).toEqual({ channel: 'email', address: '' })
  })

  it('falls back to slim default on every switch-back across many round-trips', async () => {
    const { app, api } = mountProfileWith({ rememberVariants: false })
    apps.push(app)

    for (const candidate of ['a@x.io', 'b@y.io', 'c@z.io']) {
      api.setValue('notify.address', candidate)
      api.setValue('notify.channel', 'sms')
      await nextTick()
      api.setValue('notify.channel', 'email')
      await nextTick()
      // Each round trip resets to the slim default, never accumulating.
      expect(api.values.notify).toEqual({ channel: 'email', address: '' })
    }
  })
})

describe('variant memory — reset clears memory', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('reset() drops all variant memory entries', async () => {
    const { app, api } = mountProfileWith()
    apps.push(app)

    api.setValue('notify.address', 'will-be-forgotten@example.com')
    api.setValue('notify.channel', 'sms')
    await nextTick()

    api.reset()
    await nextTick()

    // After reset, switch sms → email must NOT surface the
    // pre-reset memory entry.
    api.setValue('notify.channel', 'sms')
    api.setValue('notify.channel', 'email')
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'email', address: '' })
  })

  it("resetField at the union path drops that union's memory", async () => {
    const { app, api } = mountProfileWith()
    apps.push(app)

    api.setValue('notify.address', 'pre-reset@example.com')
    api.setValue('notify.channel', 'sms')
    await nextTick()

    api.resetField('notify')
    await nextTick()

    // Memory was cleared at the union path, so switching sms to email
    // restores the slim default.
    api.setValue('notify.channel', 'sms')
    api.setValue('notify.channel', 'email')
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'email', address: '' })
  })

  it("resetField on a leaf INSIDE a variant does NOT clear that union's memory", async () => {
    const { app, api } = mountProfileWith()
    apps.push(app)

    // Type, then switch out: memory captures email with the typed value.
    api.setValue('notify.address', 'remembered@example.com')
    api.setValue('notify.channel', 'sms')
    await nextTick()

    // Switch back, type something fresh, then reset just the leaf.
    // Memory at ['notify'] survives by design, since it self-corrects
    // on the next switch-out.
    api.setValue('notify.channel', 'email')
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'email', address: 'remembered@example.com' })

    api.setValue('notify.address', 'fresh@example.com')
    api.resetField('notify.address')
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'email', address: '' })

    // Self-correction: switch out + back should now reflect the
    // post-reset baseline (''), not the older 'remembered@…' that
    // was in memory before.
    api.setValue('notify.channel', 'sms')
    api.setValue('notify.channel', 'email')
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'email', address: '' })
  })
})

const flowSchema = z.object({
  flow: z.discriminatedUnion('step', [
    z.object({
      step: z.literal('choose-type'),
      type: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('A'), a: z.string() }),
        z.object({ kind: z.literal('B'), b: z.string() }),
      ]),
    }),
    z.object({ step: z.literal('review'), notes: z.string() }),
  ]),
})
type FlowApi = Omit<UseFormReturnType<z.output<typeof flowSchema>>, 'setValue'> & {
  setValue: (path: string, value: unknown) => boolean
  values: { flow: { step: string } & Record<string, unknown> }
}

function mountFlow(): { app: App; api: FlowApi } {
  const handle: { api?: FlowApi } = {}
  const App = defineComponent({
    setup() {
      handle.api = useForm({
        schema: flowSchema,
        key: `du-variant-memory-flow-${Math.random().toString(36).slice(2)}`,
        defaultValues: {
          flow: { step: 'choose-type', type: { kind: 'A', a: '' } },
        },
      }) as unknown as FlowApi
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.mount(document.createElement('div'))
  return { app, api: handle.api as FlowApi }
}

describe('variant memory — nested DUs (depth 2)', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('inner switch round-trip preserves typed data at the inner level', async () => {
    const { app, api } = mountFlow()
    apps.push(app)

    api.setValue('flow.type.a', 'aaa')
    api.setValue('flow.type.kind', 'B')
    api.setValue('flow.type.b', 'bbb')
    api.setValue('flow.type.kind', 'A')
    await nextTick()
    expect(api.values.flow).toEqual({
      step: 'choose-type',
      type: { kind: 'A', a: 'aaa' },
    })

    api.setValue('flow.type.kind', 'B')
    await nextTick()
    expect(api.values.flow).toEqual({
      step: 'choose-type',
      type: { kind: 'B', b: 'bbb' },
    })
  })

  it('outer round-trip restores the full inner subtree byte-for-byte', async () => {
    const { app, api } = mountFlow()
    apps.push(app)

    api.setValue('flow.type.a', 'inner-a-value')
    api.setValue('flow.step', 'review')
    api.setValue('flow.notes' as never, 'review-text')
    await nextTick()
    expect(api.values.flow).toEqual({ step: 'review', notes: 'review-text' })

    api.setValue('flow.step', 'choose-type')
    await nextTick()
    expect(api.values.flow).toEqual({
      step: 'choose-type',
      type: { kind: 'A', a: 'inner-a-value' },
    })
  })

  it('inner memory persists across an outer round-trip and is consulted on inner re-flip', async () => {
    const { app, api } = mountFlow()
    apps.push(app)

    // Set up inner memory: A typed, switch to B typed, leaving inner
    // memory entries for both A and B.
    api.setValue('flow.type.a', 'inner-A')
    api.setValue('flow.type.kind', 'B')
    api.setValue('flow.type.b', 'inner-B')
    await nextTick()

    // Outer round trip: choose-type to review and back. Inner memory
    // entries are never explicitly cleared; they live at the absolute
    // path `["flow","type"]` regardless of outer state.
    api.setValue('flow.step', 'review')
    await nextTick()
    api.setValue('flow.step', 'choose-type')
    await nextTick()

    // After outer-restore, the inner DU's `kind` is whatever the
    // outer snapshot captured (B). Flipping to A consults inner
    // memory and restores the typed value.
    expect((api.values.flow as Record<string, unknown>)['type']).toEqual({
      kind: 'B',
      b: 'inner-B',
    })
    api.setValue('flow.type.kind', 'A')
    await nextTick()
    expect((api.values.flow as Record<string, unknown>)['type']).toEqual({
      kind: 'A',
      a: 'inner-A',
    })
  })

  it('inner switches inside the restored outer subtree work normally', async () => {
    const { app, api } = mountFlow()
    apps.push(app)

    api.setValue('flow.type.a', 'a-text')
    api.setValue('flow.step', 'review')
    api.setValue('flow.step', 'choose-type')
    await nextTick()
    // Restored to inner `{ kind: 'A', a: 'a-text' }`. An inner switch
    // to B falls back to the slim default, since the inner switch
    // never happened before the outer toggle and B has no memory.
    api.setValue('flow.type.kind', 'B')
    await nextTick()
    expect((api.values.flow as Record<string, unknown>)['type']).toEqual({
      kind: 'B',
      b: '',
    })
  })
})

describe('variant memory — nested DU + reset interactions', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('reset() clears outer and inner memory entries', async () => {
    const { app, api } = mountFlow()
    apps.push(app)

    api.setValue('flow.type.a', 'inner-A')
    api.setValue('flow.type.kind', 'B')
    api.setValue('flow.type.b', 'inner-B')
    await nextTick()

    api.reset()
    await nextTick()

    // Inner switches after reset must NOT surface pre-reset values.
    api.setValue('flow.type.kind', 'A')
    await nextTick()
    expect((api.values.flow as Record<string, unknown>)['type']).toEqual({
      kind: 'A',
      a: '',
    })
    api.setValue('flow.type.kind', 'B')
    await nextTick()
    expect((api.values.flow as Record<string, unknown>)['type']).toEqual({
      kind: 'B',
      b: '',
    })
  })

  it('resetField at outer parent path clears outer + nested memory', async () => {
    const { app, api } = mountFlow()
    apps.push(app)

    api.setValue('flow.type.a', 'inner-A-pre-reset')
    api.setValue('flow.type.kind', 'B')
    api.setValue('flow.type.b', 'inner-B-pre-reset')
    await nextTick()

    api.resetField('flow')
    await nextTick()

    // After resetField('flow'), inner memory at ['flow','type'] must
    // also be gone (it sits under the reset path). A subsequent
    // inner switch must yield slim defaults, not the pre-reset
    // typed values.
    api.setValue('flow.type.kind', 'A')
    await nextTick()
    expect((api.values.flow as Record<string, unknown>)['type']).toEqual({
      kind: 'A',
      a: '',
    })
  })

  it('resetField at inner parent path clears inner memory only', async () => {
    const { app, api } = mountFlow()
    apps.push(app)

    api.setValue('flow.type.a', 'inner-A-pre-reset')
    api.setValue('flow.type.kind', 'B')
    api.setValue('flow.type.b', 'inner-B-pre-reset')
    await nextTick()

    api.resetField('flow.type')
    await nextTick()

    // Inner memory is cleared, so a switch to A gives the slim default.
    api.setValue('flow.type.kind', 'A')
    await nextTick()
    expect((api.values.flow as Record<string, unknown>)['type']).toEqual({
      kind: 'A',
      a: '',
    })

    // Outer memory at ['flow'] survives, though this test never
    // switched the outer, so there is no entry to consult. Switching it
    // here exercises the outer memory machinery.
    api.setValue('flow.type.a', 'fresh-A')
    api.setValue('flow.step', 'review')
    api.setValue('flow.step', 'choose-type')
    await nextTick()
    expect((api.values.flow as Record<string, unknown>)['type']).toEqual({
      kind: 'A',
      a: 'fresh-A',
    })
  })
})

describe('variant memory — DU nested inside an array element', () => {
  const arraySchema = z.object({
    events: z.array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('click'), x: z.string() }),
        z.object({ type: z.literal('text'), value: z.string() }),
      ])
    ),
  })
  type ArrayApi = Omit<UseFormReturnType<z.output<typeof arraySchema>>, 'setValue'> & {
    setValue: (path: string, value: unknown) => boolean
    values: { events: Array<{ type: string } & Record<string, unknown>> }
  }

  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  function mountArray(): ArrayApi {
    const handle: { api?: ArrayApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: arraySchema,
          key: `du-variant-memory-array-${Math.random().toString(36).slice(2)}`,
          defaultValues: {
            events: [
              { type: 'click', x: '' },
              { type: 'text', value: '' },
            ],
          },
        }) as unknown as ArrayApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    return handle.api as ArrayApi
  }

  it('memory entries key off events[0] separately from events[1]', async () => {
    const api = mountArray()

    // events[0]: click → text → click. Memory at ['events',0] holds
    // the click-with-x value.
    api.setValue('events.0.x', 'index-0-click')
    api.setValue('events.0.type', 'text')
    api.setValue('events.0.type', 'click')
    await nextTick()
    expect(api.values.events[0]).toEqual({ type: 'click', x: 'index-0-click' })

    // events[1] is independent: switching events[1].type never
    // restores from events[0]'s memory.
    api.setValue('events.1.value', 'index-1-text')
    api.setValue('events.1.type', 'click')
    await nextTick()
    expect(api.values.events[1]).toEqual({ type: 'click', x: '' })
  })

  it("resetField on an indexed element clears only that index's memory", async () => {
    const api = mountArray()

    api.setValue('events.0.x', 'idx-0')
    api.setValue('events.0.type', 'text')
    api.setValue('events.1.value', 'idx-1')
    api.setValue('events.1.type', 'click')
    await nextTick()

    api.resetField('events.0')
    await nextTick()

    // events[0] memory is cleared, so switching back to click yields
    // the slim default rather than the typed 'idx-0'.
    api.setValue('events.0.type', 'click')
    await nextTick()
    expect(api.values.events[0]).toEqual({ type: 'click', x: '' })

    // events[1] memory survives, so switching back to text restores.
    api.setValue('events.1.type', 'text')
    await nextTick()
    expect(api.values.events[1]).toEqual({ type: 'text', value: 'idx-1' })
  })

  it('resetField on the array path clears memory for every index', async () => {
    const api = mountArray()

    api.setValue('events.0.x', 'idx-0')
    api.setValue('events.0.type', 'text')
    api.setValue('events.1.value', 'idx-1')
    api.setValue('events.1.type', 'click')
    await nextTick()

    api.resetField('events')
    await nextTick()

    api.setValue('events.0.type', 'click')
    api.setValue('events.1.type', 'text')
    await nextTick()
    expect(api.values.events[0]).toEqual({ type: 'click', x: '' })
    expect(api.values.events[1]).toEqual({ type: 'text', value: '' })
  })
})

describe('variant memory — nested DUs (depth 3)', () => {
  // wizard = DU('phase', [
  //   { phase: 'config', config: DU('mode', [
  //       { mode: 'manual', detail: DU('shape', [{ shape: 'rect', w, h }, { shape: 'circle', r }]) },
  //       { mode: 'auto', preset },
  //     ]) },
  //   { phase: 'submit', confirmed },
  // ])
  const wizardSchema = z.object({
    wizard: z.discriminatedUnion('phase', [
      z.object({
        phase: z.literal('config'),
        config: z.discriminatedUnion('mode', [
          z.object({
            mode: z.literal('manual'),
            detail: z.discriminatedUnion('shape', [
              z.object({ shape: z.literal('rect'), w: z.string(), h: z.string() }),
              z.object({ shape: z.literal('circle'), r: z.string() }),
            ]),
          }),
          z.object({ mode: z.literal('auto'), preset: z.string() }),
        ]),
      }),
      z.object({ phase: z.literal('submit'), confirmed: z.string() }),
    ]),
  })
  type WizardApi = Omit<UseFormReturnType<z.output<typeof wizardSchema>>, 'setValue'> & {
    setValue: (path: string, value: unknown) => boolean
    values: { wizard: { phase: string } & Record<string, unknown> }
  }

  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  function mountWizard(): WizardApi {
    const handle: { api?: WizardApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: wizardSchema,
          key: `du-variant-memory-wizard-${Math.random().toString(36).slice(2)}`,
          defaultValues: {
            wizard: {
              phase: 'config',
              config: {
                mode: 'manual',
                detail: { shape: 'rect', w: '', h: '' },
              },
            },
          },
        }) as unknown as WizardApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    return handle.api as WizardApi
  }

  it('depth-3 inner switch preserves typed data at the deepest level', async () => {
    const api = mountWizard()

    api.setValue('wizard.config.detail.w', '100')
    api.setValue('wizard.config.detail.h', '50')
    api.setValue('wizard.config.detail.shape', 'circle')
    api.setValue('wizard.config.detail.r', '42')
    await nextTick()

    api.setValue('wizard.config.detail.shape', 'rect')
    await nextTick()
    expect((api.values.wizard as Record<string, unknown>)['config']).toEqual({
      mode: 'manual',
      detail: { shape: 'rect', w: '100', h: '50' },
    })

    api.setValue('wizard.config.detail.shape', 'circle')
    await nextTick()
    expect((api.values.wizard as Record<string, unknown>)['config']).toEqual({
      mode: 'manual',
      detail: { shape: 'circle', r: '42' },
    })
  })

  it('outer-then-middle-then-inner round-trip preserves all three levels', async () => {
    const api = mountWizard()

    // Type at the deepest level.
    api.setValue('wizard.config.detail.w', '99')
    api.setValue('wizard.config.detail.h', '11')
    await nextTick()

    // An outer switch out and back captures the entire wizard subtree,
    // middle and deepest layers included.
    api.setValue('wizard.phase', 'submit')
    api.setValue('wizard.phase', 'config')
    await nextTick()
    expect(api.values.wizard).toEqual({
      phase: 'config',
      config: { mode: 'manual', detail: { shape: 'rect', w: '99', h: '11' } },
    })

    // A middle switch out and back captures the deepest layer.
    api.setValue('wizard.config.mode', 'auto')
    api.setValue('wizard.config.preset' as never, 'auto-preset')
    await nextTick()
    api.setValue('wizard.config.mode', 'manual')
    await nextTick()
    expect((api.values.wizard as Record<string, unknown>)['config']).toEqual({
      mode: 'manual',
      detail: { shape: 'rect', w: '99', h: '11' },
    })
  })
})

describe('variant memory — field state across round-trip', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('typed-then-restored leaf reads back the same value (memory keeps the field consistent)', async () => {
    const { app, api } = mountProfileWith()
    apps.push(app)

    api.setValue('notify.address', 'state-check@example.com')
    api.setValue('notify.channel', 'sms')
    await nextTick()

    api.setValue('notify.channel', 'email')
    await nextTick()

    // The reactive read mirrors what was typed. Pins the contract
    // that field-level state (consumers reading via `values`) sees
    // the restored value as the current source of truth.
    expect(api.values.notify).toEqual({ channel: 'email', address: 'state-check@example.com' })
    expect((api.values.notify as Record<string, unknown>)['address']).toBe(
      'state-check@example.com'
    )
  })
})

describe('variant memory — history (undo/redo) interaction', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('history snapshots the form value but not memory; memory remains independent of undo', async () => {
    const handle: { api?: ProfileApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: profileSchema,
          key: `du-variant-memory-history-${Math.random().toString(36).slice(2)}`,
          defaultValues: { name: '', notify: { channel: 'email', address: '' } },
          history: historyPlugin(),
        }) as unknown as ProfileApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as ProfileApi

    api.setValue('notify.address', 'h1@example.com')
    api.setValue('notify.channel', 'sms')
    await nextTick()

    // Memory now holds email = { address: 'h1@example.com' }. Undo
    // restores the form value to its pre-switch state; memory is not on
    // the history stack, so it stays as it is.
    api.history.undo()
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'email', address: 'h1@example.com' })

    // Switching to sms re-snapshots the undone-to state into
    // memory[email], which already held the same value. History
    // operates on form value alone.
    api.setValue('notify.channel', 'sms')
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'sms', number: '' })
  })
})

/**
 * The aggregate `form.errors` surface filters out inactive-variant
 * errors through the live-data active-path filter, and every reshape
 * re-validates the `schemaErrors` store against the new variant, so
 * stale leaf entries from the previous variant never accumulate.
 *
 *   - `form.errors` answers "what is currently wrong with this form?"
 *     against the active schema, active-path-filtered.
 *   - `fields.<path>.errors` answers "what does the schema runtime
 *     currently say about this path?", so it is empty for an
 *     inactive-variant leaf once reshape clears its entries.
 *   - User-injected errors (`setErrors`) DO survive a variant switch:
 *     they live in a separate store the validation pipeline never
 *     touches.
 *
 * The filter is `hasAtPath(form.value, err.path)`. Reshape removes
 * inactive-variant keys from `form.value` outright, re-validation under
 * the new shape clears stale schemaErrors entries, and user errors stay
 * put.
 */
describe('inactive-variant errors — filtered from form.errors, schemaErrors re-validated', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it("hides the OLD variant's construction-seeded error on a discriminator switch", async () => {
    const { app, api } = mountProfile()
    apps.push(app)
    await nextTick()

    // Construction-time validation seeds schemaErrors with the
    // email variant's failure (address='' fails `.min(3)`). One error.
    expect(api.errors('notify.address')).toHaveLength(1)

    // Switching to sms takes the address path out of form.value.
    api.setValue('notify.channel', 'sms')
    await nextTick()

    // notify.address is no longer reachable through form.value, so the
    // aggregate filter hides the error that is still stored against it.
    // Without the filter a dotted-path schemaErrors entry would leak
    // the email variant's address error after a switch to sms.
    expect(api.errors('notify.address')).toEqual([])
  })

  it('round-trip with variant memory restores form.errors visibility', async () => {
    const { app, api } = mountProfile()
    apps.push(app)
    await nextTick()
    expect(api.errors('notify.address')).toHaveLength(1)

    api.setValue('notify.channel', 'sms')
    await nextTick()
    expect(api.errors('notify.address')).toEqual([])

    // Switch back. Variant memory restores the value at notify.address,
    // so hasAtPath returns true again and the filter unmasks the error.
    api.setValue('notify.channel', 'email')
    await nextTick()
    expect(api.errors('notify.address')).toHaveLength(1)
  })

  it('per-field fields clears schema errors at inactive-variant paths after reshape', async () => {
    // Reshape's sync re-validation clears every schemaErrors entry
    // under the union's parent path, through the leaf-keyed
    // clear-then-write in `applySchemaErrorsForSubtree`. An
    // inactive-variant leaf is absent from the new shape and so gets no
    // new entry, leaving schemaErrors at current schema truth.
    const { app, api } = mountProfile()
    apps.push(app)
    await nextTick()

    api.setValue('notify.channel', 'sms')
    await nextTick()

    expect(api.errors('notify.address')).toEqual([])
    // The inactive-variant node is undefined on the dot surface, so
    // per-field state reads through the call form, a schema-aware stub
    // whose errors reflect the cleared schema state.
    expect(api.fields('notify.address').errors).toEqual([])
  })

  it('per-field fields preserves USER-injected errors across variant switches', async () => {
    // userErrors live in a separate store the validation pipeline
    // never touches, so a consumer-injected error at an
    // inactive-variant path stays visible through the per-field
    // surface even while the active-path mask hides it from
    // `form.errors`. That is what "preserved across variant switches"
    // means: consumer intent, not past validation results.
    const { app, api } = mountProfile()
    apps.push(app)
    await nextTick()

    api.setErrors([
      {
        path: ['notify', 'address'],
        message: 'server says address is taken',
        code: 'api:validation',
      },
    ])

    api.setValue('notify.channel', 'sms')
    await nextTick()

    // The active-path filter hides it from form.errors, since
    // notify.address is not in the live shape.
    expect(api.errors('notify.address')).toEqual([])

    // Per-field surface retains it (userErrors store, untouched by
    // schema re-validation). Model P: the inactive-variant node is
    // undefined on the dot surface, so read it through the call-form.
    const addressState = api.fields('notify.address')
    expect(addressState.errors.length).toBeGreaterThan(0)
    expect(addressState.errors[0]?.message).toBe('server says address is taken')
  })

  it('handleSubmit-populated errors at the active variant flow through the filter cleanly', async () => {
    // The filter never hides an error at an active path. Errors come
    // through handleSubmit, which settles with its own promise, so the
    // timing is deterministic and nothing depends on the debounce.
    const { app, api } = mountProfile()
    apps.push(app)
    await nextTick()

    api.setValue('notify.channel', 'sms')
    await nextTick()

    const submit = api.handleSubmit(
      () => {},
      () => {}
    )
    await submit()
    await nextTick()

    // sms variant's own validation surfaces; filter does not hide
    // active-path entries.
    expect(api.errors('notify.number')).toHaveLength(1)
    // The email variant's construction-seeded error is still in the
    // store but stays filtered out.
    expect(api.errors('notify.address')).toEqual([])
  })
})

/**
 * A cargo 4-variant fixture for the discriminated-union lift: runtime
 * smoke that the lifted types match truthful-absence semantics on
 * inactive-variant chained access, where a key whose variant is not
 * active is an absent node (`undefined`) rather than a phantom stub.
 * It mirrors the demo schema's shape (a `type` discriminator over
 * `dry | refrigerated | hazmat | oversized`), so a regression here
 * would break the canonical demo flow.
 */
const cargoLiftSchema = z.object({
  reference: z.string(),
  cargo: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('dry'),
      items: z.array(z.object({ sku: z.string() })),
      fragile: z.boolean(),
    }),
    z.object({
      type: z.literal('refrigerated'),
      items: z.array(z.object({ sku: z.string() })),
      tempMinC: z.number().min(-30).max(20),
      tempMaxC: z.number().min(-30).max(20),
    }),
  ]),
})

type CargoLiftApi = UseFormReturn<typeof cargoLiftSchema>

function mountCargoLift(): { app: App; api: CargoLiftApi } {
  const handle: { api?: CargoLiftApi } = {}
  const App = defineComponent({
    setup() {
      handle.api = useForm({
        schema: cargoLiftSchema,
        key: 'cargo-lift',
        defaultValues: {
          reference: 'SHP-1',
          cargo: { type: 'dry', items: [], fragile: false },
        },
      })
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.mount(document.createElement('div'))
  return { app, api: handle.api as CargoLiftApi }
}

describe('discriminated-union lift — chained metadata-proxy access', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('api.fields.cargo.tempMinC is an absent node on the inactive (dry) variant', () => {
    const { app, api } = mountCargoLift()
    apps.push(app)

    // The active variant is `dry` and `tempMinC` lives only on
    // `refrigerated`. The inactive variant's key is an absent node,
    // `undefined` rather than a phantom stub, so a falsy check agrees
    // with the runtime and the type `FieldState<number> | undefined`
    // forces a `?.` guard.
    expect(api.fields.cargo.tempMinC).toBeUndefined()
  })

  it('api.fields.cargo.tempMinC?.value re-evaluates after a variant switch', async () => {
    const { app, api } = mountCargoLift()
    apps.push(app)

    api.setValue('cargo', { type: 'refrigerated', items: [], tempMinC: 4, tempMaxC: 8 })
    await nextTick()
    expect(api.fields.cargo.tempMinC?.value).toBe(4)
    expect(api.fields.cargo.tempMaxC?.value).toBe(8)

    // Switching back to dry turns the refrigerated leaves into absent
    // nodes.
    api.setValue('cargo', { type: 'dry', items: [], fragile: false })
    await nextTick()
    expect(api.fields.cargo.tempMinC).toBeUndefined()
    expect(api.fields.cargo.fragile?.value).toBe(false)
  })

  it('api.errors.cargo — inactive-variant key is undefined; active key with no errors is []', () => {
    const { app, api } = mountCargoLift()
    apps.push(app)
    // tempMinC lives only on `refrigerated`; the active variant is `dry`,
    // so its node is absent (model P → undefined). fragile is on the
    // active `dry` variant with no errors, so it reads an empty array.
    expect(api.errors.cargo.tempMinC).toBeUndefined()
    expect(api.errors.cargo.fragile).toEqual([])
  })

  it('api.errors.cargo.tempMinC populates after a schema-violating write on the refrigerated variant', async () => {
    const { app, api } = mountCargoLift()
    apps.push(app)

    api.setValue('cargo', { type: 'refrigerated', items: [], tempMinC: 4, tempMaxC: 8 })
    await nextTick()

    // -100 violates min(-30); drive validation explicitly so the leaf
    // lights up regardless of debounce timing.
    api.setValue('cargo.tempMinC', -100)
    const result = await api.parse({ commit: true })
    expect(result.success).toBe(false)
    await nextTick()

    const errs = api.errors.cargo.tempMinC
    expect(errs).toBeDefined()
    expect(errs).toHaveLength(1)
  })
})

/**
 * Whole-union Case B writes carrying `unset` sentinels in the
 * consumer-supplied object, as the homepage REPL does. The demo's
 * `setCargoType('oversized')` calls
 *
 *   form.setValue('cargo', {
 *     type: 'oversized',
 *     items: [],
 *     lengthCm: unset, widthCm: unset, heightCm: unset,
 *     permitNumber: unset,
 *   })
 *
 * after a prior switch into a different variant. `walkUnsetSentinels`
 * scrubs `defaultValues` at construction only, so the variant reshape
 * is what has to scrub a later setValue: a symbol reaching storage
 * beside the discriminator leaves the next read operating on a
 * Symbol-valued leaf, which stops the template's active-variant branch
 * resolving and freezes the UI on the previous variant's body.
 */
describe('discriminated-union variant switch — whole-union write with unset sentinels', () => {
  const cargoSchema = z.object({
    cargo: z.discriminatedUnion('type', [
      z.object({
        type: z.literal('dry'),
        fragile: z.boolean(),
      }),
      z.object({
        type: z.literal('hazmat'),
        unNumber: z.string(),
        acknowledged: z.boolean(),
      }),
      z.object({
        type: z.literal('oversized'),
        lengthCm: z.number().positive(),
        widthCm: z.number().positive(),
        heightCm: z.number().positive(),
        permitNumber: z.string().optional(),
      }),
    ]),
  })
  type CargoApi = Omit<UseFormReturnType<z.output<typeof cargoSchema>>, 'setValue'> & {
    setValue: (path: string, value: unknown) => boolean
    values: { cargo: { type: string } & Record<string, unknown> }
  }

  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  function mountCargo(): CargoApi {
    const handle: { api?: CargoApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: cargoSchema,
          key: `du-unset-case-b-${Math.random().toString(36).slice(2)}`,
          defaultValues: { cargo: { type: 'dry', fragile: false } },
        }) as unknown as CargoApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    return handle.api as CargoApi
  }

  it('switches dry → hazmat → oversized when the oversized write carries unset sentinels', async () => {
    const api = mountCargo()

    api.setValue('cargo', { type: 'hazmat', unNumber: 'UN0000', acknowledged: false })
    await nextTick()
    expect(api.values.cargo.type).toBe('hazmat')

    api.setValue('cargo', {
      type: 'oversized',
      lengthCm: unset,
      widthCm: unset,
      heightCm: unset,
      permitNumber: unset,
    })
    await nextTick()

    expect(api.values.cargo.type).toBe('oversized')
  })

  it('scrubs unset sentinels out of storage on a Case B write', async () => {
    const api = mountCargo()

    api.setValue('cargo', {
      type: 'oversized',
      lengthCm: unset,
      widthCm: unset,
      heightCm: unset,
      permitNumber: unset,
    })
    await nextTick()

    // Storage holds the schema's slim defaults, never raw symbols.
    // Otherwise `JSON.stringify(form.values())`, which is what the
    // demo's review pane reads, would silently drop these leaves.
    expect(isUnset(api.values.cargo.lengthCm)).toBe(false)
    expect(isUnset(api.values.cargo.widthCm)).toBe(false)
    expect(isUnset(api.values.cargo.heightCm)).toBe(false)
    expect(isUnset(api.values.cargo.permitNumber)).toBe(false)
    expect(typeof api.values.cargo.lengthCm).toBe('number')
    expect(typeof api.values.cargo.widthCm).toBe('number')
    expect(typeof api.values.cargo.heightCm).toBe('number')
  })

  it('marks the unset-flagged leaves blank so display stays empty', async () => {
    const api = mountCargo()

    api.setValue('cargo', {
      type: 'oversized',
      lengthCm: unset,
      widthCm: unset,
      heightCm: unset,
      permitNumber: unset,
    })
    await nextTick()

    expect(api.fields.cargo.lengthCm?.blank).toBe(true)
    expect(api.fields.cargo.widthCm?.blank).toBe(true)
    expect(api.fields.cargo.heightCm?.blank).toBe(true)
    expect(api.fields.cargo.permitNumber?.blank).toBe(true)
  })
})
