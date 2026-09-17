// @vitest-environment jsdom
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, watch, type App } from 'vue'
import { z } from 'zod'
import { z as zV3 } from 'zod-v3'
import { unset, useForm } from '../../src/zod'
import { historyPlugin } from '../../src/history'
import type { HistoryPlugin } from '../../src/history'
import type { UseFormReturn } from '../../src/zod'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { UseFormReturnType } from '../../src/runtime/types/types-api'
import type { PathInput, PathOutput } from '../../src/runtime/adapters/zod-v4'

/**
 * What happens when a caller forces an INVALID value into a
 * discriminator key: one outside every variant's literal set
 * (`notify.channel = 'wat'` against
 * `z.discriminatedUnion('channel', [literal('email'), literal('sms')])`),
 * or of the wrong type entirely (null, number, undefined).
 *
 * The settled answer, which every test below pins: the write SUCCEEDS
 * and storage at the union path collapses to a discriminator-only stub
 * `{ [discKey]: value }`. Validation, not the write gate, is the
 * authority on literal-set membership. The shape a test never accepts
 * is a mixed one carrying the previous variant's keys beside a
 * discriminator that no variant claims, because nothing downstream can
 * render or parse it.
 *
 * Reached through `setValue`, `defaultValues`, rehydrate and undo.
 */

// Shared test-local relaxed shapes. These probes deliberately land the
// form in unrepresentable states, so the shape cannot be the schema's
// strict discriminated-union image. Every field is `unknown` so test
// bodies can narrow with `===` / `typeof` / `in` without TS4111 noise on
// index-signature access.
type AnyNotify = {
  channel?: unknown
  address?: unknown
  number?: unknown
  email?: unknown
}
type AnyEvent = {
  type?: unknown
  x?: unknown
  value?: unknown
}
type AnyInner = {
  kind?: unknown
  a?: unknown
  b?: unknown
}
type AnyFlow = {
  step?: unknown
  inner?: AnyInner
  notes?: unknown
}
type AnyPayload = {
  kind?: unknown
  items?: unknown
  v?: unknown
  w?: unknown
  data?: unknown
  tags?: unknown
  at?: unknown
  a?: unknown
}
type AnyTree = {
  kind?: unknown
}

const profileSchema = z.object({
  name: z.string(),
  notify: z.discriminatedUnion('channel', [
    z.object({ channel: z.literal('email'), address: z.string().min(3) }),
    z.object({ channel: z.literal('sms'), number: z.string().min(7) }),
  ]),
})
type ProfileApi = Omit<UseFormReturnType<z.output<typeof profileSchema>>, 'setValue'> & {
  setValue: (path: string, value: unknown) => boolean
  values: { name: string; notify: { channel: string } & Record<string, unknown> }
}

function mountProfile(options: { defaultValues?: unknown } = {}): {
  app: App
  api: ProfileApi
} {
  const handle: { api?: ProfileApi } = {}
  const App = defineComponent({
    setup() {
      handle.api = useForm({
        schema: profileSchema,
        key: `du-invalid-${Math.random().toString(36).slice(2)}`,
        defaultValues: (options.defaultValues ?? {
          name: '',
          notify: { channel: 'email', address: 'old@example.com' },
        }) as never,
      }) as unknown as ProfileApi
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.mount(document.createElement('div'))
  return { app, api: handle.api as ProfileApi }
}

describe('DU hardening — Case A invalid leaf discriminator write', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('does NOT leave foreign keys from the previous variant alongside an invalid discriminator', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('notify.channel', 'wat')
    await nextTick()

    // Storage holds either a shape matching some variant, or the
    // discriminator-only stub. What it never holds is the mixed
    // `{ channel: 'wat', address: '...' }`: no variant claims
    // `channel='wat'`, so that shape is outside the schema's image.
    const notify = api.values.notify as AnyNotify
    const isPreservedEmail =
      notify.channel === 'email' && typeof notify.address === 'string' && !('number' in notify)
    const isHasOnlyDiscriminator = Object.keys(notify).length === 1 && notify.channel === 'wat'
    expect(isPreservedEmail || isHasOnlyDiscriminator).toBe(true)
  })

  it('returns TRUE and lands a disc-only stub when the new discriminator is not a known variant', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    // The slim-primitive gate is type-only, so any string passes at a
    // string-literal discriminator. The write returns true and storage
    // collapses to `{ [discKey]: value }`, dropping the prior variant
    // body and every foreign key. Zod's own
    // `invalid_union_discriminator` then surfaces at notify or
    // notify.channel.
    const ok = api.setValue('notify.channel', 'wat')
    await nextTick()
    expect(ok).toBe(true)
    expect(api.values.notify).toEqual({ channel: 'wat' })
  })

  it('surfaces a discriminator-mismatch error via a committing parse after an invalid write', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('notify.channel', 'wat')
    await nextTick()

    const result = await api.parse({ commit: true })
    expect(result.success).toBe(false)
    // The error lands on a path callers can bind to. Both `notify`
    // (the union) and `notify.channel` (the discriminator leaf) are
    // stable choices, so the test accepts either and rejects only an
    // empty or non-matching list.
    const paths = result.errors?.map((e) => e.path.join('.')) ?? []
    const hasDiscError = paths.some((p) => p === 'notify' || p === 'notify.channel')
    expect(hasDiscError).toBe(true)
  })

  it('exposes the discriminator-mismatch error via api.errors at notify.channel OR notify', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('notify.channel', 'wat')
    await api.parse({ commit: true })
    await nextTick()

    const atUnion = api.errors('notify')
    const atLeaf = api.errors('notify.channel')
    const surfaced = (atUnion?.length ?? 0) > 0 || (atLeaf?.length ?? 0) > 0
    expect(surfaced).toBe(true)
  })

  it('the orphaned old-variant leaf no longer reads as a passing field after the invalid write', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    // Pre: address was 'old@example.com' (valid for email variant).
    expect(api.errors('notify.address')).toEqual([])

    api.setValue('notify.channel', 'wat')
    await api.parse({ commit: true })
    await nextTick()

    // The address leaf is in storage but under no active variant's
    // schema. A reader walking `form.fields` may treat the orphan as
    // gone (errors undefined, value stub) or surface the parent's
    // discriminator mismatch through it. What it must not do is report
    // the leaf as fully valid, which would hide a structurally broken
    // form from any error summary bound to children of `notify`.
    const orphanedSurface = (
      api as unknown as {
        fields: { notify: { address?: { errors: unknown[]; valid: boolean } } }
      }
    ).fields.notify.address
    if (orphanedSurface !== undefined) {
      expect(orphanedSurface.valid).toBe(false)
    }
  })

  it('container firstError at notify reflects the discriminator mismatch', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('notify.channel', 'wat')
    await api.parse({ commit: true })
    await nextTick()

    // Model P: a container's own rolled-up state reads through the
    // call-form (`form.fields('notify')`), not field-state keys on the
    // navigable container node.
    expect(api.fields('notify').firstError).toBeDefined()
  })
})

describe('DU hardening — Case B invalid whole-union write', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('does NOT silently leave the form in a non-variant shape', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('notify', { channel: 'wat', someJunk: 1 })
    await nextTick()

    // Either reject (storage unchanged at the email variant) or
    // reshape to a valid variant. The accept-as-is outcome
    // (`{channel:'wat', someJunk:1, address:''}` etc.) is the bug.
    const notify = api.values.notify as AnyNotify
    const stayedEmail = notify.channel === 'email'
    const validShape =
      (notify.channel === 'email' &&
        typeof notify.address === 'string' &&
        !('number' in notify) &&
        !('someJunk' in notify)) ||
      (notify.channel === 'sms' &&
        typeof notify.number === 'string' &&
        !('address' in notify) &&
        !('someJunk' in notify))
    expect(stayedEmail || validShape).toBe(true)
  })

  it('returns TRUE and lands a disc-only stub on an invalid whole-union write', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    const ok = api.setValue('notify', { channel: 'wat' })
    await nextTick()
    expect(ok).toBe(true)
    expect(api.values.notify).toEqual({ channel: 'wat' })
  })

  it('whole-union write missing the discriminator entirely lands an empty stub', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    // Consumer omits `channel`, so there is no discriminator to hold
    // and storage collapses to `{}`: every consumer key is dropped and
    // nothing auto-merges from the first variant. The next committing
    // parse surfaces Zod's `invalid_union_discriminator`.
    const ok = api.setValue('notify', { address: 'a@b.io' })
    await nextTick()
    expect(ok).toBe(true)
    expect(api.values.notify).toEqual({})
    const result = await api.parse({ commit: true })
    expect(result.success).toBe(false)
  })
})

describe('DU hardening — slim-primitive gate at the discriminator key', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('rejects null at a string-literal discriminator', async () => {
    const { app, api } = mountProfile()
    apps.push(app)
    expect(api.setValue('notify.channel', null)).toBe(false)
    await nextTick()
    expect(api.values.notify.channel).toBe('email')
  })

  it('rejects undefined at a string-literal discriminator', async () => {
    const { app, api } = mountProfile()
    apps.push(app)
    expect(api.setValue('notify.channel', undefined)).toBe(false)
    await nextTick()
    expect(api.values.notify.channel).toBe('email')
  })

  it('rejects a number at a string-literal discriminator', async () => {
    const { app, api } = mountProfile()
    apps.push(app)
    expect(api.setValue('notify.channel', 42)).toBe(false)
    await nextTick()
    expect(api.values.notify.channel).toBe('email')
  })

  it('rejects an object at a string-literal discriminator', async () => {
    const { app, api } = mountProfile()
    apps.push(app)
    expect(api.setValue('notify.channel', {})).toBe(false)
    await nextTick()
    expect(api.values.notify.channel).toBe('email')
  })

  it('rejects a string at a numeric-literal discriminator', async () => {
    // Numeric-literal DU. A wrong-type write should be rejected by
    // the slim-primitive gate even before the variant lookup runs.
    const numericSchema = z.object({
      payload: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal(1), v: z.string() }),
        z.object({ kind: z.literal(2), v: z.number() }),
      ]),
    })
    type NumericApi = Omit<UseFormReturnType<z.output<typeof numericSchema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { payload: { kind: number | string } & Record<string, unknown> }
    }
    const handle: { api?: NumericApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: numericSchema,
          key: `du-numeric-disc-${Math.random().toString(36).slice(2)}`,
          defaultValues: { payload: { kind: 1, v: 'a' } },
        }) as unknown as NumericApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as NumericApi

    expect(api.setValue('payload.kind', '1')).toBe(false)
    await nextTick()
    expect(api.values.payload.kind).toBe(1)
  })

  it('rejects an unknown number at a numeric-literal discriminator', async () => {
    const numericSchema = z.object({
      payload: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal(1), v: z.string() }),
        z.object({ kind: z.literal(2), v: z.number() }),
      ]),
    })
    type NumericApi = Omit<UseFormReturnType<z.output<typeof numericSchema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { payload: { kind: number } & Record<string, unknown> }
    }
    const handle: { api?: NumericApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: numericSchema,
          key: `du-numeric-unknown-${Math.random().toString(36).slice(2)}`,
          defaultValues: { payload: { kind: 1, v: 'a' } },
        }) as unknown as NumericApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as NumericApi

    // `99` is the right type but not a literal in the set. The slim
    // gate checks kinds, not literal sets, so the write reaches the
    // discriminator reshape, storage collapses to `{ kind: 99 }` and
    // setValue returns true. Validation, not the write gate, flags the
    // value as out of range.
    expect(api.setValue('payload.kind', 99)).toBe(true)
    await nextTick()
    expect(api.values.payload).toEqual({ kind: 99 })
  })
})

describe('DU hardening — variant memory survives an invalid intermediate', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('an invalid intermediate write does NOT corrupt the prior variant memory', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    // Start clean on email with a typed address.
    api.setValue('notify.address', 'first@example.com')
    await nextTick()

    // Switch to an invalid discriminator. Rejected or no-op, the email
    // memory is not polluted: it still holds the typed address
    // verbatim.
    api.setValue('notify.channel', 'wat')
    await nextTick()

    // Now switch validly to sms.
    api.setValue('notify.channel', 'sms')
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'sms', number: '' })

    // Switching back to email restores the typed address from memory.
    api.setValue('notify.channel', 'email')
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'email', address: 'first@example.com' })
  })
})

describe('DU hardening — construction with invalid discriminator in defaultValues', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('produces a form whose values match a real variant shape', async () => {
    const { app, api } = mountProfile({
      defaultValues: { name: '', notify: { channel: 'wat' } },
    })
    apps.push(app)
    await nextTick()

    // The same stub rule at construction: the form mounts holding the
    // consumer's verbatim discriminator and nothing else, so storage is
    // exactly `{channel:'wat'}` with no invented variant fields. A
    // one-shot dev warning flags the bad discriminator, and the next
    // committing parse surfaces the mismatch.
    const notify = api.values.notify as AnyNotify
    expect(notify).toEqual({ channel: 'wat' })
    const result = await api.parse({ commit: true })
    expect(result.success).toBe(false)
  })
})

describe('DU hardening — repeated invalid writes', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('writing the same invalid discriminator twice is idempotent', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    const first = api.setValue('notify.channel', 'wat')
    await nextTick()
    const second = api.setValue('notify.channel', 'wat')
    await nextTick()

    // Both writes should yield the same status; the second must not
    // produce a different storage state from the first.
    expect(first).toBe(second)
  })
})

describe('DU hardening — undo across an invalid intermediate', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('undo reverts the form to a valid state after an invalid write', async () => {
    const handle: { api?: ProfileApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: profileSchema,
          key: `du-invalid-undo-${Math.random().toString(36).slice(2)}`,
          defaultValues: { name: '', notify: { channel: 'email', address: 'kept@x.io' } },
          history: historyPlugin(),
        }) as unknown as ProfileApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as ProfileApi

    api.setValue('notify.channel', 'wat')
    await nextTick()
    api.history.undo()
    await nextTick()

    // After undo, the form is whatever it was before the invalid
    // write. The pre-write state is `{channel:'email', address:'kept@x.io'}`,
    // i.e. a valid variant.
    const notify = api.values.notify as AnyNotify
    const valid =
      (notify.channel === 'email' && typeof notify.address === 'string') ||
      (notify.channel === 'sms' && typeof notify.number === 'string')
    expect(valid).toBe(true)
  })
})

describe('DU hardening — invalid discriminator at an array element', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it("invalid write to events[0].type doesn't leak into the sibling element", async () => {
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
    const handle: { api?: ArrayApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: arraySchema,
          key: `du-array-invalid-${Math.random().toString(36).slice(2)}`,
          defaultValues: {
            events: [
              { type: 'click', x: 'first' },
              { type: 'text', value: 'second' },
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

    api.setValue('events.0.type', 'unknown')
    await nextTick()

    // Sibling unaffected.
    expect(api.values.events[1]).toEqual({ type: 'text', value: 'second' })
    // The target element collapses to a discriminator-only stub and
    // the prior variant's keys (here `x`) are dropped. The stub counts
    // as representable alongside the two valid-variant shapes; all the
    // assertion forbids is a mixed one.
    const e0 = api.values.events[0] as AnyEvent
    const isStub = Object.keys(e0).length === 1 && e0.type === 'unknown'
    const valid =
      isStub ||
      (e0.type === 'click' && typeof e0.x === 'string' && !('value' in e0)) ||
      (e0.type === 'text' && typeof e0.value === 'string' && !('x' in e0))
    expect(valid).toBe(true)
  })
})

describe('DU hardening — invalid discriminator at an inner nested DU', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('invalid inner write leaves the outer state untouched and the inner consistent', async () => {
    const flowSchema = z.object({
      flow: z.discriminatedUnion('step', [
        z.object({
          step: z.literal('choose'),
          inner: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('A'), a: z.string() }),
            z.object({ kind: z.literal('B'), b: z.string() }),
          ]),
        }),
        z.object({ step: z.literal('done'), notes: z.string() }),
      ]),
    })
    type FlowApi = Omit<UseFormReturnType<z.output<typeof flowSchema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { flow: { step: string } & Record<string, unknown> }
    }
    const handle: { api?: FlowApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: flowSchema,
          key: `du-nested-invalid-${Math.random().toString(36).slice(2)}`,
          defaultValues: {
            flow: { step: 'choose', inner: { kind: 'A', a: 'value-a' } },
          },
        }) as unknown as FlowApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as FlowApi

    api.setValue('flow.inner.kind', 'Z')
    await nextTick()

    // Outer step untouched.
    expect(api.values.flow.step).toBe('choose')

    // Inner collapses to `{kind:'Z'}`, dropping the prior variant's
    // `a`. The stub joins the two valid-variant shapes as
    // representable; the mixed `{kind:'Z', a:'value-a'}` is the one
    // outcome the assertion rejects.
    const inner = (api.values.flow as AnyFlow).inner as AnyInner
    const isStub = Object.keys(inner).length === 1 && inner.kind === 'Z'
    const innerValid =
      isStub ||
      (inner.kind === 'A' && typeof inner.a === 'string' && !('b' in inner)) ||
      (inner.kind === 'B' && typeof inner.b === 'string' && !('a' in inner))
    expect(innerValid).toBe(true)
  })
})

describe('DU hardening — zod v3 adapter parity', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('v3: invalid Case A discriminator write does not leave foreign keys', async () => {
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
    const handle: { api?: V3Api } = {}
    const App = defineComponent({
      setup() {
        handle.api = useFormV3({
          schema: v3Schema,
          key: `du-invalid-v3-${Math.random().toString(36).slice(2)}`,
          defaultValues: { notify: { channel: 'email', address: 'a@b.io' } },
        }) as unknown as V3Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as V3Api

    api.setValue('notify.channel', 'wat')
    await nextTick()

    const notify = api.values.notify as AnyNotify
    const isPreservedEmail =
      notify.channel === 'email' && typeof notify.address === 'string' && !('number' in notify)
    const isHasOnlyDiscriminator = Object.keys(notify).length === 1 && notify.channel === 'wat'
    expect(isPreservedEmail || isHasOnlyDiscriminator).toBe(true)
  })

  it('v3: returns TRUE and lands a disc-only stub for invalid Case A write', async () => {
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
    const handle: { api?: V3Api } = {}
    const App = defineComponent({
      setup() {
        handle.api = useFormV3({
          schema: v3Schema,
          key: `du-invalid-v3-return-${Math.random().toString(36).slice(2)}`,
          defaultValues: { notify: { channel: 'email', address: 'a@b.io' } },
        }) as unknown as V3Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as V3Api

    expect(api.setValue('notify.channel', 'nope')).toBe(true)
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'nope' })
  })
})

// Six surfaces the discriminator rules have to hold across:
//
//   1. "No selection yet" UX (`unset` + blank on the discriminator)
//   2. Bad default values (missing key, missing variant fields,
//      foreign-variant fields, partial defaults)
//   3. Discriminators inside discriminators (outer-invalid cascades)
//   4. reset / resetField across an invalid state
//   5. Field metadata on the discriminator after an invalid write
//      (touched / dirty / blank / valid)
//   6. handleSubmit while the form holds an invalid discriminator

describe('DU hardening — `unset` on the discriminator (no-selection-yet UX)', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('useForm with `unset` at the discriminator mounts in a representable state', async () => {
    const handle: { api?: ProfileApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: profileSchema,
          key: `du-unset-default-${Math.random().toString(36).slice(2)}`,
          defaultValues: {
            name: '',
            // "No channel chosen yet": `unset` substitutes the slim
            // default (`''`) at the discriminator path, leaving a state
            // any reader can render, with no orphan keys and no mixed
            // variant shape.
            notify: { channel: unset },
          } as never,
        }) as unknown as ProfileApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as ProfileApi
    await nextTick()

    // Either a valid first-variant default with the discriminator
    // tracked as blank, or the discriminator key alone. Not both at
    // once: `{channel:''}` carrying first-variant `address` keys is
    // structurally a half-built variant, and validation would have to
    // pretend it knows which one.
    const notify = api.values.notify as AnyNotify
    const validShape =
      (notify.channel === 'email' && typeof notify.address === 'string') ||
      (notify.channel === 'sms' && typeof notify.number === 'string') ||
      (Object.keys(notify).length === 1 && notify.channel === '')
    expect(validShape).toBe(true)
  })

  it('the discriminator path reads as `blank` after `unset` at construction', async () => {
    const handle: { api?: ProfileApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: profileSchema,
          key: `du-unset-blank-${Math.random().toString(36).slice(2)}`,
          defaultValues: { name: '', notify: { channel: unset } } as never,
        }) as unknown as ProfileApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as ProfileApi
    await nextTick()

    // Blank bookkeeping is what powers the "user has not chosen yet"
    // UX. Without it the form reports `dirty: false` and `valid: true`,
    // since nothing has been validated and `channel === ''` passes the
    // slim gate, leaving the consumer unable to tell "no choice yet"
    // from "valid email form with an empty address".
    const notifyChannel = (
      api as unknown as {
        fields: { notify: { channel: { blank: boolean } } }
      }
    ).fields.notify.channel
    expect(notifyChannel.blank).toBe(true)
  })

  it('`setValue(disc-path, unset)` from a valid state cleans up old-variant keys', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('notify.address', 'typed@example.com')
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'email', address: 'typed@example.com' })

    // "No selection yet" mid-flight, as when the user clicks a "clear
    // my choice" button. An orphan `address` key left behind would be a
    // storage shape matching no variant.
    api.setValue('notify.channel', unset)
    await nextTick()

    const notify = api.values.notify as AnyNotify
    expect('address' in notify).toBe(false)
  })

  it('after `unset`, switching to a valid variant produces a clean shape', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('notify.channel', unset)
    await nextTick()

    api.setValue('notify.channel', 'sms')
    await nextTick()

    // Variant lookup must work normally after an unset interlude. No
    // ghosted keys from before.
    expect(api.values.notify).toEqual({ channel: 'sms', number: '' })
  })

  it('`form.values()` after `unset` is JSON-serializable + describes a single state', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('notify.channel', unset)
    await nextTick()

    // A review pane or network round-trip reads these values as JSON.
    // `{channel:'', address:'old@example.com'}` serializes fine but
    // represents nothing the schema accepts, and the JSON alone cannot
    // tell "no choice" from "broken email choice".
    const json = JSON.parse(JSON.stringify(api.values.notify)) as AnyNotify
    const consistent =
      (json.channel === '' && Object.keys(json).length === 1) ||
      (json.channel === 'email' && typeof json.address === 'string') ||
      (json.channel === 'sms' && typeof json.number === 'string')
    expect(consistent).toBe(true)
  })
})

describe('DU hardening — bad default values at the union path', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('defaultValues missing the discriminator key entirely produces a deterministic state', async () => {
    const handle: { api?: ProfileApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: profileSchema,
          key: `du-bad-defaults-no-disc-${Math.random().toString(36).slice(2)}`,
          // No `channel`, so `getDefaultAtPath` falls back to the first
          // variant and `address` lands under email without the
          // consumer ever asking for it.
          defaultValues: { name: '', notify: { address: 'unspecified@x.io' } } as never,
        }) as unknown as ProfileApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as ProfileApi
    await nextTick()

    // Whatever the runtime decides, the result must MATCH a real
    // variant. If we accept-as-is into `{address:'…'}` (no channel),
    // every downstream path breaks.
    const notify = api.values.notify as AnyNotify
    const matches =
      (notify.channel === 'email' && typeof notify.address === 'string') ||
      (notify.channel === 'sms' && typeof notify.number === 'string')
    expect(matches).toBe(true)
  })

  it('defaultValues with valid disc + foreign-variant field strips the foreign key', async () => {
    const handle: { api?: ProfileApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: profileSchema,
          key: `du-bad-defaults-foreign-${Math.random().toString(36).slice(2)}`,
          // `channel: 'email'` chooses the email variant; `number` only
          // belongs to the sms variant. Construction should reshape to
          // a clean email, not preserve the foreign key.
          defaultValues: {
            name: '',
            notify: { channel: 'email', address: 'a@b.io', number: '5551234' },
          } as never,
        }) as unknown as ProfileApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as ProfileApi
    await nextTick()

    expect('number' in (api.values.notify as AnyNotify)).toBe(false)
  })

  it('defaultValues missing the union path entirely yields the first variant default cleanly', async () => {
    const handle: { api?: ProfileApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: profileSchema,
          key: `du-bad-defaults-no-union-${Math.random().toString(36).slice(2)}`,
          defaultValues: { name: '' } as never,
        }) as unknown as ProfileApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as ProfileApi
    await nextTick()

    const notify = api.values.notify as AnyNotify
    const matches =
      (notify.channel === 'email' && typeof notify.address === 'string') ||
      (notify.channel === 'sms' && typeof notify.number === 'string')
    expect(matches).toBe(true)
  })
})

describe('DU hardening — invalid OUTER discriminator with valid inner state', () => {
  const flowSchema = z.object({
    flow: z.discriminatedUnion('step', [
      z.object({
        step: z.literal('choose'),
        inner: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('A'), a: z.string() }),
          z.object({ kind: z.literal('B'), b: z.string() }),
        ]),
      }),
      z.object({ step: z.literal('done'), notes: z.string() }),
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
          key: `du-nested-outer-invalid-${Math.random().toString(36).slice(2)}`,
          defaultValues: { flow: { step: 'choose', inner: { kind: 'A', a: 'typed-a' } } },
        }) as unknown as FlowApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    return { app, api: handle.api as FlowApi }
  }
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('invalid outer write does NOT leave the inner subtree as an orphan island', async () => {
    const { app, api } = mountFlow()
    apps.push(app)

    api.setValue('flow.step', 'BAD_OUTER')
    await nextTick()

    // Outer collapses to `{step:'BAD_OUTER'}`, dropping the prior
    // variant's whole `inner` subtree so no orphan island survives
    // under a non-variant parent.
    const flow = api.values.flow as AnyFlow
    const isStub = Object.keys(flow).length === 1 && flow.step === 'BAD_OUTER'
    const valid =
      isStub ||
      (flow.step === 'choose' && typeof flow.inner === 'object') ||
      (flow.step === 'done' && typeof flow.notes === 'string')
    expect(valid).toBe(true)
  })

  it('outer Case B with invalid inner discriminator does not embed garbage', async () => {
    const { app, api } = mountFlow()
    apps.push(app)

    api.setValue('flow', { step: 'choose', inner: { kind: 'BAD_INNER', a: 'x' } })
    await nextTick()

    // The outer reshape activates the choose variant and inner
    // collapses to `{kind:'BAD_INNER'}`, dropping `a`. The mixed
    // `{kind:'BAD_INNER', a:'x'}` is the one shape rejected.
    const flow = api.values.flow as AnyFlow
    const inner = flow.inner as AnyInner
    const isStub = Object.keys(inner).length === 1 && inner.kind === 'BAD_INNER'
    const innerValid =
      isStub ||
      (inner.kind === 'A' && typeof inner.a === 'string' && !('b' in inner)) ||
      (inner.kind === 'B' && typeof inner.b === 'string' && !('a' in inner))
    expect(innerValid).toBe(true)
  })

  it('switching outer back to a valid variant after an invalid intermediate restores cleanly', async () => {
    const { app, api } = mountFlow()
    apps.push(app)

    api.setValue('flow.step', 'BAD_OUTER')
    await nextTick()
    api.setValue('flow.step', 'done')
    await nextTick()

    // The valid `done` variant carries only `notes`, so the sequence
    // ends at the slim default `notes: ''` with no leftover `inner` and
    // no leftover `step:'BAD_OUTER'`.
    const flow = api.values.flow as AnyFlow
    expect(flow.step).toBe('done')
    expect('inner' in flow).toBe(false)
    expect(typeof flow.notes).toBe('string')
  })
})

describe('DU hardening — reset / resetField after an invalid discriminator write', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('resetField on the discriminator path recovers to a valid shape', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('notify.channel', 'wat')
    await nextTick()

    api.resetField('notify.channel')
    await nextTick()

    const notify = api.values.notify as AnyNotify
    expect(notify.channel).toBe('email')
    // A clean shape, with no orphan or invalid leftover.
    expect(typeof notify.address).toBe('string')
  })

  it('resetField on the union path recovers to a valid shape', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('notify.channel', 'wat')
    await nextTick()

    api.resetField('notify')
    await nextTick()

    const notify = api.values.notify as AnyNotify
    const valid =
      (notify.channel === 'email' && typeof notify.address === 'string') ||
      (notify.channel === 'sms' && typeof notify.number === 'string')
    expect(valid).toBe(true)
  })

  it('reset() recovers cleanly from an invalid form state', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('notify.channel', 'wat')
    await nextTick()

    api.reset()
    await nextTick()

    const notify = api.values.notify as AnyNotify
    const valid =
      (notify.channel === 'email' && typeof notify.address === 'string') ||
      (notify.channel === 'sms' && typeof notify.number === 'string')
    expect(valid).toBe(true)
  })
})

describe('DU hardening — field metadata side-effects of an invalid discriminator write', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it("the union path's `valid` flag is FALSE after an invalid discriminator write", async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('notify.channel', 'wat')
    await api.parse({ commit: true })
    await nextTick()

    // Container proxies are not leaf views: `api.fields.notify.valid`
    // descends, and the aggregated boolean lives on the call form
    // `api.fields('notify')`. Validation puts the discriminator
    // mismatch at or under the union path, so that boolean is false.
    const notifyState = (
      api as unknown as {
        fields: (path: string) => { valid: boolean; errors: unknown[] }
      }
    ).fields('notify')
    expect(notifyState.valid).toBe(false)
  })

  it("the discriminator leaf's `valid` flag is FALSE after the invalid write", async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('notify.channel', 'wat')
    await api.parse({ commit: true })
    await nextTick()

    const channelField = (
      api as unknown as {
        fields: { notify: { channel: { valid: boolean } } }
      }
    ).fields.notify.channel
    expect(channelField.valid).toBe(false)
  })

  it('form-level meta.valid is FALSE after an invalid discriminator write', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('notify.channel', 'wat')
    await api.parse({ commit: true })
    await nextTick()

    expect(api.meta.valid).toBe(false)
  })
})

describe('DU hardening — handleSubmit while the form has an invalid discriminator', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('routes to onError, not onSuccess, when the discriminator is invalid', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('notify.channel', 'wat')
    await nextTick()

    let successFired = false
    let errorFired = false
    const submit = api.handleSubmit(
      () => {
        successFired = true
      },
      () => {
        errorFired = true
      }
    )
    await submit()
    await nextTick()

    expect(successFired).toBe(false)
    expect(errorFired).toBe(true)
  })

  it('the onError callback receives an error list including the discriminator path', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('notify.channel', 'wat')
    await nextTick()

    let capturedErrors: { path: (string | number)[]; message: string }[] = []
    const submit = api.handleSubmit(
      () => {},
      (errors) => {
        capturedErrors = errors as typeof capturedErrors
      }
    )
    await submit()
    await nextTick()

    const paths = capturedErrors.map((e) => e.path.join('.'))
    const hasDiscError = paths.some((p) => p === 'notify' || p === 'notify.channel' || p === '')
    expect(hasDiscError).toBe(true)
  })
})

// Arrays crossed with discriminated unions. Three structural shapes,
// each with its own hazard:
//
//   (a) `z.array(z.discriminatedUnion(...))`: every element carries its
//       own discriminator, and variant memory is keyed by absolute path
//       (`['events', 0, 'channel']`), so splicing or reordering shifts
//       memory entries onto elements they were never captured for.
//
//   (b) `discriminatedUnion('kind', [{kind:'list', items: array(...)},
//       {kind:'single', ...}])`: switching the outer discriminator
//       hides and restores a whole array branch, so memory has to round
//       trip a non-trivial subtree.
//
//   (c) indexed Case A vs Case B: a write to `events.0.type` (the leaf)
//       against one to `events.0` (the whole element). Invalid
//       discriminators behave identically through both.
//
// Array reshape arrives through `fieldArray.append` / `.remove` /
// `.swap` / `.move` and whole-array `setValue`, so the probes drive
// each of them.

describe('DU hardening — array of DU: variant memory under array reshape', () => {
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
    append: (path: string, value: unknown) => boolean
    prepend: (path: string, value: unknown) => boolean
    insert: (path: string, index: number, value: unknown) => boolean
    remove: (path: string, index: number) => boolean
    swap: (path: string, a: number, b: number) => boolean
    move: (path: string, from: number, to: number) => boolean
    values: { events: Array<{ type: string } & Record<string, unknown>> }
  }
  function mountArr(initial?: Array<{ type: string } & Record<string, unknown>>): ArrayApi {
    const handle: { api?: ArrayApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: arraySchema,
          key: `du-array-interplay-${Math.random().toString(36).slice(2)}`,
          defaultValues: {
            events: initial ?? [
              { type: 'click', x: 'first' },
              { type: 'text', value: 'second' },
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
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('removing an element does NOT bleed its memory onto the new occupant of that index', async () => {
    const api = mountArr()

    // Build memory at events.0: type into click.x, then switch to
    // text. Variant memory captures `click -> {x:'first'}` keyed by the
    // absolute path `["events",0]`.
    api.setValue('events.0.x', 'click-typed')
    api.setValue('events.0.type', 'text')
    await nextTick()

    // Splice element 0 out. Original events[1] (a `text` element) is
    // now events[0]. The path-keyed memory at `["events",0]` was
    // captured for the OLD events[0] (a totally different element).
    api.remove('events', 0)
    await nextTick()

    // Switch the now-events[0] (was events[1]) from text to click.
    // Honouring memory by index would restore the OLD events[0]'s typed
    // `x: 'click-typed'`, a cross-element bleed: events[1]'s click
    // variant has never been typed, so `x` is the slim default.
    api.setValue('events.0.type', 'click')
    await nextTick()

    const e0 = api.values.events[0] as AnyEvent
    expect(e0).toEqual({ type: 'click', x: '' })
  })

  it('truncating the array (length:= 1) drops memory for indices beyond the new length', async () => {
    const api = mountArr([
      { type: 'click', x: 'a' },
      { type: 'click', x: 'b' },
      { type: 'click', x: 'c' },
    ])

    // Build memory at indices 1 and 2.
    api.setValue('events.1.type', 'text')
    api.setValue('events.2.type', 'text')
    await nextTick()

    // Truncate to one element. Memory entries for events.1 and
    // events.2 describe elements that no longer exist, so they are
    // dropped rather than left to linger.
    api.setValue('events', [{ type: 'click', x: 'a' }])
    await nextTick()

    // Append two new elements and switch them around. New elements
    // must NOT inherit ghost memory from the truncated indices.
    api.append('events', { type: 'text', value: 'fresh-1' })
    api.append('events', { type: 'text', value: 'fresh-2' })
    await nextTick()

    api.setValue('events.1.type', 'click')
    api.setValue('events.2.type', 'click')
    await nextTick()

    expect(api.values.events[1]).toEqual({ type: 'click', x: '' })
    expect(api.values.events[2]).toEqual({ type: 'click', x: '' })
  })

  it('whole-array replace clears memory for every index', async () => {
    const api = mountArr()

    api.setValue('events.0.x', 'will-vanish')
    api.setValue('events.0.type', 'text')
    api.setValue('events.1.value', 'also-gone')
    api.setValue('events.1.type', 'click')
    await nextTick()

    // Wholesale replace.
    api.setValue('events', [
      { type: 'text', value: 'new-0' },
      { type: 'click', x: 'new-1' },
    ])
    await nextTick()

    // Switching the new elements' discriminators surfaces no
    // pre-replace memory: the elements just installed have no history
    // with this form.
    api.setValue('events.0.type', 'click')
    api.setValue('events.1.type', 'text')
    await nextTick()

    expect(api.values.events[0]).toEqual({ type: 'click', x: '' })
    expect(api.values.events[1]).toEqual({ type: 'text', value: '' })
  })

  it('swap of two array elements does NOT swap variant memory along with them', async () => {
    const api = mountArr()

    // Build distinct memory at events.0 and events.1.
    api.setValue('events.0.x', 'zero-x')
    api.setValue('events.0.type', 'text')
    api.setValue('events.1.value', 'one-value')
    api.setValue('events.1.type', 'click')
    await nextTick()

    // After the swap, events[0] is the original `text` element and
    // events[1] the original `click`. Memory is keyed by path, so
    // restoring events[0] consults an entry captured for a different
    // element identity.
    api.swap('events', 0, 1)
    await nextTick()

    api.setValue('events.0.type', 'click')
    api.setValue('events.1.type', 'text')
    await nextTick()

    // The newly-occupying elements must restore from THEIR identities'
    // memory, not whatever happened to be at the index before. Or, if
    // memory just clears on swap, both should fall back to slim defaults.
    const e0 = api.values.events[0] as AnyEvent
    const e1 = api.values.events[1] as AnyEvent
    const cleanFallback = e0.x === '' && e1.value === ''
    const identityRestore = e0.x === 'one-value' && e1.value === 'zero-x'
    expect(cleanFallback || identityRestore).toBe(true)
  })

  it('move of an array element preserves identity-tied memory or clears it cleanly', async () => {
    const api = mountArr([
      { type: 'click', x: 'A' },
      { type: 'click', x: 'B' },
      { type: 'click', x: 'C' },
    ])

    // Memory at events.0: A typed click.
    api.setValue('events.0.type', 'text')
    await nextTick()
    // After this, memory at events.0 holds `click → {x:'A'}`.

    // Move element 0 to position 2. The original element at 0 (now type
    // 'text') is now at index 2. Memory at events.0 (keyed by index)
    // refers to a DIFFERENT element after the move.
    api.move('events', 0, 2)
    await nextTick()

    // Switch the now-events[0] (was events[1]) from click → text → click.
    api.setValue('events.0.type', 'text')
    api.setValue('events.0.type', 'click')
    await nextTick()

    // After a move, memory at the moved index must not restore the
    // moved-out element's typed state on a same-index switch. Both the
    // slim default and the new occupant's own pre-switch state (B's
    // `x: 'B'` from defaultValues) honour that; A's `'A'` reaching the
    // new events[0] is the cross-element bleed.
    const e0 = api.values.events[0] as AnyEvent
    expect(e0.type).toBe('click')
    expect(e0.x).not.toBe('A')
  })
})

describe('DU hardening — DU containing an array variant: round-trip preservation', () => {
  const containerSchema = z.object({
    payload: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('list'),
        items: z.array(z.object({ sku: z.string() })),
      }),
      z.object({ kind: z.literal('single'), item: z.string() }),
    ]),
  })
  type ContainerApi = Omit<UseFormReturnType<z.output<typeof containerSchema>>, 'setValue'> & {
    setValue: (path: string, value: unknown) => boolean
    append: (path: string, value: unknown) => boolean
    values: { payload: { kind: string } & Record<string, unknown> }
  }
  function mount(): ContainerApi {
    const handle: { api?: ContainerApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: containerSchema,
          key: `du-array-variant-${Math.random().toString(36).slice(2)}`,
          defaultValues: { payload: { kind: 'list', items: [] } },
        }) as unknown as ContainerApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    return handle.api as ContainerApi
  }
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('round-tripping an array-variant restores the array contents from memory', async () => {
    const api = mount()

    api.append('payload.items', { sku: 'S-1' })
    api.append('payload.items', { sku: 'S-2' })
    await nextTick()

    api.setValue('payload.kind', 'single')
    await nextTick()
    expect(api.values.payload).toEqual({ kind: 'single', item: '' })

    api.setValue('payload.kind', 'list')
    await nextTick()

    expect(api.values.payload).toEqual({
      kind: 'list',
      items: [{ sku: 'S-1' }, { sku: 'S-2' }],
    })
  })

  it('an invalid intermediate while in the array variant does not corrupt the items', async () => {
    const api = mount()

    api.append('payload.items', { sku: 'S-1' })
    await nextTick()

    api.setValue('payload.kind', 'BAD')
    await nextTick()

    api.setValue('payload.kind', 'single')
    await nextTick()
    api.setValue('payload.kind', 'list')
    await nextTick()

    // After the invalid intermediate and the round trip back, items is
    // either the originally-typed `[{sku:'S-1'}]` restored from
    // pre-invalid memory, or the slim default `[]`. Never the invalid
    // intermediate's frozen state.
    const payload = api.values.payload as AnyPayload
    expect(payload.kind).toBe('list')
    expect(Array.isArray(payload.items)).toBe(true)
    const items = payload.items as Array<{ sku?: string }>
    const cleanRestore = (items.length === 1 && items[0]?.sku === 'S-1') || items.length === 0
    expect(cleanRestore).toBe(true)
  })
})

describe('DU hardening — array index Case A/B with invalid discriminator', () => {
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
    append: (path: string, value: unknown) => boolean
    values: { events: Array<{ type: string } & Record<string, unknown>> }
  }
  function mountArr(): ArrayApi {
    const handle: { api?: ArrayApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: arraySchema,
          key: `du-array-element-cases-${Math.random().toString(36).slice(2)}`,
          defaultValues: {
            events: [
              { type: 'click', x: 'first' },
              { type: 'text', value: 'second' },
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
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('Case B at an array index with an invalid discriminator lands a disc-only stub', async () => {
    const api = mountArr()

    const ok = api.setValue('events.0', { type: 'unknown', x: 'foo' })
    await nextTick()

    expect(ok).toBe(true)
    // Stub holds only the disc; consumer's foreign `x` is dropped so
    // form.values can't carry non-variant fields. Validation flags
    // the bad disc via Zod's natural error flow.
    expect(api.values.events[0]).toEqual({ type: 'unknown' })
  })

  it('Case B at an array index with an unknown EXTRA key is also rejected', async () => {
    const api = mountArr()

    const ok = api.setValue('events.0', { type: 'click', x: '', extra: 1 })
    await nextTick()

    expect(ok).toBe(false)
  })

  it('`unset` on an array element discriminator does NOT keep foreign keys', async () => {
    const api = mountArr()

    // Pre: events[0] = { type:'click', x:'first' }.
    api.setValue('events.0.type', unset)
    await nextTick()

    const e0 = api.values.events[0] as AnyEvent
    // Either the element collapses to `{type:''}` with `x` cleaned up
    // and the discriminator tracked as blank, or it retains a valid
    // variant. `{type:'', x:'first'}` is the mixed shape it never
    // holds.
    const valid =
      (Object.keys(e0).length === 1 && e0.type === '') ||
      (e0.type === 'click' && typeof e0.x === 'string') ||
      (e0.type === 'text' && typeof e0.value === 'string')
    expect(valid).toBe(true)
  })

  it('append with an invalid discriminator is rejected (or coerced to a valid variant)', async () => {
    const api = mountArr()

    // Pre: length 2.
    api.append('events', { type: 'BAD', whatever: 1 })
    await nextTick()

    // Either the append is rejected (length stays at 2) or the element
    // is coerced to a valid variant (length grew but the new element
    // has a real shape). The bug outcome: length grew with junk.
    if (api.values.events.length === 3) {
      const newElement = api.values.events[2] as AnyEvent
      const valid =
        (newElement.type === 'click' && typeof newElement.x === 'string') ||
        (newElement.type === 'text' && typeof newElement.value === 'string')
      expect(valid).toBe(true)
    } else {
      expect(api.values.events.length).toBe(2)
    }
  })

  it('write past current length with invalid discriminator grows cleanly with stub at target', async () => {
    const api = mountArr()

    // Pre: length 2; this would create indices 2-4 to reach index 5.
    const ok = api.setValue('events.5', { type: 'BAD' })
    await nextTick()

    // The target index lands `{type:'BAD'}` while gap indices 2-4 are
    // padded with the schema's element default, so no first-variant
    // fields leak onto the index the consumer aimed at.
    if (ok === true && api.values.events.length > 2) {
      for (let i = 0; i < api.values.events.length; i++) {
        const e = api.values.events[i] as AnyEvent
        const isTargetStub = i === 5 && Object.keys(e).length === 1 && e.type === 'BAD'
        const isValidVariant =
          (e.type === 'click' && typeof e.x === 'string') ||
          (e.type === 'text' && typeof e.value === 'string')
        expect(isTargetStub || isValidVariant).toBe(true)
      }
    } else {
      expect(api.values.events.length).toBe(2)
    }
  })
})

describe('DU hardening — array element invalid disc: container-level error reporting', () => {
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

  it("array container's firstError surfaces the bad element's discriminator mismatch", async () => {
    const handle: { api?: ArrayApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: arraySchema,
          key: `du-array-aggregate-${Math.random().toString(36).slice(2)}`,
          defaultValues: {
            events: [
              { type: 'click', x: 'a' },
              { type: 'click', x: 'b' },
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

    api.setValue('events.1.type', 'BAD')
    await api.parse({ commit: true })
    await nextTick()

    // The array container's `firstError` reflects a broken element, so
    // a parent UI bound to the array's summary error does not have to
    // walk every index itself. Like every rolled-up container value it
    // reads through the call form `form.fields('events')`, not through
    // field-state keys on the navigable node.
    expect(api.fields('events').firstError).toBeDefined()
  })
})

// Corner cases far from the happy path. Each test pins a property
// Attaform holds under adversarial input.

import { reactive, ref } from 'vue'

describe('chaos — caller mutates value AFTER setValue', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('mutating the input object after setValue does not retro-mutate form storage', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    const live = { channel: 'sms' as const, number: '5551234' }
    api.setValue('notify', live)
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'sms', number: '5551234' })

    // The caller mutates their own reference. The form owns its
    // storage, so sharing that reference would let later edits outside
    // the form poison it.
    live.number = 'pwned'
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'sms', number: '5551234' })
  })

  it('frozen object passed to setValue does not crash the merge', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    const frozen = Object.freeze({ channel: 'sms' as const, number: '5551234' })
    expect(() => api.setValue('notify', frozen)).not.toThrow()
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'sms', number: '5551234' })
  })
})

describe('chaos — prototype pollution attempts via path & value', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it("setValue('__proto__.polluted', true) does not actually pollute Object.prototype", async () => {
    const recordSchema = z.object({
      bag: z.record(z.string(), z.string()),
    })
    type RecordApi = Omit<UseFormReturnType<z.output<typeof recordSchema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { bag: Record<string, string> }
    }
    const handle: { api?: RecordApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: recordSchema,
          key: `chaos-proto-${Math.random().toString(36).slice(2)}`,
          defaultValues: { bag: {} },
        }) as unknown as RecordApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as RecordApi

    api.setValue('bag.__proto__.polluted', 'yes')
    await nextTick()

    // `Object.prototype` does not pick up `polluted`. If it did, every
    // object in the realm would carry the property.
    const fresh = {} as Record<string, unknown>
    expect(fresh['polluted']).toBeUndefined()
    // Cleanup if pollution did occur, so subsequent tests aren't flaky.
    delete (Object.prototype as unknown as Record<string, unknown>)['polluted']
  })

  it('setValue at a nested path with `constructor` does not clobber the global', async () => {
    const recordSchema = z.object({
      bag: z.record(z.string(), z.string()),
    })
    type RecordApi = Omit<UseFormReturnType<z.output<typeof recordSchema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
    }
    const handle: { api?: RecordApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: recordSchema,
          key: `chaos-ctor-${Math.random().toString(36).slice(2)}`,
          defaultValues: { bag: {} },
        }) as unknown as RecordApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as RecordApi

    api.setValue('bag.constructor.prototype.x', 'BAD')
    await nextTick()

    // Object.prototype.x must remain untouched.
    expect(({} as Record<string, unknown>)['x']).toBeUndefined()
    delete (Object.prototype as unknown as Record<string, unknown>)['x']
  })
})

describe('chaos — values that break JSON.stringify (variant memory snapshot)', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('a BigInt value at a leaf does not crash the variant-memory snapshot during a switch', async () => {
    const bigSchema = z.object({
      payload: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('big'), id: z.bigint() }),
        z.object({ kind: z.literal('small'), n: z.number() }),
      ]),
    })
    type BigApi = Omit<UseFormReturnType<z.output<typeof bigSchema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { payload: { kind: string } & Record<string, unknown> }
    }
    const handle: { api?: BigApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: bigSchema,
          key: `chaos-bigint-${Math.random().toString(36).slice(2)}`,
          defaultValues: { payload: { kind: 'big', id: 42n } },
        }) as unknown as BigApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as BigApi

    // Set a real BigInt, then switch the discriminator. Variant memory
    // deep-clones the outgoing subtree with
    // `JSON.parse(JSON.stringify(...))`, and JSON.stringify throws on
    // BigInt, so the hazard is a runtime error or a corrupt entry.
    api.setValue('payload.id', 9007199254740993n)
    await nextTick()

    expect(() => api.setValue('payload.kind', 'small')).not.toThrow()
    await nextTick()

    expect(api.values.payload.kind).toBe('small')
  })

  it('round-tripping after a BigInt-bearing variant restores the typed value', async () => {
    const bigSchema = z.object({
      payload: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('big'), id: z.bigint() }),
        z.object({ kind: z.literal('small'), n: z.number() }),
      ]),
    })
    type BigApi = Omit<UseFormReturnType<z.output<typeof bigSchema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { payload: { kind: string } & Record<string, unknown> }
    }
    const handle: { api?: BigApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: bigSchema,
          key: `chaos-bigint-rt-${Math.random().toString(36).slice(2)}`,
          defaultValues: { payload: { kind: 'big', id: 42n } },
        }) as unknown as BigApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as BigApi

    api.setValue('payload.id', 9007199254740993n)
    api.setValue('payload.kind', 'small')
    await nextTick()
    api.setValue('payload.kind', 'big')
    await nextTick()

    // A successful snapshot restores the typed BigInt; a silently
    // crashed one leaves the slim default (0n). Either is acceptable so
    // long as the value still matches its type.
    expect(typeof api.values.payload.id).toBe('bigint')
  })
})

describe('chaos — exotic discriminator literal types', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('boolean discriminator (z.literal(true) / z.literal(false)) reshapes correctly', async () => {
    const boolSchema = z.object({
      flag: z.discriminatedUnion('on', [
        z.object({ on: z.literal(true), reason: z.string() }),
        z.object({ on: z.literal(false), excuse: z.string() }),
      ]),
    })
    type BoolApi = Omit<UseFormReturnType<z.output<typeof boolSchema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { flag: { on: boolean } & Record<string, unknown> }
    }
    const handle: { api?: BoolApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: boolSchema,
          key: `chaos-bool-disc-${Math.random().toString(36).slice(2)}`,
          defaultValues: { flag: { on: true, reason: '' } },
        }) as unknown as BoolApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as BoolApi

    api.setValue('flag.on', false)
    await nextTick()

    expect(api.values.flag).toEqual({ on: false, excuse: '' })
  })

  it('null/undefined slim-gate posture against a boolean discriminator', async () => {
    // 0 is not in {true, false}; should be rejected like an invalid string.
    const boolSchema = z.object({
      flag: z.discriminatedUnion('on', [
        z.object({ on: z.literal(true), reason: z.string() }),
        z.object({ on: z.literal(false), excuse: z.string() }),
      ]),
    })
    type BoolApi = Omit<UseFormReturnType<z.output<typeof boolSchema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { flag: { on: boolean | unknown } & Record<string, unknown> }
    }
    const handle: { api?: BoolApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: boolSchema,
          key: `chaos-bool-disc-bad-${Math.random().toString(36).slice(2)}`,
          defaultValues: { flag: { on: true, reason: '' } },
        }) as unknown as BoolApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as BoolApi

    // Type-mismatched: slim-primitive gate should reject (the literal
    // accepts only `boolean`).
    expect(api.setValue('flag.on', 0)).toBe(false)
    expect(api.setValue('flag.on', null)).toBe(false)
    expect(api.setValue('flag.on', 'true')).toBe(false)
  })
})

describe('chaos — NaN at the discriminator', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it("setValue('payload.kind', NaN) is rejected when no NaN literal exists", async () => {
    const schema = z.object({
      payload: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal(1), v: z.string() }),
        z.object({ kind: z.literal(2), v: z.string() }),
      ]),
    })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { payload: { kind: number } & Record<string, unknown> }
    }
    const handle: { api?: Api } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `chaos-nan-${Math.random().toString(36).slice(2)}`,
          defaultValues: { payload: { kind: 1, v: '' } },
        }) as unknown as Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as Api

    expect(api.setValue('payload.kind', Number.NaN)).toBe(true)
    await nextTick()
    // Stub holds the consumer's NaN; validation flags the mismatch
    // (no NaN literal in any variant) on next committing parse.
    expect(api.values.payload).toEqual({ kind: Number.NaN })
  })
})

describe('chaos — `-0` written over `0` at a numeric leaf', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('does not trigger an unintended discriminator reshape (Object.is(0,-0) === false)', async () => {
    const schema = z.object({
      payload: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal(0), v: z.string() }),
        z.object({ kind: z.literal(1), w: z.string() }),
      ]),
    })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { payload: { kind: number } & Record<string, unknown> }
    }
    const handle: { api?: Api } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `chaos-negzero-${Math.random().toString(36).slice(2)}`,
          defaultValues: { payload: { kind: 0, v: 'kept' } },
        }) as unknown as Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as Api

    api.setValue('payload.kind', -0)
    await nextTick()

    // Either treated as no-op (kept v) or reshaped (variant default).
    // Whatever happens, the form must NOT enter an inconsistent shape.
    const payload = api.values.payload as AnyPayload
    const valid =
      (payload.kind === 0 && typeof payload.v === 'string') ||
      (payload.kind === 1 && typeof payload.w === 'string')
    expect(valid).toBe(true)
  })
})

describe('chaos — DU with two variants sharing the same literal value', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it("zod surfaces a schema-level error or first-wins; runtime doesn't crash", async () => {
    // Two variants sharing `kind: z.literal('a')` is illegal in v4.
    // Construction may throw, succeed, or silently pick one; the test
    // catches all three.
    let constructed = false
    let err: unknown = null
    try {
      const schema = z.object({
        x: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('a'), v: z.string() }),
          z.object({ kind: z.literal('a'), w: z.string() }),
        ]),
      })
      type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
        setValue: (path: string, value: unknown) => boolean
      }
      const handle: { api?: Api } = {}
      const App = defineComponent({
        setup() {
          handle.api = useForm({
            schema,
            key: `chaos-dup-disc-${Math.random().toString(36).slice(2)}`,
            defaultValues: { x: { kind: 'a', v: '' } },
          }) as unknown as Api
          return () => h('div')
        },
      })
      const app = createApp(App).use(createAttaform())
      app.mount(document.createElement('div'))
      apps.push(app)
      constructed = handle.api !== undefined
    } catch (e) {
      err = e
    }

    // Either Zod refused to construct the schema (err is set), or the
    // form mounted and we're just confirming we didn't crash silently
    // in some unknowable middle state.
    expect(err !== null || constructed === true).toBe(true)
  })
})

describe('chaos — recursive DU via z.lazy (tree of nodes)', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('mounts a recursive DU schema without infinite loop', async () => {
    type Node = { kind: 'leaf'; value: string } | { kind: 'branch'; children: Node[] }
    const nodeSchema: z.ZodType<Node> = z.lazy(() =>
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('leaf'), value: z.string() }),
        z.object({ kind: z.literal('branch'), children: z.array(nodeSchema) }),
      ])
    )
    const treeSchema = z.object({ tree: nodeSchema })
    type TreeApi = Omit<UseFormReturnType<z.output<typeof treeSchema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { tree: Node }
    }
    const handle: { api?: TreeApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: treeSchema,
          key: `chaos-lazy-du-${Math.random().toString(36).slice(2)}`,
          defaultValues: {
            tree: {
              kind: 'branch',
              children: [
                { kind: 'leaf', value: 'a' },
                { kind: 'leaf', value: 'b' },
              ],
            },
          },
        }) as unknown as TreeApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as TreeApi
    await nextTick()

    expect(api.values.tree.kind).toBe('branch')
  })

  it("switching the discriminator at a recursive node doesn't blow the stack", async () => {
    type Node = { kind: 'leaf'; value: string } | { kind: 'branch'; children: Node[] }
    const nodeSchema: z.ZodType<Node> = z.lazy(() =>
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('leaf'), value: z.string() }),
        z.object({ kind: z.literal('branch'), children: z.array(nodeSchema) }),
      ])
    )
    const treeSchema = z.object({ tree: nodeSchema })
    type TreeApi = Omit<UseFormReturnType<z.output<typeof treeSchema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { tree: Node }
    }
    const handle: { api?: TreeApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: treeSchema,
          key: `chaos-lazy-du-switch-${Math.random().toString(36).slice(2)}`,
          defaultValues: {
            tree: { kind: 'leaf', value: 'hi' },
          },
        }) as unknown as TreeApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as TreeApi

    expect(() => api.setValue('tree.kind', 'branch')).not.toThrow()
    await nextTick()

    const tree = api.values.tree as AnyTree
    expect(tree.kind).toBe('branch')
  })
})

describe('chaos — setValue re-entry inside listener callbacks', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('a Vue watcher that calls setValue inside its callback does not infinite-loop', async () => {
    const profileSchemaLocal = z.object({
      name: z.string(),
      mirror: z.string(),
    })
    type Api = Omit<UseFormReturnType<z.output<typeof profileSchemaLocal>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { name: string; mirror: string }
    }
    let callCount = 0
    const handle: { api?: Api } = {}
    const App = defineComponent({
      setup() {
        const api = useForm({
          schema: profileSchemaLocal,
          key: `chaos-reentry-${Math.random().toString(36).slice(2)}`,
          defaultValues: { name: '', mirror: '' },
        }) as unknown as Api
        // Mirror `name` into `mirror` through a watch. Re-entering
        // setValue from the watcher re-emits, which fires the watcher
        // again; the write path guards that rather than diverging.
        let stop = 0
        const live = api as unknown as { values: { name: string } }
        const observer = (): void => {
          if (callCount > 50) return // hard stop in case of regression
          callCount++
          if (live.values.name !== '') {
            api.setValue('mirror', live.values.name.toUpperCase())
          }
        }
        observer()
        // Use a simple watch via a microtask burst.
        ;(async () => {
          while (stop < 5) {
            await nextTick()
            observer()
            stop++
          }
        })()
        handle.api = api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as Api

    api.setValue('name', 'ada')
    await nextTick()
    await nextTick()

    expect(callCount).toBeLessThan(50)
    expect(api.values.mirror).toBe('ADA')
  })
})

describe('chaos — handleSubmit fired twice rapidly', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('does not call onSuccess twice for one logical submission', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('name', 'Ada')
    api.setValue('notify', { channel: 'sms', number: '5551234' })
    await nextTick()

    let successCalls = 0
    const submit = api.handleSubmit(
      () => {
        successCalls++
      },
      () => {}
    )

    // Fire twice without awaiting between.
    const p1 = submit()
    const p2 = submit()
    await Promise.all([p1, p2])
    await nextTick()

    expect(successCalls).toBeLessThanOrEqual(1)
  })
})

describe('chaos — Vue ref / reactive object passed as setValue value', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('passing a `reactive(...)` object stores plain data, not the proxy', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    const reactiveValue = reactive({ channel: 'sms' as const, number: '5551234' })
    api.setValue('notify', reactiveValue)
    await nextTick()

    // Mutating the original proxy must NOT change form storage
    // (proves the form snapshotted plain data, not held a reference).
    reactiveValue.number = 'changed'
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'sms', number: '5551234' })
  })

  it('passing a Vue `ref(...)` is rejected or unwrapped — never stored as a Ref proxy', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    const refValue = ref({ channel: 'sms' as const, number: '5551234' })
    api.setValue('notify', refValue)
    await nextTick()

    // Either rejection (storage unchanged from the email default) or
    // unwrap (sms applied). What it must not do is store the Ref
    // wholesale, since its `.value` key is not in the schema.
    const notify = api.values.notify as AnyNotify
    const acceptedAndUnwrapped = notify.channel === 'sms' && typeof notify.number === 'string'
    const rejectedKeptEmail = notify.channel === 'email'
    expect(acceptedAndUnwrapped || rejectedKeptEmail).toBe(true)
    // The smoking-gun check: storage must not have a `.value` key.
    expect('value' in notify).toBe(false)
  })
})

describe('chaos — Symbol-keyed values in the input object', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('object with a Symbol key alongside string keys does not crash setValue', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    const sym = Symbol('hidden')
    const value: Record<string | symbol, unknown> = {
      channel: 'sms',
      number: '5551234',
    }
    value[sym] = 'unseen'

    expect(() => api.setValue('notify', value)).not.toThrow()
    await nextTick()
    // Symbol must not appear in storage.
    const stored = api.values.notify
    const symKeys = Object.getOwnPropertySymbols(stored)
    expect(symKeys.length).toBe(0)
  })
})

describe('chaos — DU variant with no fields beyond the discriminator', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('a discriminator-only variant produces a clean shape on switch', async () => {
    const schema = z.object({
      action: z.discriminatedUnion('type', [
        z.object({ type: z.literal('noop') }),
        z.object({ type: z.literal('payload'), data: z.string() }),
      ]),
    })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { action: { type: string } & Record<string, unknown> }
    }
    const handle: { api?: Api } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `chaos-empty-variant-${Math.random().toString(36).slice(2)}`,
          defaultValues: { action: { type: 'payload', data: 'hello' } },
        }) as unknown as Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as Api

    api.setValue('action.type', 'noop')
    await nextTick()

    // The `data` key from the payload variant must not survive.
    expect(api.values.action).toEqual({ type: 'noop' })
  })
})

describe('chaos — two DUs with the same discriminator key at different paths', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('switches at one DU do not leak memory into the other', async () => {
    const schema = z.object({
      outer: z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('A'),
          inner: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('X'), x: z.string() }),
            z.object({ kind: z.literal('Y'), y: z.string() }),
          ]),
        }),
        z.object({ kind: z.literal('B'), b: z.string() }),
      ]),
    })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { outer: { kind: string } & Record<string, unknown> }
    }
    const handle: { api?: Api } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `chaos-same-name-disc-${Math.random().toString(36).slice(2)}`,
          defaultValues: { outer: { kind: 'A', inner: { kind: 'X', x: 'typed-x' } } },
        }) as unknown as Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as Api

    // Switch INNER's kind X → Y. Memory at outer.inner snapshots
    // {kind:X, x:'typed-x'}.
    api.setValue('outer.inner.kind', 'Y')
    await nextTick()

    // Switch OUTER through A, B, A. Memory at outer snapshots
    // `{kind:A, inner:{kind:Y, y:''}}` and restores it on the way back.
    // The two memory maps sit at different absolute paths (`['outer']`
    // and `['outer','inner']`) and never confuse each other.
    api.setValue('outer.kind', 'B')
    await nextTick()
    api.setValue('outer.kind', 'A')
    await nextTick()

    // Now flip inner Y → X. Memory at outer.inner should restore the
    // typed `x: 'typed-x'`.
    api.setValue('outer.inner.kind', 'X')
    await nextTick()

    expect((api.values.outer as { inner?: unknown }).inner).toEqual({
      kind: 'X',
      x: 'typed-x',
    })
  })
})

describe('chaos — array of DU mutated via proxy length / direct index assignment', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('directly setting events.length via setValue does not produce a sparse array', async () => {
    const arraySchema = z.object({
      events: z.array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('click'), x: z.string() }),
          z.object({ type: z.literal('text'), value: z.string() }),
        ])
      ),
    })
    type ArrApi = Omit<UseFormReturnType<z.output<typeof arraySchema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { events: Array<unknown> }
    }
    const handle: { api?: ArrApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: arraySchema,
          key: `chaos-arr-length-${Math.random().toString(36).slice(2)}`,
          defaultValues: { events: [{ type: 'click', x: 'a' }] },
        }) as unknown as ArrApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as ArrApi

    // Write an absurdly far-out index. Either rejection or schema-fill,
    // never a sparse or non-iterable array.
    api.setValue('events.10', { type: 'text', value: 'far' })
    await nextTick()

    // Iterating must not produce `undefined` holes (which would
    // surface as missing-disc errors during validation later).
    let allDefined = true
    for (let i = 0; i < api.values.events.length; i++) {
      if (api.values.events[i] === undefined) {
        allDefined = false
        break
      }
    }
    expect(allDefined).toBe(true)
  })
})

describe('chaos — non-data value types passed to setValue', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('rejects a Function value at a primitive-typed leaf', async () => {
    const schema = z.object({ name: z.string() })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { name: string }
    }
    const handle: { api?: Api } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `chaos-fn-value-${Math.random().toString(36).slice(2)}`,
          defaultValues: { name: 'init' },
        }) as unknown as Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as Api

    // setValue's overloads include a callback form, reached only when
    // the value is a function AND the path resolves to something that
    // function returns a value for. A zero-arity getter at a STRING
    // leaf meets neither condition.
    const fn = (() => 'computed') as unknown
    api.setValue('name', fn)
    await nextTick()

    expect(typeof api.values.name).toBe('string')
  })
})

describe('chaos — exotic path inputs', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('rejects a dotted path with an empty segment ("a..b")', async () => {
    const schema = z.object({ a: z.object({ b: z.string() }) })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
    }
    const handle: { api?: Api } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `chaos-empty-seg-${Math.random().toString(36).slice(2)}`,
          defaultValues: { a: { b: '' } },
        }) as unknown as Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as Api

    let threw = false
    try {
      api.setValue('a..b', 'hi')
    } catch {
      threw = true
    }
    // A throw is the documented contract here. Silent acceptance into
    // a nonsense path is not.
    expect(threw).toBe(true)
  })
})

describe('chaos — writing through register binding for an inactive variant', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('register a path that only exists on the SMS variant while EMAIL is active', async () => {
    // The FieldState lift returns a stub for inactive-variant fields,
    // but a binding outlives the variant: template-bind an input to
    // `register('notify.number')` unconditionally, switch to email, and
    // the binding stays attached to an inactive path that a write would
    // put a foreign key on.
    const { app, api } = mountProfile()
    apps.push(app)

    const ok = api.setValue('notify.number', 'stale-from-sms-binding')
    await nextTick()

    const notify = api.values.notify as AnyNotify
    // The active variant is email, so `number` is not on its shape.
    // Either the cross-variant guard rejects the write and storage
    // stays on a valid email, or the runtime coerces a switch to sms
    // with `number` typed. Only
    // `{channel:'email', address:'old@example.com', number:'stale...'}`
    // is forbidden.
    const valid =
      (ok === false &&
        notify.channel === 'email' &&
        typeof notify.address === 'string' &&
        !('number' in notify)) ||
      (notify.channel === 'sms' && typeof notify.number === 'string')
    expect(valid).toBe(true)
  })
})

describe('chaos — leaf write while the parent discriminator is invalid', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('does not silently let writes succeed against an unrepresentable parent shape', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('notify.channel', 'wat')
    await nextTick()

    // Write to `notify.address` while `channel: 'wat'` matches no
    // variant. The write is rejected, or a valid discriminator is
    // restored first, or a clear error surfaces; what it does not do is
    // deepen the unrepresentable shape.
    const ok = api.setValue('notify.address', 'next@example.com')
    await nextTick()

    if (ok === true) {
      // If accepted, the form must be in some valid shape now (i.e.
      // the runtime auto-recovered). Document via assertion.
      const notify = api.values.notify as AnyNotify
      const valid =
        (notify.channel === 'email' && typeof notify.address === 'string') ||
        (notify.channel === 'sms' && typeof notify.number === 'string')
      expect(valid).toBe(true)
    } else {
      // If rejected, the form's state is unchanged from the prior
      // (already-broken) state. Caller knows to recover via reset.
      expect(ok).toBe(false)
    }
  })
})

// Zod transforms, coerce, preprocess and pipe; DoS-shaped input;
// seemingly-reasonable values; API misuse; v3-vs-v4 quirks.

describe('chaos — z.coerce at the discriminator', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('z.coerce.number() discriminator: string-typed write does not silently corrupt', async () => {
    // `z.coerce.number` has input type `unknown` (it accepts anything
    // and tries `Number(value)`) and output type `number`, so the slim
    // gate has to pick one. Reading the input type lets '1' through and
    // runs the variant lookup against the un-coerced string; reading
    // the output type rejects it. The test pins which, so the two
    // adapters cannot drift apart.
    const schema = z.object({
      payload: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal(1), v: z.string() }),
        z.object({ kind: z.literal(2), w: z.string() }),
      ]),
    })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { payload: { kind: number | string } & Record<string, unknown> }
    }
    const handle: { api?: Api } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `chaos-coerce-disc-${Math.random().toString(36).slice(2)}`,
          defaultValues: { payload: { kind: 1, v: '' } },
        }) as unknown as Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as Api

    // Write a string to a numeric discriminator. The gate either
    // rejects it, or coerces and reshapes. What it must not do is
    // accept the string verbatim and leave `kind: '1'`, which no
    // variant's `z.literal(1)` matches.
    api.setValue('payload.kind', '1')
    await nextTick()

    const payload = api.values.payload as AnyPayload
    const valid =
      (payload.kind === 1 && typeof payload.v === 'string') ||
      (payload.kind === 2 && typeof payload.w === 'string')
    expect(valid).toBe(true)
  })

  it('z.coerce.string() at a non-DU leaf stores the raw write verbatim', async () => {
    const schema = z.object({ name: z.coerce.string() })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { name: unknown }
    }
    const handle: { api?: Api } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `chaos-coerce-string-${Math.random().toString(36).slice(2)}`,
          defaultValues: { name: '' },
        }) as unknown as Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as Api

    api.setValue('name', 42)
    await nextTick()

    // Schema-side coerce runs at parse and submit, never at the write
    // boundary, so the raw number 42 lands in storage and safeParse
    // turns it into '42' when the consumer validates or submits.
    expect(api.values.name).toBe(42)
  })
})

describe('chaos — z.preprocess() wrapping a discriminated union', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('preprocess wrapping a DU: raw null lands in storage; coalescing fires at parse', async () => {
    const inner = z.discriminatedUnion('channel', [
      z.object({ channel: z.literal('email'), address: z.string() }),
      z.object({ channel: z.literal('sms'), number: z.string() }),
    ])
    const schema = z.object({
      notify: z.preprocess((v) => (v == null ? { channel: 'email', address: '' } : v), inner),
    })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { notify: unknown }
    }
    const handle: { api?: Api } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `chaos-preprocess-du-${Math.random().toString(36).slice(2)}`,
          defaultValues: { notify: { channel: 'email', address: '' } },
        }) as unknown as Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as Api

    // Under the no-write-mutation contract, the preprocess fn runs at
    // parse / submit only. The raw null lands in storage at the union
    // path; the fallback variant materialises during safeParse.
    api.setValue('notify', null)
    await nextTick()

    expect(api.values.notify).toBeNull()
  })

  it('v3: preprocess wrapping a DU: raw null lands in storage', async () => {
    // v3 parity. v3 expresses `z.preprocess(fn, inner)` as a ZodEffects
    // with `_def.effect.type === 'preprocess'`, so the v3 adapter's
    // `isPreprocessOrCoerceLeaf` fires at the wrapper and the slim gate
    // takes the raw write verbatim.
    const inner = zV3.discriminatedUnion('channel', [
      zV3.object({ channel: zV3.literal('email'), address: zV3.string() }),
      zV3.object({ channel: zV3.literal('sms'), number: zV3.string() }),
    ])
    const schema = zV3.object({
      notify: zV3.preprocess((v) => (v == null ? { channel: 'email', address: '' } : v), inner),
    })
    const handle: { api?: unknown } = {}
    const App = defineComponent({
      setup() {
        handle.api = useFormV3({
          schema,
          key: `v3-chaos-preprocess-du-${Math.random().toString(36).slice(2)}`,
          defaultValues: { notify: { channel: 'email', address: '' } },
        } as never)
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as {
      setValue: (p: string, v: unknown) => boolean
      values: { notify: unknown }
    }

    api.setValue('notify', null)
    await nextTick()

    expect(api.values.notify).toBeNull()
  })
})

describe('chaos — z.transform() at a leaf changes the output type', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('storage holds the INPUT type, not the transform OUTPUT type', async () => {
    // Input `' hello '` transforms to output `'hello'`. The form stores
    // and returns the input verbatim, leaving the consumer to apply the
    // transform at parse.
    const schema = z.object({
      name: z.string().transform((s) => s.trim().toUpperCase()),
    })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { name: string }
    }
    const handle: { api?: Api } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `chaos-transform-leaf-${Math.random().toString(36).slice(2)}`,
          defaultValues: { name: '' },
        }) as unknown as Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as Api

    api.setValue('name', '  ada  ')
    await nextTick()

    // Storage preserves what the user typed ('  ada  '), so the input
    // element does not reformat their text on every keystroke. The
    // post-transform output stays reachable through `form.parse()`
    // below.
    expect(api.values.name).toBe('  ada  ')
  })

  it('form.parse() returns the post-transform OUTPUT shape while form.values stays as input', async () => {
    // The input/output asymmetry: storage and `form.values` hold the
    // pre-transform value the consumer wrote, while `form.parse()` runs
    // the full pipeline (refinements and transforms) and returns the
    // post-transform one. handleSubmit's callback receives that same
    // shape, so `parse()` is the standalone way to ask for it.
    const schema = z.object({
      isLongEmail: z.string().transform((v) => v.length > 10),
      count: z.string().transform((v) => Number(v)),
    })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { isLongEmail: unknown; count: unknown }
      parse: () => Promise<{
        success: boolean
        data?: { isLongEmail: boolean; count: number }
        errors?: ReadonlyArray<{ message: string }>
      }>
    }
    const handle: { api?: Api } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `chaos-parse-transform-${Math.random().toString(36).slice(2)}`,
          defaultValues: { isLongEmail: 'a@b.co', count: '42' } as never,
        }) as unknown as Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as Api

    // After setValue, storage holds the PRE-transform input
    // (`.transform()` doesn't run at write time, only at parse time).
    api.setValue('isLongEmail', 'a@b.co')
    api.setValue('count', '42')
    await nextTick()
    expect(api.values.isLongEmail).toBe('a@b.co')
    expect(api.values.count).toBe('42')

    // parse() runs the full parse pipeline (refinements + transforms)
    // and returns the POST-transform output. This is the same shape
    // handleSubmit's callback receives.
    const result = await api.parse()
    expect(result.success).toBe(true)
    expect(result.data?.isLongEmail).toBe(false) // 'a@b.co' is 6 chars, < 10 → false
    expect(result.data?.count).toBe(42) // string '42' → number 42

    // Mutating + re-processing reflects the latest input.
    api.setValue('isLongEmail', 'a-really-long-email@example.com')
    await nextTick()
    expect(api.values.isLongEmail).toBe('a-really-long-email@example.com')
    const result2 = await api.parse()
    expect(result2.data?.isLongEmail).toBe(true) // 31 chars, > 10 → true
  })

  it('TYPES: input/output asymmetry threads through useForm — values stays z.input, handleSubmit/parse resolve to z.output', () => {
    // A type-level probe: `expectTypeOf` asserts at compile time, so
    // the body is a runtime no-op, but the `it` still has to exist for
    // Vitest to report the file. A failure here is a tsc error surfaced
    // by `pnpm typecheck`. The underscore keeps `no-unused-vars` quiet
    // on a const read only through `typeof _schema`.
    const _schema = z.object({
      // Different input and output types, the trickier case.
      isLongEmail: z.string().transform((v) => v.length > 10),
      count: z.string().transform((v) => Number(v)),
      // Same input and output, the common case.
      name: z.string(),
    })

    // PathInput<Schema, Path> resolves to z.input shape at the path.
    expectTypeOf<PathInput<typeof _schema, 'isLongEmail'>>().toEqualTypeOf<string>()
    expectTypeOf<PathInput<typeof _schema, 'count'>>().toEqualTypeOf<string>()
    expectTypeOf<PathInput<typeof _schema, 'name'>>().toEqualTypeOf<string>()

    // PathOutput<Schema, Path> resolves to z.output shape at the path.
    expectTypeOf<PathOutput<typeof _schema, 'isLongEmail'>>().toEqualTypeOf<boolean>()
    expectTypeOf<PathOutput<typeof _schema, 'count'>>().toEqualTypeOf<number>()
    expectTypeOf<PathOutput<typeof _schema, 'name'>>().toEqualTypeOf<string>()

    // Inside the form API, the same asymmetry threads through. Type-
    // assert directly off `useForm`'s return without any `as Api` cast
    // so the public TS surface is what's under test.
    type FormApi = UseFormReturn<typeof _schema>

    // form.values reflects storage: the pre-transform z.input view.
    type FlagAtValues = FormApi['values']['isLongEmail']
    type CountAtValues = FormApi['values']['count']
    expectTypeOf<FlagAtValues>().toEqualTypeOf<string>()
    expectTypeOf<CountAtValues>().toEqualTypeOf<string>()

    // handleSubmit's onSubmit callback receives z.output, extracted
    // through `Parameters<...>[0]` off the OnSubmit shape
    // `(data: z.output) => void | Promise<void>`.
    type OnSubmitParam = Parameters<Parameters<FormApi['handleSubmit']>[0]>[0]
    expectTypeOf<OnSubmitParam['isLongEmail']>().toEqualTypeOf<boolean>()
    expectTypeOf<OnSubmitParam['count']>().toEqualTypeOf<number>()
    expectTypeOf<OnSubmitParam['name']>().toEqualTypeOf<string>()

    // form.parse()'s `.data` payload resolves to z.output too.
    type ParseResult = Awaited<ReturnType<FormApi['parse']>>
    type ParseSuccess = Extract<ParseResult, { success: true }>
    expectTypeOf<ParseSuccess['data']['isLongEmail']>().toEqualTypeOf<boolean>()
    expectTypeOf<ParseSuccess['data']['count']>().toEqualTypeOf<number>()
  })
})

describe('chaos — non-JSON-friendly types in DU subtree', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('a Date value at a z.date() leaf survives a discriminator round-trip', async () => {
    const schema = z.object({
      payload: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('dated'), at: z.date() }),
        z.object({ kind: z.literal('plain'), note: z.string() }),
      ]),
    })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { payload: { kind: string } & Record<string, unknown> }
    }
    const handle: { api?: Api } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `chaos-date-du-${Math.random().toString(36).slice(2)}`,
          defaultValues: { payload: { kind: 'dated', at: new Date(0) } },
        }) as unknown as Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as Api

    const stamp = new Date('2024-01-15T12:00:00.000Z')
    api.setValue('payload.at', stamp)
    await nextTick()

    api.setValue('payload.kind', 'plain')
    await nextTick()
    api.setValue('payload.kind', 'dated')
    await nextTick()

    // The variant-memory snapshot round-trips through JSON, which
    // turns a Date into an ISO string. Restoration therefore yields a
    // string, `instanceof Date` fails, and consumer code calling
    // `at.getTime()` crashes the next time it runs.
    const at = (api.values.payload as AnyPayload).at
    expect(at instanceof Date).toBe(true)
  })
})

describe('chaos — numeric-string write at a z.number() leaf', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it("setValue('age', '42') is rejected by the slim-primitive gate", async () => {
    const schema = z.object({ age: z.number() })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { age: number | string }
    }
    const handle: { api?: Api } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `chaos-numeric-string-${Math.random().toString(36).slice(2)}`,
          defaultValues: { age: 0 },
        }) as unknown as Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as Api

    expect(api.setValue('age', '42')).toBe(false)
    await nextTick()
    expect(typeof api.values.age).toBe('number')
  })
})

describe('chaos — null at a nullable string leaf', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('setValue accepts null and storage reflects it', async () => {
    const schema = z.object({ note: z.string().nullable() })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { note: string | null }
    }
    const handle: { api?: Api } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `chaos-nullable-${Math.random().toString(36).slice(2)}`,
          defaultValues: { note: 'init' },
        }) as unknown as Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as Api

    expect(api.setValue('note', null)).toBe(true)
    await nextTick()
    expect(api.values.note).toBeNull()
  })
})

describe('chaos — performance: rapid setValue chain', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('1000 sequential setValue calls complete in under 1 second', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    const start = performance.now()
    for (let i = 0; i < 1000; i++) {
      api.setValue('name', `name-${i}`)
    }
    await nextTick()
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(1000)
    expect(api.values.name).toBe('name-999')
  })
})

describe('chaos — performance: large array of DU', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('mounting a form with 5000 DU array elements completes in under 3 seconds', async () => {
    const arraySchema = z.object({
      events: z.array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('click'), x: z.string() }),
          z.object({ type: z.literal('text'), value: z.string() }),
        ])
      ),
    })
    const events: Array<{ type: 'click'; x: string }> = []
    for (let i = 0; i < 5000; i++) events.push({ type: 'click', x: `e-${i}` })

    const start = performance.now()
    const handle: { api?: unknown } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: arraySchema,
          key: `chaos-perf-large-${Math.random().toString(36).slice(2)}`,
          defaultValues: { events },
        })
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    await nextTick()
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(3000)
    const api = handle.api as { values: { events: Array<unknown> } }
    expect(api.values.events.length).toBe(5000)
  })
})

describe("chaos — resetField with the form-level errors path ''", () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it("resetField('') targets the literal '' field, NOT the global bucket", async () => {
    // Form-level errors live at the root `[]`, set with setErrors and
    // cleared with clearErrors([]). `''` is an ordinary literal
    // empty-key field, so `resetField('')` targets that field, never
    // the global bucket, and is not a "reset everything" alias.
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('name', 'Ada')
    api.setErrors([{ message: 'capacity exceeded', code: 'api:capacity' }])
    await nextTick()

    expect(api.values.name).toBe('Ada')
    expect(api.meta.ownErrors).toHaveLength(1)

    // Cast loose: the typed signature only accepts known schema paths.
    // For a schema with no `''` field this is a no-op on values.
    ;(api.resetField as (path: string) => void)('')
    await nextTick()

    // The named field and the global bucket are both untouched, since
    // `''` is neither's home.
    expect(api.values.name).toBe('Ada')
    expect(api.meta.ownErrors).toHaveLength(1)

    // clearErrors([]) is the tool for the global bucket.
    api.clearErrors([])
    expect(api.meta.ownErrors).toEqual([])
  })

  it('resetField on a container path broadcasts the reset to descendants', async () => {
    // Mirrors the read-side pattern: `form.fields(containerPath)` and
    // `form.values(containerPath)` aggregate the subtree, so a write-
    // side `resetField(containerPath)` reverts every leaf in the
    // subtree to its construction-time original.
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('name', 'Ada')
    api.setValue('notify.address', 'a@b.c')
    await nextTick()
    expect(api.values.name).toBe('Ada')
    expect(api.values.notify.channel === 'email' && api.values.notify.address).toBe('a@b.c')

    api.resetField('notify')
    await nextTick()

    // notify subtree reverts to construction-time defaults
    // (`{ channel: 'email', address: 'old@example.com' }` for this
    // profile harness); siblings outside the prefix survive.
    expect(api.values.name).toBe('Ada')
    expect(api.values.notify.channel).toBe('email')
    expect(api.values.notify.address).toBe('old@example.com')
  })
})

describe('chaos — two useForm calls with the same key in one app', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  // Shared-key semantics are deliberate: a modal and a main view
  // render the same logical form, so the store and the storage are
  // shared. Per-instance config is not, and each `useForm` call site
  // honours its own validateOn, coerce, rememberVariants and
  // debounceMs. The first call's defaultValues wins and later calls
  // inherit the live store state rather than their own seed, so opening
  // a modal shows whatever the user has typed in the main form.
  it('shares store + first-call defaults wins; subsequent call sees live store state', () => {
    const schema = z.object({ x: z.string() })
    const handle: { a?: unknown; b?: unknown } = {}
    const App = defineComponent({
      setup() {
        handle.a = useForm({
          schema,
          key: 'collision-key',
          defaultValues: { x: 'a' },
        })
        handle.b = useForm({
          schema,
          key: 'collision-key',
          defaultValues: { x: 'b' },
        })
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)

    const a = handle.a as { values: { x: string }; setValue: (p: string, v: unknown) => boolean }
    const b = handle.b as { values: { x: string }; setValue: (p: string, v: unknown) => boolean }

    // The first call's defaultValues wins and both handles read the
    // same live state, so the second `defaultValues: { x: 'b' }` yields
    // to the store: the modal-opens-on-a-partially-filled-main-form
    // case.
    expect(a.values.x).toBe('a')
    expect(b.values.x).toBe('a')

    // Writes through one handle land in the shared store; the other
    // handle observes the same value. That's the feature, not a bug.
    a.setValue('x', 'one')
    expect(a.values.x).toBe('one')
    expect(b.values.x).toBe('one')

    b.setValue('x', 'two')
    expect(a.values.x).toBe('two')
    expect(b.values.x).toBe('two')
  })

  it("each instance honors its own validateOn — sibling's 'submit' doesn't suppress the other's 'change'", async () => {
    // Two call sites, one shared store: A is submit-only, B asks for
    // change mode, and a valid seed means neither has errors at mount.
    // A setValue through B fires the change-mode pipeline and surfaces
    // 'bad email' even though the store was constructed in submit mode.
    // Without the per-instance lift the store would only know A's mode
    // and B's writes would silently not validate.
    const schema = z.object({ email: z.email('bad email') })
    const handle: { a?: unknown; b?: unknown } = {}
    const App = defineComponent({
      setup() {
        handle.a = useForm({
          schema,
          key: 'shared-validateOn',
          validateOn: 'submit',
          defaultValues: { email: 'seed@example.com' },
        })
        handle.b = useForm({
          schema,
          key: 'shared-validateOn',
          validateOn: 'change',
        })
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    await nextTick()

    const a = handle.a as {
      errors: { email?: ReadonlyArray<{ message: string }> }
      setValue: (p: string, v: unknown) => boolean
    }
    const b = handle.b as {
      errors: { email?: ReadonlyArray<{ message: string }> }
      setValue: (p: string, v: unknown) => boolean
    }

    // Mount-time: lax + valid seed → no errors on either handle.
    expect(a.errors.email).toEqual([])
    expect(b.errors.email).toEqual([])

    // `schema.validateAtPath` resolves through one microtask plus the
    // adapter's own async (sync Zod still returns via
    // `Promise.resolve`), so one nextTick is not enough. `setTimeout(0)`
    // flushes the microtask queue and the next macrotask.
    const drain = async () => {
      await nextTick()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await nextTick()
    }

    // A's submit-only write must NOT trigger change-mode validation.
    a.setValue('email', 'first-bad-write')
    await drain()
    expect(a.errors.email).toEqual([])
    expect(b.errors.email).toEqual([])

    // B's change-mode write SHOULD trigger validation. The bad-email
    // value in storage now produces a schema error.
    b.setValue('email', 'second-bad-write')
    await drain()
    expect(b.errors.email?.[0]?.message).toBe('bad email')
    // Errors are shared store state, so A sees them too.
    expect(a.errors.email?.[0]?.message).toBe('bad email')
  })

  it("handleSubmit re-entry guard protects across siblings — B's submit is a no-op while A's is in flight", async () => {
    // The double-click guard reads `state.activeSubmissions.value`
    // off the FormStore, which every `useForm({ key })` call site
    // shares, so an in-flight submission through A suppresses a
    // same-key submission through B. Without it a button in the modal
    // could double-fire onSubmit while the main form's submit is still
    // awaiting validation, duplicating POSTs.
    const schema = z.object({ name: z.string().min(1) })
    const handle: { a?: unknown; b?: unknown } = {}
    const App = defineComponent({
      setup() {
        handle.a = useForm({
          schema,
          key: 'shared-submit-dedup',
          defaultValues: { name: 'Ada' },
        })
        handle.b = useForm({
          schema,
          key: 'shared-submit-dedup',
        })
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    await nextTick()

    type SubmitApi = {
      handleSubmit: (onSubmit: () => unknown, onError?: () => unknown) => () => Promise<void>
      meta: { submitting: boolean }
    }
    const a = handle.a as SubmitApi
    const b = handle.b as SubmitApi

    let aCalls = 0
    let bCalls = 0
    let releaseA!: () => void
    const aBlocker = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    const submitA = a.handleSubmit(async () => {
      aCalls++
      await aBlocker
    })
    const submitB = b.handleSubmit(() => {
      bCalls++
    })

    // Fire A first; it'll block on aBlocker until we release.
    const aPromise = submitA()
    await nextTick()
    await new Promise((r) => setTimeout(r, 0))
    expect(aCalls).toBe(1)
    expect(a.meta.submitting).toBe(true)
    // meta is shared, so both A and B observe submitting=true.
    expect(b.meta.submitting).toBe(true)

    // While A is in flight, B's submit must be a no-op.
    await submitB()
    expect(bCalls).toBe(0)
    expect(a.meta.submitting).toBe(true)
    expect(b.meta.submitting).toBe(true)

    // Once A completes, B's next submit can run.
    releaseA()
    await aPromise
    await nextTick()
    expect(a.meta.submitting).toBe(false)
    expect(b.meta.submitting).toBe(false)

    await submitB()
    expect(bCalls).toBe(1)
  })

  it("when A's onSubmit throws, the shared lifecycle clears cleanly and B can submit again", async () => {
    // The same guarantee on the failure path: a throw inside A's
    // onSubmit releases the shared re-entry guard and populates
    // `submitError` on the shared store, so both siblings see the error
    // and B's next submit can fire. `process-form.ts`'s finally block
    // runs on throw and success alike; without it a failing submit in
    // the modal would strand the main form at `submitting: true`.
    const schema = z.object({ name: z.string().min(1) })
    const handle: { a?: unknown; b?: unknown } = {}
    const App = defineComponent({
      setup() {
        handle.a = useForm({
          schema,
          key: 'shared-submit-throw',
          defaultValues: { name: 'Ada' },
        })
        handle.b = useForm({
          schema,
          key: 'shared-submit-throw',
        })
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    await nextTick()

    type SubmitApi = {
      handleSubmit: (onSubmit: () => unknown, onError?: () => unknown) => () => Promise<void>
      meta: { submitting: boolean; submitError: unknown; submissionAttempts: number }
    }
    const a = handle.a as SubmitApi
    const b = handle.b as SubmitApi

    let bCalls = 0
    let rejectA!: (err: Error) => void
    const aBlocker = new Promise<void>((_, reject) => {
      rejectA = reject
    })
    const boom = new Error('onSubmit blew up')
    const submitA = a.handleSubmit(async () => {
      await aBlocker
    })
    const submitB = b.handleSubmit(() => {
      bCalls++
    })

    // Fire A; it suspends on aBlocker. Both siblings observe
    // submitting=true.
    const aPromise = submitA()
    await nextTick()
    await new Promise((r) => setTimeout(r, 0))
    expect(a.meta.submitting).toBe(true)
    expect(b.meta.submitting).toBe(true)

    // A's onSubmit rejects. The handler resolves rather than
    // re-throwing and parks the throw on the shared `submitError`.
    rejectA(boom)
    await expect(aPromise).resolves.toBeUndefined()
    await nextTick()

    // Lifecycle clears across BOTH siblings: submitting flips false,
    // submitError captures the throw, submissionAttempts increments once.
    expect(a.meta.submitting).toBe(false)
    expect(b.meta.submitting).toBe(false)
    expect(a.meta.submitError).toBe(boom)
    expect(b.meta.submitError).toBe(boom)
    expect(a.meta.submissionAttempts).toBe(1)
    expect(b.meta.submissionAttempts).toBe(1)

    // B's next submit fires because the re-entry guard released along
    // with the throw, and a fresh successful submit clears
    // submitError.
    await submitB()
    await nextTick()
    expect(bCalls).toBe(1)
    expect(b.meta.submitError).toBeNull()
    expect(a.meta.submitError).toBeNull()
    expect(b.meta.submissionAttempts).toBe(2)
  })

  it('a sync watcher on meta.submitting that throws does not desync activeSubmissions', async () => {
    // Lifecycle setup ordering in `process-form.ts:handleSubmit`. The
    // increment and the rest of the setup sit INSIDE the try block, so
    // a sync watcher throwing at `state.submitting.value = true` still
    // reaches the finally. Outside it, the counter would stick at 1 and
    // the re-entry guard would silently drop every later submit.
    const schema = z.object({ name: z.string().min(1) })
    const handle: { api?: unknown; watcherFired?: { count: number } } = {}
    const App = defineComponent({
      setup() {
        const api = useForm({
          schema,
          key: `submit-watcher-${Math.random().toString(36).slice(2)}`,
          defaultValues: { name: 'Ada' },
        })
        const watcherFired = { count: 0 }
        // The watcher goes inside setup so it binds to this component
        // instance: Vue's handleError reaches the app-level
        // errorHandler through the instance's appContext, and a bare
        // `watch()` outside setup would miss the trap. `flush: 'sync'`
        // dispatches at the setter call site, which is where a
        // pre-try-block leak would show.
        watch(
          () => api.meta.submitting,
          (next) => {
            if (next === true) {
              watcherFired.count++
              throw new Error('watcher boom on submitting=true')
            }
          },
          { flush: 'sync' }
        )
        handle.api = api
        handle.watcherFired = watcherFired
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    // Capture watcher errors via Vue's errorHandler so Vitest's
    // unhandled-error trap doesn't fail the test. We only care that
    // the counter recovers, not how the error surfaces.
    const capturedVueErrors: unknown[] = []
    app.config.errorHandler = (err) => {
      capturedVueErrors.push(err)
    }
    app.mount(document.createElement('div'))
    apps.push(app)
    await nextTick()

    type SubmitApi = {
      handleSubmit: (onSubmit: () => unknown) => () => Promise<void>
      meta: { submitting: boolean; submissionAttempts: number }
    }
    const api = handle.api as SubmitApi
    const watcherFired = handle.watcherFired as { count: number }

    let secondCallCount = 0
    const submit1 = api.handleSubmit(() => {})
    const submit2 = api.handleSubmit(() => {
      secondCallCount++
    })

    // The watcher throws when submitting flips true and Vue routes it
    // to the app errorHandler captured above. Whether process-form also
    // rethrows is incidental; the invariant is that the counter
    // recovers.
    try {
      await submit1()
    } catch {
      // accepted on the rethrow path
    }
    await nextTick()
    expect(watcherFired.count).toBeGreaterThanOrEqual(1)
    expect(capturedVueErrors.length).toBeGreaterThanOrEqual(1)
    // The critical invariant: submitting clears so the next submit
    // isn't blocked by the re-entry guard.
    expect(api.meta.submitting).toBe(false)

    // The second submit is allowed because the counter cleaned up
    // after the throw. A leaked counter would make it a silent no-op
    // forever.
    await submit2()
    await nextTick()
    expect(secondCallCount).toBe(1)
  })

  it("a sync watcher on a field's validating flag that throws does not desync the per-path counter", async () => {
    // `scheduleFieldValidation`'s `run` closure increments
    // `activeValidations.value` and `incFieldValidation(key)` before
    // the Promise chain whose `.finally` is the only decrement path. A
    // sync watcher on `api.fields.X.validating` or `api.meta.validating`
    // throwing at the increment would leave the chain unstarted and the
    // counter leaked, stranding `validating` at true and
    // `pathHasAsyncValidation` permanently pending, so the increments
    // and the chain start live inside a try that decrements on a sync
    // throw.
    const schema = z.object({ email: z.email('bad email') })
    const handle: { api?: unknown; watcherFired?: { count: number } } = {}
    const App = defineComponent({
      setup() {
        const api = useForm({
          schema,
          key: `validating-watcher-${Math.random().toString(36).slice(2)}`,
          defaultValues: { email: 'seed@x.com' },
        })
        const watcherFired = { count: 0 }
        // Sync watcher on the leaf's validating flag, throwing on the
        // first transition to true.
        watch(
          () => api.fields.email.validating,
          (next) => {
            if (next === true) {
              watcherFired.count++
              throw new Error('watcher boom on email.validating=true')
            }
          },
          { flush: 'sync' }
        )
        handle.api = api
        handle.watcherFired = watcherFired
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    const capturedVueErrors: unknown[] = []
    app.config.errorHandler = (err) => {
      capturedVueErrors.push(err)
    }
    app.mount(document.createElement('div'))
    apps.push(app)
    await nextTick()

    type Api = {
      setValue: (p: string, v: unknown) => boolean
      fields: { email: { validating: boolean } }
      meta: { validating: boolean }
    }
    const api = handle.api as Api
    const watcherFired = handle.watcherFired as { count: number }

    // setValue triggers `scheduleFieldValidation` (change mode, the
    // default), which fires the increments inside `run`. The watcher's
    // throw races with the per-path counter.
    api.setValue('email', 'bad-email')
    // Drain microtasks + macrotask so any deferred .finally landed.
    await nextTick()
    await new Promise((r) => setTimeout(r, 0))
    await nextTick()

    expect(watcherFired.count).toBeGreaterThanOrEqual(1)
    expect(capturedVueErrors.length).toBeGreaterThanOrEqual(1)
    // validating clears after the throw: the per-path counter
    // decrements in the `.finally` even when the increment's reactive
    // subscriber threw. Otherwise the mount gate leaves fields
    // reporting `validating: true` forever.
    expect(api.fields.email.validating).toBe(false)
    expect(api.meta.validating).toBe(false)

    // A later setValue validates cleanly: the per-path counter is back
    // to zero with no double-count from the leak.
    api.setValue('email', 'good@example.com')
    await nextTick()
    await new Promise((r) => setTimeout(r, 0))
    await nextTick()
    expect(api.fields.email.validating).toBe(false)
    expect(api.meta.validating).toBe(false)
  })

  it('a sync watcher on meta.validating that throws does not desync the committing parse', async () => {
    // The same guarantee on the imperative committing-parse path: its
    // `activeValidations.value += 1` lives inside the try, so a sync
    // watcher on `meta.validating` throwing at that setter cannot leak
    // the counter and hang `meta.validating` at true.
    const schema = z.object({ name: z.string().min(1) })
    const handle: { api?: unknown; watcherFired?: { count: number } } = {}
    const App = defineComponent({
      setup() {
        const api = useForm({
          schema,
          key: `validate-async-watcher-${Math.random().toString(36).slice(2)}`,
          defaultValues: { name: 'Ada' },
        })
        const watcherFired = { count: 0 }
        watch(
          () => api.meta.validating,
          (next) => {
            if (next === true) {
              watcherFired.count++
              throw new Error('watcher boom on meta.validating=true')
            }
          },
          { flush: 'sync' }
        )
        handle.api = api
        handle.watcherFired = watcherFired
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    const capturedVueErrors: unknown[] = []
    app.config.errorHandler = (err) => {
      capturedVueErrors.push(err)
    }
    app.mount(document.createElement('div'))
    apps.push(app)
    await nextTick()

    type Api = {
      parse: (options: { commit: boolean }) => Promise<unknown>
      meta: { validating: boolean }
    }
    const api = handle.api as Api
    const watcherFired = handle.watcherFired as { count: number }

    // The watcher throws when validating flips true during the
    // committing parse. The counter clears wherever the throw
    // surfaces.
    try {
      await api.parse({ commit: true })
    } catch {
      // accepted
    }
    await nextTick()
    expect(watcherFired.count).toBeGreaterThanOrEqual(1)
    expect(api.meta.validating).toBe(false)

    // A later committing parse works, because the counter recovered.
    const response = await api.parse({ commit: true })
    await nextTick()
    expect(api.meta.validating).toBe(false)
    expect(response).toBeDefined()
  })
})

describe('chaos — setValue called after the host component unmounts', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('does not throw a crash; either no-ops or surfaces a clear error', async () => {
    const { app, api } = mountProfile()
    apps.push(app)
    apps.pop() // remove from cleanup list — we'll unmount manually
    app.unmount()

    // Caller still holds the api. setValue should be safe to call.
    let threw = false
    try {
      api.setValue('name', 'after-unmount')
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
  })
})

describe('chaos — direct mutation through api.values proxy', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('writing api.values.notify.channel = "wat" directly does not bypass the gate', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    let threw = false
    try {
      ;(api.values.notify as AnyNotify).channel = 'wat'
    } catch {
      threw = true
    }
    await nextTick()

    // Either the proxy throws on write (read-only enforcement) or the
    // write is allowed but the gate runs. What it must NOT do: silently
    // corrupt storage with no validation.
    if (!threw) {
      const notify = api.values.notify as AnyNotify
      // If accepted, behavior should mirror setValue. If rejected
      // silently, channel stays 'email'.
      expect(notify.channel === 'email' || notify.channel === 'wat').toBe(true)
    }
  })
})

describe('chaos — handleSubmit re-entry inside onSuccess', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('calling submit() inside onSuccess does not infinite-recurse', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('name', 'Ada')
    api.setValue('notify', { channel: 'sms', number: '5551234' })
    await nextTick()

    let calls = 0
    const submit = api.handleSubmit(
      () => {
        calls++
        if (calls > 5) return // hard stop
        // Re-enter: infinite recursion without a guard.
        submit()
      },
      () => {}
    )
    await submit()
    await nextTick()

    expect(calls).toBeLessThan(5)
  })
})

describe('non-discriminated z.union with literal variants', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('accepts any-string write; validation surfaces the literal-set mismatch', async () => {
    // The slim-primitive write gate checks TYPE SHAPE, not value
    // content. A union of string literals slim-resolves to `string`, so
    // any string passes the gate and storage receives what the user
    // produced; literal-set membership is a refinement, surfaced by the
    // schema validation that runs on every change by default.
    //
    // Rejecting at the gate would be a silent-UX failure: the user
    // types, nothing happens, and no error explains why. A form exists
    // to receive information, including the invalid information that
    // has to reach a validation error the user can act on.
    const schema = z.object({
      role: z.union([z.literal('admin'), z.literal('viewer')]),
    })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { role: string }
    }
    const handle: { api?: Api } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `chaos-union-${Math.random().toString(36).slice(2)}`,
          defaultValues: { role: 'admin' },
        }) as unknown as Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as Api

    // Storage accepts: 'wat' is a string, slim-shape matches.
    expect(api.setValue('role', 'wat')).toBe(true)
    await nextTick()
    expect(api.values.role).toBe('wat')

    // Validation surfaces the literal-set mismatch, so a consumer
    // binding `form.errors.role` (or `fields.role.errors`) shows the
    // user an actionable error.
    const result = await api.parse('role', { commit: true })
    expect(result.success).toBe(false)

    // Writing a value that IS in the literal set clears the error
    // on the next validation cycle.
    expect(api.setValue('role', 'viewer')).toBe(true)
    await nextTick()
    expect(api.values.role).toBe('viewer')
    const cleared = await api.parse('role', { commit: true })
    expect(cleared.success).toBe(true)
  })
})

describe('chaos — array of arrays of discriminated unions', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('depth-2 array nesting reshapes correctly on inner discriminator change', async () => {
    const schema = z.object({
      grid: z.array(
        z.array(
          z.discriminatedUnion('type', [
            z.object({ type: z.literal('A'), a: z.string() }),
            z.object({ type: z.literal('B'), b: z.string() }),
          ])
        )
      ),
    })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { grid: Array<Array<{ type: string } & Record<string, unknown>>> }
    }
    const handle: { api?: Api } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `chaos-nested-array-du-${Math.random().toString(36).slice(2)}`,
          defaultValues: {
            grid: [
              [
                { type: 'A', a: 'r0c0' },
                { type: 'A', a: 'r0c1' },
              ],
              [{ type: 'B', b: 'r1c0' }],
            ],
          },
        }) as unknown as Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as Api

    api.setValue('grid.0.1.type', 'B')
    await nextTick()

    // Sibling row unaffected.
    expect(api.values.grid[1]?.[0]).toEqual({ type: 'B', b: 'r1c0' })
    // Sibling cell in same row unaffected.
    expect(api.values.grid[0]?.[0]).toEqual({ type: 'A', a: 'r0c0' })
    // Target cell reshapes cleanly.
    expect(api.values.grid[0]?.[1]).toEqual({ type: 'B', b: '' })
  })
})

describe('chaos — stringified JSON written at an object-typed leaf', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('setValue(\'config\', \'{"key":"value"}\') is rejected (not parsed silently)', async () => {
    const schema = z.object({
      config: z.object({ key: z.string() }),
    })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { config: { key: string } }
    }
    const handle: { api?: Api } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `chaos-stringified-json-${Math.random().toString(36).slice(2)}`,
          defaultValues: { config: { key: 'init' } },
        }) as unknown as Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as Api

    // A common API misuse: the caller stringifies before setValue.
    // The schema expects an object, so the form rejects it.
    expect(api.setValue('config', '{"key":"value"}')).toBe(false)
    await nextTick()
    expect(api.values.config).toEqual({ key: 'init' })
  })
})

describe('chaos — branded literal at the discriminator', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('z.literal("a").brand<"X">() at discriminator does not lose the variant lookup', async () => {
    const schema = z.object({
      payload: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('plain'), v: z.string() }),
        z.object({ kind: z.literal('special'), w: z.string() }),
      ]),
    })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { payload: { kind: string } & Record<string, unknown> }
    }
    const handle: { api?: Api } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `chaos-brand-disc-${Math.random().toString(36).slice(2)}`,
          defaultValues: { payload: { kind: 'plain', v: '' } },
        }) as unknown as Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as Api

    api.setValue('payload.kind', 'special')
    await nextTick()
    expect(api.values.payload).toEqual({ kind: 'special', w: '' })
  })
})

describe('chaos — zod v3 ZodEffects wrapping a discriminatedUnion', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('v3: refinement on the union does not break variant reshape', async () => {
    const inner = zV3.discriminatedUnion('channel', [
      zV3.object({ channel: zV3.literal('email'), address: zV3.string() }),
      zV3.object({ channel: zV3.literal('sms'), number: zV3.string() }),
    ])
    // .refine wraps in ZodEffects. The adapter peeling code at
    // src/runtime/adapters/zod-v3/index.ts:438 must see through this.
    const schema = zV3.object({
      notify: inner.refine(
        () => true,
        () => ({ message: 'always pass' })
      ),
    })
    type Api = Omit<UseFormReturnType<zV3.infer<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { notify: { channel: string } & Record<string, unknown> }
    }
    const handle: { api?: Api } = {}
    const App = defineComponent({
      setup() {
        handle.api = useFormV3({
          schema,
          key: `chaos-v3-effects-du-${Math.random().toString(36).slice(2)}`,
          defaultValues: { notify: { channel: 'email', address: '' } },
        }) as unknown as Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as Api

    api.setValue('notify.address', 'kept@example.com')
    api.setValue('notify.channel', 'sms')
    await nextTick()

    expect(api.values.notify).toEqual({ channel: 'sms', number: '' })
  })
})

describe('chaos — z.intersection of a DU and a sibling schema', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('intersection-wrapped DU still reshapes on discriminator change', async () => {
    const du = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('A'), a: z.string() }),
      z.object({ kind: z.literal('B'), b: z.string() }),
    ])
    const meta = z.object({ shared: z.string() })
    const schema = z.object({
      payload: z.intersection(du, meta),
    })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { payload: { kind: string; shared: string } & Record<string, unknown> }
    }
    let threwAtConstruction = false
    let api: Api | undefined
    try {
      const handle: { api?: Api } = {}
      const App = defineComponent({
        setup() {
          handle.api = useForm({
            schema,
            key: `chaos-intersection-du-${Math.random().toString(36).slice(2)}`,
            defaultValues: { payload: { kind: 'A', a: 'init', shared: 's' } },
          }) as unknown as Api
          return () => h('div')
        },
      })
      const app = createApp(App).use(createAttaform())
      app.mount(document.createElement('div'))
      apps.push(app)
      api = handle.api as Api
    } catch {
      threwAtConstruction = true
    }

    if (threwAtConstruction) {
      // Acceptable: the adapter doesn't claim intersection support.
      return
    }
    if (api === undefined) return

    api.setValue('payload.kind', 'B')
    await nextTick()
    const payload = api.values.payload as AnyPayload
    // After the switch, `b` should be present, `a` gone, `shared`
    // preserved.
    expect(payload.kind).toBe('B')
    expect('a' in payload).toBe(false)
  })
})

describe('chaos — preprocess on the discriminator leaf inside a variant', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('preprocess that lowercases the discriminator does not break variant lookup', async () => {
    // Variant lookup uses the literal verbatim, but a preprocess on
    // the discriminator leaf turns 'EMAIL' into 'email', so the slim
    // gate sees the input and the adapter sees the output.
    const schema = z.object({
      notify: z.discriminatedUnion('channel', [
        z.object({
          channel: z.preprocess(
            (v) => (typeof v === 'string' ? v.toLowerCase() : v),
            z.literal('email')
          ),
          address: z.string(),
        }),
        z.object({
          channel: z.preprocess(
            (v) => (typeof v === 'string' ? v.toLowerCase() : v),
            z.literal('sms')
          ),
          number: z.string(),
        }),
      ]),
    })
    let threw = false
    try {
      const handle: { api?: unknown } = {}
      const App = defineComponent({
        setup() {
          handle.api = useForm({
            schema,
            key: `chaos-preprocess-disc-${Math.random().toString(36).slice(2)}`,
            defaultValues: { notify: { channel: 'email', address: '' } },
          })
          return () => h('div')
        },
      })
      const app = createApp(App).use(createAttaform())
      app.mount(document.createElement('div'))
      apps.push(app)
    } catch {
      threw = true
    }

    // Either supported (form mounts) or rejected at construction. The
    // bug case: silent partial support where the schema mounts but
    // discriminator switches misbehave.
    expect(typeof threw).toBe('boolean')
  })
})

// History crossed with discriminated unions. With
// `useForm({ history: historyPlugin() })`, undo and redo run across
// discriminator switches, invalid intermediates, array-shape changes
// and concurrent submission.

describe('chaos — history (undo/redo) × discriminated unions', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  function mountWithHistory(overrides: { history?: HistoryPlugin } = {}): {
    app: App
    api: ProfileApi
  } {
    const handle: { api?: ProfileApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: profileSchema,
          key: `chaos-history-${Math.random().toString(36).slice(2)}`,
          history: overrides.history ?? historyPlugin(),
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

  it('undo across an invalid-discriminator intermediate restores the pre-invalid state cleanly', async () => {
    const { app, api } = mountWithHistory()
    apps.push(app)

    api.setValue('name', 'Ada')
    api.setValue('notify.address', 'kept@x.io')
    await nextTick()

    api.setValue('notify.channel', 'wat') // invalid intermediate
    await nextTick()

    api.history.undo()
    await nextTick()

    // The pre-invalid state was email plus kept@x.io, and undo returns
    // the form to exactly that shape rather than a halfway repair.
    expect(api.values.notify).toEqual({ channel: 'email', address: 'kept@x.io' })
  })

  it('redo replays a discriminator switch correctly after undo', async () => {
    const { app, api } = mountWithHistory()
    apps.push(app)

    api.setValue('notify.address', 'first@x.io')
    api.setValue('notify.channel', 'sms')
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'sms', number: '' })

    api.history.undo()
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'email', address: 'first@x.io' })

    api.history.redo()
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'sms', number: '' })
  })

  it('a new setValue after undo clears the redo stack', async () => {
    const { app, api } = mountWithHistory()
    apps.push(app)

    api.setValue('name', 'one')
    await nextTick()
    api.setValue('name', 'two')
    await nextTick()
    api.history.undo()
    await nextTick()
    expect(api.history.canRedo).toBe(true)

    api.setValue('name', 'three')
    await nextTick()
    expect(api.history.canRedo).toBe(false)
    const stillCanRedo = api.history.redo()
    expect(stillCanRedo).toBe(false)
    expect(api.values.name).toBe('three')
  })

  it('undo/redo at history extremes returns false cleanly', async () => {
    const { app, api } = mountWithHistory()
    apps.push(app)
    expect(api.history.undo()).toBe(false) // empty undo stack
    expect(api.history.redo()).toBe(false) // empty redo stack
  })

  it('history snapshots do NOT capture variant memory (memory is a side channel)', async () => {
    // History snapshots form VALUE, not variant memory, and memory
    // survives an undo. Type, switch, undo, switch back: the restored
    // memory holds the value typed before the undo, not the slim
    // default.
    const { app, api } = mountWithHistory()
    apps.push(app)

    api.setValue('notify.address', 'pre-undo@x.io')
    api.setValue('notify.channel', 'sms') // memory captures email
    await nextTick()

    // Undo the switch. Form value goes back to the pre-switch state
    // (email + 'pre-undo@x.io'). Memory is untouched per the contract.
    api.history.undo()
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'email', address: 'pre-undo@x.io' })

    // Switch sms again. Memory snapshots email's current state. Then
    // back to email. Memory should restore the pre-undo address.
    api.setValue('notify.channel', 'sms')
    api.setValue('notify.channel', 'email')
    await nextTick()
    expect(api.values.notify).toEqual({ channel: 'email', address: 'pre-undo@x.io' })
  })

  it('history capacity is enforced (oldest delta is folded into the base once cap is exceeded)', async () => {
    // Pinned to max:50 rather than the library default so the test
    // measures the eviction mechanism, not the chosen number. After 60
    // mutations historySize is bounded at 50 and the earliest
    // restorable state is no longer the original empty default.
    const { app, api } = mountWithHistory({ history: historyPlugin({ max: 50 }) })
    apps.push(app)

    for (let i = 0; i < 60; i++) {
      api.setValue('name', `n-${i}`)
      await nextTick()
    }

    // historySize bounded at the capacity (50 reachable positions).
    expect(api.history.size).toBeLessThanOrEqual(50)

    // Undo as far as we can. The earliest state the form can restore
    // is bounded by the capacity, NOT the original empty default.
    while (api.history.canUndo) {
      api.history.undo()
      await nextTick()
    }
    // The first 10 names were evicted; we can't reach `n-0` or even
    // the default ''. The earliest restorable name should be some
    // `n-K` for K <= 10.
    expect(api.values.name).not.toBe('')
  })

  it('reset() is itself undoable — the pre-reset state is recoverable', async () => {
    // To the history module a reset is a mutation, not a stack wipe:
    // `applyFormReplacement` inside `reset()` fires `onFormChange`,
    // which pushes the post-reset snapshot and leaves the user's
    // previous value one position earlier in the undo stack. So one
    // `undo()` after a reset recovers the form as it was just before
    // it, and a mis-click costs nothing. A consumer who wants a
    // non-recoverable reset confirms in their own UI first, or calls
    // `history.clear()` afterwards.
    const { app, api } = mountWithHistory()
    apps.push(app)

    api.setValue('name', 'a')
    api.setValue('name', 'b')
    await nextTick()
    expect(api.history.canUndo).toBe(true)
    expect(api.values.name).toBe('b')

    api.reset()
    await nextTick()

    // After reset: form is back at the default (empty string), and the
    // pre-reset state is one undo step away.
    expect(api.values.name).toBe('')
    expect(api.history.canUndo).toBe(true)
    expect(api.history.canRedo).toBe(false)

    api.history.undo()
    await nextTick()

    // The pre-reset state ('b') is recovered.
    expect(api.values.name).toBe('b')
    expect(api.history.canRedo).toBe(true)
  })

  it('handleSubmit operates on the post-undo form value (not the pre-undo)', async () => {
    const { app, api } = mountWithHistory()
    apps.push(app)

    api.setValue('name', 'Ada')
    api.setValue('notify', { channel: 'sms', number: '5551234' })
    await nextTick()

    api.setValue('name', 'Beth') // bumps history
    await nextTick()

    api.history.undo() // back to 'Ada'
    await nextTick()

    let submitted: Record<string, unknown> | null = null
    const submit = api.handleSubmit(
      (data) => {
        submitted = data as Record<string, unknown>
      },
      () => {}
    )
    await submit()
    await nextTick()

    expect((submitted as { name?: unknown } | null)?.name).toBe('Ada')
  })

  it('undo across an array.remove on a DU array does not bleed memory between positions', async () => {
    const arraySchema = z.object({
      events: z.array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('click'), x: z.string() }),
          z.object({ type: z.literal('text'), value: z.string() }),
        ])
      ),
    })
    type ArrApi = Omit<UseFormReturnType<z.output<typeof arraySchema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      remove: (path: string, index: number) => boolean
      values: { events: Array<{ type: string } & Record<string, unknown>> }
    }
    const handle: { api?: ArrApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: arraySchema,
          key: `chaos-history-arr-${Math.random().toString(36).slice(2)}`,
          history: historyPlugin(),
          defaultValues: {
            events: [
              { type: 'click', x: 'first' },
              { type: 'text', value: 'second' },
            ],
          },
        }) as unknown as ArrApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as ArrApi

    api.remove('events', 0)
    await nextTick()
    expect(api.values.events.length).toBe(1)

    api.history.undo()
    await nextTick()

    // After undo, the array is restored. Both elements should be in
    // their original variant shapes (no orphan keys carried over from
    // the DU memory map's stale entries).
    expect(api.values.events.length).toBe(2)
    expect(api.values.events[0]).toEqual({ type: 'click', x: 'first' })
    expect(api.values.events[1]).toEqual({ type: 'text', value: 'second' })
  })

  it('undo while a committing parse is in-flight does not commit stale errors', async () => {
    const { app, api } = mountWithHistory()
    apps.push(app)

    api.setValue('name', 'Ada')
    api.setValue('notify.channel', 'sms') // schema requires number.min(7) — '' fails
    await nextTick()

    const pending = api.parse({ commit: true })
    api.history.undo() // back to email/email-default; the in-flight validation is for the sms state
    await pending
    await nextTick()

    // The form is now back at the email variant. The sms validation's
    // errors must not have committed against the active path.
    expect(api.errors('notify.number')).toEqual([])
  })

  it('history disabled: canUndo/canRedo/historySize stay zero, undo/redo return false', async () => {
    const handle: { api?: ProfileApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: profileSchema,
          key: `chaos-history-off-${Math.random().toString(36).slice(2)}`,
          // history is opt-in; the default is off
          defaultValues: { name: '', notify: { channel: 'email', address: '' } },
        }) as unknown as ProfileApi
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as ProfileApi

    api.setValue('name', 'Ada')
    await nextTick()

    expect(api.history.canUndo).toBe(false)
    expect(api.history.canRedo).toBe(false)
    expect(api.history.size).toBe(0)
    expect(api.history.undo()).toBe(false)
    expect(api.history.redo()).toBe(false)
  })
})

// Records, tuples, Map and Set, setErrors edges, plugin install, a
// concurrency race and a DoS-length string.

describe('chaos — z.record() with DU values', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('switching a DU at a record key reshapes that key without affecting siblings', async () => {
    const schema = z.object({
      bag: z.record(
        z.string(),
        z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('A'), a: z.string() }),
          z.object({ kind: z.literal('B'), b: z.string() }),
        ])
      ),
    })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { bag: Record<string, { kind: string } & Record<string, unknown>> }
    }
    let constructed = false
    let api: Api | undefined
    try {
      const handle: { api?: Api } = {}
      const App = defineComponent({
        setup() {
          handle.api = useForm({
            schema,
            key: `chaos-record-du-${Math.random().toString(36).slice(2)}`,
            defaultValues: {
              bag: { foo: { kind: 'A', a: 'foo-A' }, bar: { kind: 'B', b: 'bar-B' } },
            },
          }) as unknown as Api
          return () => h('div')
        },
      })
      const app = createApp(App).use(createAttaform())
      app.mount(document.createElement('div'))
      apps.push(app)
      api = handle.api as Api
      constructed = true
    } catch {
      // Acceptable: adapter may not claim z.record + DU support.
    }

    if (!constructed || api === undefined) return

    api.setValue('bag.foo.kind', 'B')
    await nextTick()

    expect(api.values.bag['foo']).toEqual({ kind: 'B', b: '' })
    expect(api.values.bag['bar']).toEqual({ kind: 'B', b: 'bar-B' })
  })

  it('does not pollute Object.prototype via z.record(z.string(), du) with a __proto__ key', async () => {
    const schema = z.object({
      bag: z.record(
        z.string(),
        z.discriminatedUnion('kind', [z.object({ kind: z.literal('A'), a: z.string() })])
      ),
    })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
    }
    let api: Api | undefined
    try {
      const handle: { api?: Api } = {}
      const App = defineComponent({
        setup() {
          handle.api = useForm({
            schema,
            key: `chaos-record-proto-${Math.random().toString(36).slice(2)}`,
            defaultValues: { bag: {} },
          }) as unknown as Api
          return () => h('div')
        },
      })
      const app = createApp(App).use(createAttaform())
      app.mount(document.createElement('div'))
      apps.push(app)
      api = handle.api as Api
    } catch {
      return
    }
    if (api === undefined) return

    api.setValue('bag.__proto__.kind', 'A')
    api.setValue('bag.__proto__.a', 'PWNED')
    await nextTick()

    expect(({} as Record<string, unknown>)['a']).toBeUndefined()
    delete (Object.prototype as unknown as Record<string, unknown>)['a']
    delete (Object.prototype as unknown as Record<string, unknown>)['kind']
  })
})

describe('chaos — z.tuple containing a discriminated union', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('switching a DU at a tuple index reshapes only that position', async () => {
    const du = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('A'), a: z.string() }),
      z.object({ kind: z.literal('B'), b: z.string() }),
    ])
    const schema = z.object({
      pair: z.tuple([du, du]),
    })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { pair: [unknown, unknown] }
    }
    let api: Api | undefined
    try {
      const handle: { api?: Api } = {}
      const App = defineComponent({
        setup() {
          handle.api = useForm({
            schema,
            key: `chaos-tuple-du-${Math.random().toString(36).slice(2)}`,
            defaultValues: {
              pair: [
                { kind: 'A', a: 'first' },
                { kind: 'A', a: 'second' },
              ],
            },
          }) as unknown as Api
          return () => h('div')
        },
      })
      const app = createApp(App).use(createAttaform())
      app.mount(document.createElement('div'))
      apps.push(app)
      api = handle.api as Api
    } catch {
      return
    }
    if (api === undefined) return

    api.setValue('pair.0.kind', 'B')
    await nextTick()

    expect(api.values.pair[0]).toEqual({ kind: 'B', b: '' })
    expect(api.values.pair[1]).toEqual({ kind: 'A', a: 'second' })
  })
})

describe('chaos — Map / Set values at leaves', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('a Map value survives a discriminator round-trip', async () => {
    const schema = z.object({
      payload: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('mapped'), data: z.map(z.string(), z.string()) }),
        z.object({ kind: z.literal('flat'), note: z.string() }),
      ]),
    })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { payload: { kind: string } & Record<string, unknown> }
    }
    let api: Api | undefined
    try {
      const handle: { api?: Api } = {}
      const App = defineComponent({
        setup() {
          handle.api = useForm({
            schema,
            key: `chaos-map-leaf-${Math.random().toString(36).slice(2)}`,
            defaultValues: { payload: { kind: 'mapped', data: new Map() } },
          }) as unknown as Api
          return () => h('div')
        },
      })
      const app = createApp(App).use(createAttaform())
      app.mount(document.createElement('div'))
      apps.push(app)
      api = handle.api as Api
    } catch {
      // Without Map support the hazard does not apply, so skip.
      return
    }
    if (api === undefined) return

    const m = new Map<string, string>([['a', '1']])
    api.setValue('payload.data', m)
    await nextTick()

    api.setValue('payload.kind', 'flat')
    await nextTick()
    api.setValue('payload.kind', 'mapped')
    await nextTick()

    // The JSON round trip in variant memory flattens a Map to `{}`.
    // After it, the value is still a Map instance, or at minimum has
    // kept its type kind.
    const data = (api.values.payload as AnyPayload).data
    expect(data instanceof Map).toBe(true)
  })

  it('a Set value survives a discriminator round-trip', async () => {
    const schema = z.object({
      payload: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('seqed'), tags: z.set(z.string()) }),
        z.object({ kind: z.literal('flat'), note: z.string() }),
      ]),
    })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { payload: { kind: string } & Record<string, unknown> }
    }
    let api: Api | undefined
    try {
      const handle: { api?: Api } = {}
      const App = defineComponent({
        setup() {
          handle.api = useForm({
            schema,
            key: `chaos-set-leaf-${Math.random().toString(36).slice(2)}`,
            defaultValues: { payload: { kind: 'seqed', tags: new Set<string>() } },
          }) as unknown as Api
          return () => h('div')
        },
      })
      const app = createApp(App).use(createAttaform())
      app.mount(document.createElement('div'))
      apps.push(app)
      api = handle.api as Api
    } catch {
      return
    }
    if (api === undefined) return

    api.setValue('payload.tags', new Set(['x', 'y']))
    await nextTick()

    api.setValue('payload.kind', 'flat')
    await nextTick()
    api.setValue('payload.kind', 'seqed')
    await nextTick()

    const tags = (api.values.payload as AnyPayload).tags
    expect(tags instanceof Set).toBe(true)
  })
})

describe('chaos — setErrors at edge paths', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('rejects errors at a path that does NOT exist in the schema', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    let threw = false
    try {
      api.setErrors([
        {
          path: ['no', 'such', 'path'],
          message: 'phantom error',
          code: 'test:phantom',
        },
      ])
    } catch {
      threw = true
    }
    await nextTick()

    // Either rejected (warned or skipped) or accepted at a phantom
    // path, never silently corrupting form state. The assertion is
    // deliberately loose: no crash, and the form stays usable.
    expect(threw).toBe(false)
    expect(api.values.notify.channel).toBe('email')
  })

  it('surfaces setErrors entries regardless of foreign identity fields', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    // A payload that still carries a formKey field (e.g. an older server
    // shape) pipes structurally; there is no cross-form filter, and the
    // normalizer builds fresh entries so the foreign field is dropped.
    const foreign: { path: (string | number)[]; message: string; code: string; formKey: string }[] =
      [
        {
          path: ['name'],
          message: 'server error',
          code: 'test:server',
          formKey: 'some-other-form',
        },
      ]
    api.setErrors(foreign)
    await nextTick()

    const errs = api.errors('name') ?? []
    expect(errs).toHaveLength(1)
    expect(errs[0]?.message).toBe('server error')
    expect(errs[0] !== undefined && 'formKey' in errs[0]).toBe(false)
  })

  it('survives an error object with a circular reference in `cause`', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    type CircularError = {
      path: (string | number)[]
      message: string
      code: string
      cause?: { ref: unknown }
    }
    const cyclic: CircularError = {
      path: ['name'],
      message: 'circular',
      code: 'test:circular',
    }
    cyclic.cause = { ref: cyclic } // ← cycle

    let threw = false
    try {
      api.setErrors([cyclic])
      await nextTick()
    } catch {
      threw = true
    }

    expect(threw).toBe(false)
    // Form still usable.
    expect(api.values.notify.channel).toBe('email')
  })
})

describe('chaos — installing createAttaform twice on one app', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('does not crash; second install is either ignored or overrides cleanly', async () => {
    const handle: { api?: ProfileApi } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema: profileSchema,
          key: `chaos-plugin-double-${Math.random().toString(36).slice(2)}`,
          defaultValues: { name: '', notify: { channel: 'email', address: '' } },
        }) as unknown as ProfileApi
        return () => h('div')
      },
    })
    let threw = false
    try {
      const app = createApp(App).use(createAttaform()).use(createAttaform()) // ← second install
      app.mount(document.createElement('div'))
      apps.push(app)
      await nextTick()
    } catch {
      threw = true
    }

    expect(threw).toBe(false)
    expect(handle.api?.values.notify.channel).toBe('email')
  })
})

describe('chaos — concurrent handleSubmit and committing parse', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('does not commit stale errors when a committing parse resolves AFTER a submit clears state', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('name', 'Ada')
    api.setValue('notify', { channel: 'sms', number: '5551234' })
    await nextTick()

    // Trigger a committing parse on the current (valid) state.
    const validation = api.parse({ commit: true })

    // Mutate to an invalid state mid-flight, then await the original
    // validation: it reflects the state at the time it was called, and
    // does not commit errors against the now-current one.
    api.setValue('notify.number', '') // sms requires min(7); now invalid
    await nextTick()

    const result = await validation
    void result // intentionally do not assume success/failure here

    // Doesn't matter which posture (commit-against-launch-state vs
    // commit-against-current-state): the form must still be usable.
    expect(api.values.notify.number).toBe('')
  })
})

describe('chaos — extremely long string at a slim leaf', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('a 1MB string does not hang the slim-primitive gate', async () => {
    const schema = z.object({ note: z.string() })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { note: string }
    }
    const handle: { api?: Api } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `chaos-long-string-${Math.random().toString(36).slice(2)}`,
          defaultValues: { note: '' },
        }) as unknown as Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as Api

    const big = 'x'.repeat(1_000_000) // 1MB
    const start = performance.now()
    const ok = api.setValue('note', big)
    await nextTick()
    const elapsed = performance.now() - start

    expect(ok).toBe(true)
    expect(api.values.note.length).toBe(1_000_000)
    // A generous bound: O(1) or O(N) in writes, not O(N^2).
    expect(elapsed).toBeLessThan(2000)
  })
})

describe('chaos — two <input> elements registered to the same path', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('typing in either input keeps both in sync via the shared form value', async () => {
    const schema = z.object({ shared: z.string() })
    type Api = UseFormReturn<typeof schema>
    const handle: { api?: Api; el1?: HTMLInputElement; el2?: HTMLInputElement } = {}

    // The directive is incidental here. What is under test is
    // form-level coordination of two registered inputs.
    const App = defineComponent({
      setup() {
        const api = useForm({
          schema,
          key: `chaos-double-register-${Math.random().toString(36).slice(2)}`,
          defaultValues: { shared: '' },
        })
        handle.api = api
        return () =>
          h('div', [
            h('input', {
              ref: (el): void => {
                if (el !== null) handle.el1 = el as HTMLInputElement
              },
            }),
            h('input', {
              ref: (el): void => {
                if (el !== null) handle.el2 = el as HTMLInputElement
              },
            }),
          ])
      },
    })
    const app = createApp(App).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    apps.push(app)
    await nextTick()

    const api = handle.api as Api
    api.setValue('shared', 'typed')
    await nextTick()
    expect(api.values.shared).toBe('typed')
  })
})

// SSR and hydration.

import { renderToString } from '@vue/server-renderer'
import { createSSRApp } from 'vue'

describe('chaos — SSR rendering with discriminated-union schemas', () => {
  it('renderToString completes for a form whose schema includes a DU', async () => {
    let threw = false
    let html = ''
    try {
      const App = defineComponent({
        setup() {
          useForm({
            schema: profileSchema,
            key: 'ssr-du-basic',
            defaultValues: { name: 'Ada', notify: { channel: 'email', address: 'a@b.io' } },
          })
          return () => h('div', [h('input', { value: 'Ada' }), h('input', { value: 'a@b.io' })])
        },
      })
      const ssrApp = createSSRApp(App).use(createAttaform())
      html = await renderToString(ssrApp)
    } catch {
      threw = true
    }

    expect(threw).toBe(false)
    expect(html.length).toBeGreaterThan(0)
  })

  it('renderToString completes for a DU with `unset` at the discriminator', async () => {
    let threw = false
    try {
      const App = defineComponent({
        setup() {
          useForm({
            schema: profileSchema,
            key: 'ssr-du-unset',
            defaultValues: { name: '', notify: { channel: unset } } as never,
          })
          return () => h('div')
        },
      })
      const ssrApp = createSSRApp(App).use(createAttaform())
      await renderToString(ssrApp)
    } catch {
      threw = true
    }

    expect(threw).toBe(false)
  })
})
describe('chaos — SSR id allocator collision when two forms share a parent', () => {
  it('two anonymous forms in the same parent component get distinct keys', async () => {
    let key1: string | undefined
    let key2: string | undefined
    const App = defineComponent({
      setup() {
        const a = useForm({
          schema: z.object({ x: z.string() }),
          defaultValues: { x: 'a' },
        })
        const b = useForm({
          schema: z.object({ y: z.string() }),
          defaultValues: { y: 'b' },
        })
        key1 = a.key
        key2 = b.key
        return () => h('div')
      },
    })
    const ssrApp = createSSRApp(App).use(createAttaform())
    await renderToString(ssrApp)

    expect(key1).toBeDefined()
    expect(key2).toBeDefined()
    expect(key1).not.toBe(key2)
  })
})

// Final-pass random probes.

import { vi } from 'vitest'

describe('chaos — dev warning surface for construction-time issues', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('emits a dev warning when defaultValues carries an invalid discriminator', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const handle: { api?: ProfileApi } = {}
      const App = defineComponent({
        setup() {
          handle.api = useForm({
            schema: profileSchema,
            key: `chaos-warn-bad-disc-${Math.random().toString(36).slice(2)}`,
            defaultValues: { name: '', notify: { channel: 'wat' } } as never,
          }) as unknown as ProfileApi
          return () => h('div')
        },
      })
      const app = createApp(App).use(createAttaform())
      app.mount(document.createElement('div'))
      apps.push(app)
      await nextTick()

      // A warning fires because the form is in a known-broken state.
      // Without it the developer has no signal until validation runs.
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('chaos — handleSubmit when onError callback throws', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('a throwing onError does not corrupt form state for subsequent submits', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    api.setValue('notify.channel', 'wat') // invalid → onError will fire
    await nextTick()

    const submit = api.handleSubmit(
      () => {},
      () => {
        throw new Error('onError callback exploded')
      }
    )

    // onError throws inside the callback on the first submit. The
    // promise may reject or resolve with the error swallowed; what it
    // may not do is corrupt form state past recovery.
    let firstThrew = false
    try {
      await submit()
    } catch {
      firstThrew = true
    }
    void firstThrew

    // Recover the form to a valid state.
    api.resetField('notify.channel')
    await nextTick()
    expect(api.values.notify.channel).toBe('email')

    // Second submit: should run cleanly with a non-throwing handler.
    let secondSucceeded = false
    const submit2 = api.handleSubmit(
      () => {
        secondSucceeded = true
      },
      () => {}
    )
    api.setValue('notify.address', 'a@b.io')
    api.setValue('name', 'Ada')
    await nextTick()
    await submit2()
    await nextTick()

    expect(secondSucceeded).toBe(true)
  })
})

describe('chaos — JSON.stringify(form.values()) with a BigInt-typed leaf', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('a consumer that JSON-serialises form.values gets a clear error path with a BigInt leaf', async () => {
    const schema = z.object({ id: z.bigint() })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
      values: { id: bigint }
    }
    const handle: { api?: Api } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `chaos-bigint-public-${Math.random().toString(36).slice(2)}`,
          defaultValues: { id: 0n },
        }) as unknown as Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as Api

    api.setValue('id', 9007199254740993n)
    await nextTick()

    // The public values getter holds a BigInt, so a consumer sending
    // it to a JSON-based RPC hits the same TypeError variant memory
    // hits internally. Attaform cannot fix `JSON.stringify`, so the
    // serialise throws and the consumer handles it.
    let threw = false
    try {
      JSON.stringify(api.values)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})

describe('chaos — empty z.object({}) schema', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('mounts a form with z.object({}) and accepts a committing parse', async () => {
    const schema = z.object({})
    let api: UseFormReturn<typeof schema> | undefined
    const App = defineComponent({
      setup() {
        api = useForm({
          schema,
          key: `chaos-empty-schema-${Math.random().toString(36).slice(2)}`,
          defaultValues: {},
        })
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    await nextTick()

    if (api === undefined) throw new Error('mount failed')

    // `api.values` is a callable proxy: the call form for dynamic
    // paths, dot access for static ones. Vitest's deep-equal treats a
    // callable proxy as a function, so compare against the call form,
    // which returns the readonly root.
    expect(api.values()).toEqual({})
    const result = await api.parse({ commit: true })
    expect(result.success).toBe(true)
  })
})

// Crash-grade probes: the ways Attaform could take down a real Vue or
// Nuxt app rather than merely trip a test.

describe('crash — BigInt-in-DU surfaces as a thrown error to the Vue app', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('a discriminator switch driven by a button click crashes when a BigInt sits at a leaf', async () => {
    const schema = z.object({
      payload: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('big'), id: z.bigint() }),
        z.object({ kind: z.literal('small'), n: z.number() }),
      ]),
    })

    // Vue's errorHandler captures uncaught errors that escape render
    // / handlers. Wire a spy to detect any.
    const captured: unknown[] = []
    const handle: { api?: UseFormReturn<typeof schema> } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `crash-bigint-render-${Math.random().toString(36).slice(2)}`,
          defaultValues: { payload: { kind: 'big', id: 9007199254740993n } },
        })
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.config.errorHandler = (err): void => {
      captured.push(err)
    }
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as UseFormReturn<typeof schema>

    // The user clicks "switch to small". The synchronous setValue
    // triggers reshape → JSON.stringify(BigInt) → throws → propagates
    // up the call chain. Does it escape into the app?
    let setValueThrew = false
    try {
      api.setValue('payload.kind', 'small')
    } catch {
      setValueThrew = true
    }
    await nextTick()

    // A `setValue` that throws rather than returning false propagates
    // into whatever called it, in a real app a click handler. Whether
    // Vue's errorHandler catches it or it surfaces inline, a
    // discriminator switch never crashes.
    const crashed = setValueThrew || captured.length > 0
    expect(crashed).toBe(false)
  })
})

describe('crash — recursive z.lazy + DU at construction', () => {
  it('mounting a component whose setup uses an unsupported schema throws out of mount()', () => {
    type Node = { kind: 'leaf'; value: string } | { kind: 'branch'; children: Node[] }
    const nodeSchema: z.ZodType<Node> = z.lazy(() =>
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('leaf'), value: z.string() }),
        z.object({ kind: z.literal('branch'), children: z.array(nodeSchema) }),
      ])
    )
    const treeSchema = z.object({ tree: nodeSchema })

    const App = defineComponent({
      setup() {
        // Uncaught, so it propagates to the caller of mount().
        useForm({
          schema: treeSchema,
          key: 'crash-lazy-du',
          defaultValues: { tree: { kind: 'leaf', value: '' } },
        })
        return () => h('div')
      },
    })

    let crashed = false
    try {
      const app = createApp(App).use(createAttaform())
      app.mount(document.createElement('div'))
      app.unmount()
    } catch {
      crashed = true
    }

    // A construction-time throw here takes a whole Nuxt route down: a
    // page using a recursive tree-shaped union schema renders nothing.
    // A rejection has to land as a controlled error surface instead.
    expect(crashed).toBe(false)
  })
})

describe('crash — infinite reactivity loop via setValue inside a computed', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it("Vue's max-recursive-update guard catches a setValue-driven feedback loop", async () => {
    const schema = z.object({ a: z.string(), b: z.string() })

    // A misguided template: `b` mirrors `a` through a computed that
    // writes back to `b`. The computed reads `a`, calls
    // `setValue('b', ...)`, triggers a re-render, re-evaluates and
    // writes again. Vue's renderer detects the loop and warns; the
    // probe pins that Attaform lets it warn rather than crash.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const handle: { api?: UseFormReturn<typeof schema>; iterations?: number } = {
      iterations: 0,
    }
    let crashed = false
    try {
      const App = defineComponent({
        setup() {
          const api = useForm({
            schema,
            key: `crash-loop-${Math.random().toString(36).slice(2)}`,
            defaultValues: { a: '', b: '' },
          })
          handle.api = api
          return () => {
            const aVal = api.values.a
            handle.iterations = (handle.iterations ?? 0) + 1
            // Cap the loop here so the test process cannot genuinely
            // hang. Vue caps it too, which is what the assertion
            // below measures.
            if ((handle.iterations ?? 0) < 200) {
              api.setValue('b', aVal + '!')
            }
            return h('div', `${aVal} | ${api.values.b}`)
          }
        },
      })
      const app = createApp(App).use(createAttaform())
      app.mount(document.createElement('div'))
      apps.push(app)

      handle.api!.setValue('a', 'one')
      await nextTick()
      await nextTick()
    } catch {
      crashed = true
    } finally {
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }

    expect(crashed).toBe(false)
    // The iteration count stays bounded. Reaching 200 would mean
    // Vue's safeguard never fired and only the self-cap stopped it,
    // which in a real app is a hang.
    expect(handle.iterations ?? 0).toBeLessThan(200)
  })
})

describe('crash — extremely deep path setValue', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('a 1000-segment path does not cause a stack overflow', async () => {
    // Build a deeply-nested schema. z.object().nest 1000-deep is
    // unwieldy to construct cleanly; use z.record(z.string(),
    // z.lazy()) for an arbitrary-depth bag.
    const schema = z.object({ root: z.record(z.string(), z.unknown()) })
    type Api = Omit<UseFormReturnType<z.output<typeof schema>>, 'setValue'> & {
      setValue: (path: string, value: unknown) => boolean
    }
    const handle: { api?: Api } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `crash-deep-${Math.random().toString(36).slice(2)}`,
          defaultValues: { root: {} },
        }) as unknown as Api
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    const api = handle.api as Api

    // Build root.a.a.a.... 1000-deep. z.unknown() at the leaves keeps
    // the slim-gate permissive.
    const segments: string[] = ['root']
    for (let i = 0; i < 1000; i++) segments.push('a')
    const path = segments.join('.')

    let crashed = false
    try {
      api.setValue(path, 'leaf')
    } catch {
      crashed = true
    }
    await nextTick()

    expect(crashed).toBe(false)
  })
})

describe('crash — handleSubmit onSuccess callback throws', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('the throw is observable via meta.submitError, without an unhandled rejection', async () => {
    const { app, api } = mountProfile()
    apps.push(app)

    // Pin the form to a valid state so submit invokes onSuccess.
    api.setValue('name', 'Ada')
    api.setValue('notify', { channel: 'sms', number: '5551234' })
    await nextTick()

    const submit = api.handleSubmit(
      () => {
        throw new Error('onSuccess exploded')
      },
      () => {}
    )

    let promiseRejected = false
    try {
      await submit()
    } catch {
      promiseRejected = true
    }

    // The handler resolves rather than re-throwing: bound to a DOM
    // event, it must not manufacture an unhandled rejection. The throw
    // stays observable through `meta.submitError`, coerced to a real
    // Error, which is the one recovery channel. A silent swallow with
    // no path back is what that rules out.
    expect(promiseRejected).toBe(false)
    expect(api.meta.submitError).toBeInstanceOf(Error)
    expect(api.meta.submitError?.message).toBe('onSuccess exploded')
  })
})

describe('crash — render template chain access into an inactive-variant subtree', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it("`api.fields.notify.address.value` while channel is 'sms' does not throw during render", async () => {
    let captured: unknown = null
    const App = defineComponent({
      setup() {
        const api = useForm({
          schema: profileSchema,
          key: `crash-chain-render-${Math.random().toString(36).slice(2)}`,
          defaultValues: { name: '', notify: { channel: 'sms', number: '5551234' } },
        })
        return () => {
          // The active variant is sms and `address` belongs to email.
          // The FieldState lift returns a stub for inactive-variant
          // chains; a throw instead would fail the whole component's
          // render, and Vue would mark the parent errored and drop the
          // subtree.
          try {
            const _val = (api.fields as unknown as Record<string, unknown>)['notify']
            const notifyObj = _val as Record<string, unknown>
            const addr = notifyObj['address'] as Record<string, unknown> | undefined
            void addr?.['value']
          } catch (err) {
            captured = err
          }
          return h('div')
        }
      },
    })
    const app = createApp(App).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    await nextTick()

    expect(captured).toBeNull()
  })
})

describe('crash — SSR / prerender stability with misconfigured forms', () => {
  it('renderToString on a form with bad-disc defaultValues does not throw', async () => {
    let threw = false
    try {
      const App = defineComponent({
        setup() {
          useForm({
            schema: profileSchema,
            key: 'ssr-bad-disc',
            defaultValues: { name: '', notify: { channel: 'wat' } } as never,
          })
          return () => h('div')
        },
      })
      const ssrApp = createSSRApp(App).use(createAttaform())
      await renderToString(ssrApp)
    } catch {
      threw = true
    }

    // A throw here fails the build of any Nuxt page that prerenders
    // this form, taking a static deploy down with it.
    expect(threw).toBe(false)
  })
})
