// @vitest-environment jsdom
//
// Commit 6 — async register transforms regression battery (plan items 1–9).
//
// `register('path', { transforms })` stays byte-for-byte synchronous until a
// transform returns a thenable; from there the write defers, commits the
// resolved value (latest-request-wins discard), drives the busy/pending
// surfaces, and exposes a no-unhandled-rejection failure channel on
// `field.transformError`. This file pins those guarantees on a standard text
// input across both zod adapters; the three hardest cases (DOM-sync, gated
// display, consumer-override) live in their own files.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, watch, withDirectives, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { vRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import { wait, waitUntil } from '../utils/form-harness'

// A transform whose every call parks on an externally-resolvable promise, so
// a test can force settlement order deterministically (and inspect the value
// each call saw). A bare sync transform returns its value directly instead.
type Settler = {
  readonly input: unknown
  readonly signal: AbortSignal | null
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

function makeSettlerTransform(): {
  transform: (value: unknown, ctx?: { signal: AbortSignal }) => Promise<unknown>
  calls: Settler[]
} {
  const calls: Settler[] = []
  const transform = (value: unknown, ctx?: { signal: AbortSignal }): Promise<unknown> => {
    const entry: Settler = {
      input: value,
      signal: ctx?.signal ?? null,
      resolve: () => {},
      reject: () => {},
    }
    const promise = new Promise<unknown>((resolve, reject) => {
      entry.resolve = resolve
      entry.reject = reject
    })
    calls.push(entry)
    return promise
  }
  return { transform, calls }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUseForm = (opts: any) => any

type Mounted = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: any
  app: App
  input: HTMLInputElement
}

function dispatchInput(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const adapters = [
  { name: 'v4', useForm: useFormV4 as AnyUseForm, z: zV4 },
  { name: 'v3', useForm: useFormV3 as AnyUseForm, z: zV3 as unknown as typeof zV4 },
] as const

describe.each(adapters)('async register transforms — $name', ({ useForm, z }) => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    document.body.innerHTML = ''
  })

  function mount(opts: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schema: any
    transforms: Array<(value: unknown, ctx?: { signal: AbortSignal }) => unknown>
    defaultValues?: Record<string, unknown>
  }): Mounted {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle: { api?: any } = {}
    const Parent = defineComponent({
      setup() {
        const api = useForm({
          schema: opts.schema,
          key: `axf-${Math.random().toString(36).slice(2)}`,
          strict: false,
          ...(opts.defaultValues ? { defaultValues: opts.defaultValues } : {}),
        })
        handle.api = api
        const rv = api.register('field', { transforms: opts.transforms })
        return () =>
          withDirectives(h('input', { type: 'text', 'data-field': 'field' }), [[vRegister, rv]])
      },
    })
    const app = createApp(Parent).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    apps.push(app)
    const input = root.querySelector('[data-field="field"]')
    if (handle.api === undefined || !(input instanceof HTMLInputElement)) {
      throw new Error('mount: api / input never set')
    }
    return { api: handle.api, app, input }
  }

  // ── 1. All-sync chain still commits synchronously ──────────────────────────
  it('an all-sync mixed chain commits in the same tick (no async tax)', () => {
    const { api, input } = mount({
      schema: z.object({ field: z.string() }),
      defaultValues: { field: '' },
      transforms: [(v: unknown) => String(v).trim(), (v: unknown) => String(v).toUpperCase()],
    })
    dispatchInput(input, '  hello  ')
    // Read in the SAME tick — no await. A sync chain must never defer.
    expect(api.values.field).toBe('HELLO')
    expect(api.fields('field').transforming).toBe(false)
    expect(api.fields('field').transformError).toBe(null)
  })

  // ── 2. Out-of-order resolution → latest input wins ─────────────────────────
  it('a superseded slow run cannot clobber the latest result, whatever the settle order', async () => {
    const { transform, calls } = makeSettlerTransform()
    const { api, input } = mount({
      schema: z.object({ field: z.string() }),
      defaultValues: { field: '' },
      transforms: [transform],
    })

    dispatchInput(input, 'slow') // call 0 — the older request
    dispatchInput(input, 'fast') // call 1 — the latest request
    await waitUntil(() => (calls.length === 2 ? true : null))

    // The latest request resolves FIRST; the older one resolves later. The
    // field must still settle on the latest result, not the stale one.
    calls[1]?.resolve('FAST')
    await waitUntil(() => (api.values.field === 'FAST' ? true : null))
    calls[0]?.resolve('SLOW')
    await wait(0)

    expect(api.values.field).toBe('FAST')
    expect(api.fields('field').transforming).toBe(false)
  })

  // ── 3. Latest request rejects while an older would have succeeded ──────────
  it('a rejecting latest run surfaces the failure, never a superseded success', async () => {
    const { transform, calls } = makeSettlerTransform()
    const { api, input } = mount({
      schema: z.object({ field: z.string() }),
      defaultValues: { field: 'seed' },
      transforms: [transform],
    })

    dispatchInput(input, 'older') // call 0 — would resolve
    dispatchInput(input, 'newer') // call 1 — the latest, rejects
    await waitUntil(() => (calls.length === 2 ? true : null))

    calls[1]?.reject(new Error('normalize failed'))
    calls[0]?.resolve('OLDER-RESOLVED') // superseded → must be discarded
    await waitUntil(() => (api.fields('field').transformError !== null ? true : null))

    expect(api.fields('field').transformError).toBeInstanceOf(Error)
    expect(api.fields('field').transformError?.message).toContain('normalize failed')
    // Neither the stale success nor a half-applied value landed.
    expect(api.values.field).toBe('seed')
  })

  // ── 4. reset() mid-flight → a late resolve does not clobber cleared state ───
  it('reset() mid-flight cancels the run so a late resolve is discarded', async () => {
    const { transform, calls } = makeSettlerTransform()
    const { api, input } = mount({
      schema: z.object({ field: z.string() }),
      defaultValues: { field: 'seed' },
      transforms: [transform],
    })

    dispatchInput(input, 'typed')
    await waitUntil(() => (calls.length === 1 ? true : null))
    expect(api.fields('field').transforming).toBe(true)

    api.reset()
    expect(api.fields('field').transforming).toBe(false)

    calls[0]?.resolve('LATE') // resolves after the cancel — must not write
    await wait(0)

    expect(api.values.field).toBe('seed')
    expect(api.fields('field').transformError).toBe(null)
  })

  // ── 4b. unmount mid-flight → a late resolve is inert (no throw, no write) ───
  it('unmount mid-flight discards a late resolve without throwing', async () => {
    const { transform, calls } = makeSettlerTransform()
    const { api, app, input } = mount({
      schema: z.object({ field: z.string() }),
      defaultValues: { field: 'seed' },
      transforms: [transform],
    })

    dispatchInput(input, 'typed')
    await waitUntil(() => (calls.length === 1 ? true : null))

    app.unmount()
    const idx = apps.indexOf(app)
    if (idx !== -1) apps.splice(idx, 1)

    expect(() => calls[0]?.resolve('LATE')).not.toThrow()
    await wait(0)
    expect(api.values.field).toBe('seed')
  })

  // ── 5 + 6. Rejection is a structured channel, never a thrown / unhandled one ─
  it('settleTransforms() resolves (never rejects) when a transform rejects', async () => {
    const { transform, calls } = makeSettlerTransform()
    const { api, input } = mount({
      schema: z.object({ field: z.string() }),
      defaultValues: { field: 'seed' },
      transforms: [transform],
    })

    dispatchInput(input, 'go')
    await waitUntil(() => (calls.length === 1 ? true : null))
    calls[0]?.reject(new Error('boom'))

    await expect(api.settleTransforms()).resolves.toBeUndefined()
    expect(api.fields('field').transformError?.message).toContain('boom')
  })

  it('an async rejection sets transformError with no console output and no unhandled rejection', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const { api, input } = mount({
        schema: z.object({ field: z.string() }),
        defaultValues: { field: 'seed' },
        // Reject straight off — the directive's `.then(_, onRejected)` arm
        // owns the rejection, so it can never escape as unhandled.
        transforms: [() => Promise.reject(new Error('reject-now'))],
      })

      dispatchInput(input, 'go')
      await api.settleTransforms()
      // Give a macrotask for any stray unhandled-rejection to surface.
      await wait(0)

      expect(api.fields('field').transformError?.message).toContain('reject-now')
      expect(errSpy).not.toHaveBeenCalled()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      errSpy.mockRestore()
    }
  })

  // ── 7. transforming / busy track the in-flight window; sync never flips ─────
  it('transforming and busy flip true during an async run and clear on settle', async () => {
    const { transform, calls } = makeSettlerTransform()
    const { api, input } = mount({
      schema: z.object({ field: z.string() }),
      defaultValues: { field: '' },
      transforms: [transform],
    })

    dispatchInput(input, 'x')
    // beginTransform runs synchronously inside the assigner, so the flags are
    // already true the instant the event handler returns.
    expect(api.fields('field').transforming).toBe(true)
    expect(api.fields('field').busy).toBe(true)

    await waitUntil(() => (calls.length === 1 ? true : null))
    calls[0]?.resolve('X')
    await waitUntil(() => (api.values.field === 'X' ? true : null))

    expect(api.fields('field').transforming).toBe(false)
    expect(api.fields('field').busy).toBe(false)
  })

  it('a synchronous write never flips transforming true', () => {
    const { api, input } = mount({
      schema: z.object({ field: z.string() }),
      defaultValues: { field: '' },
      transforms: [(v: unknown) => String(v).toUpperCase()],
    })
    const seen: boolean[] = []
    const stop = watch(
      () => api.fields('field').transforming,
      (v: boolean) => seen.push(v),
      { flush: 'sync' }
    )
    dispatchInput(input, 'abc')
    stop()

    expect(api.values.field).toBe('ABC')
    expect(seen).not.toContain(true)
    expect(api.fields('field').transforming).toBe(false)
  })

  // ── 8. handleSubmit drains transforms before parsing ───────────────────────
  it('handleSubmit awaits transform quiescence so it parses the resolved value', async () => {
    const { api, input } = mount({
      schema: z.object({ field: z.string() }),
      defaultValues: { field: '' },
      // A self-resolving async transform: the submit barrier must wait it out.
      transforms: [
        async (v: unknown) => {
          await wait(15)
          return String(v).toUpperCase()
        },
      ],
    })

    dispatchInput(input, 'go')
    // Submit IMMEDIATELY — without first awaiting settleTransforms. The drain
    // inside handleSubmit is the correctness net.
    let submitted: { field?: string } | undefined
    await api.handleSubmit((data: { field?: string }) => {
      submitted = data
    })()

    expect(submitted?.field).toBe('GO')
    expect(api.values.field).toBe('GO')
  })

  // ── 9. ctx.signal aborts on supersede; a sync chain's signal never aborts ──
  it('ctx.signal aborts when a newer input supersedes the run', async () => {
    const { transform, calls } = makeSettlerTransform()
    const { api, input } = mount({
      schema: z.object({ field: z.string() }),
      defaultValues: { field: '' },
      transforms: [transform],
    })

    dispatchInput(input, 'first')
    await waitUntil(() => (calls.length === 1 ? true : null))
    expect(calls[0]?.signal?.aborted).toBe(false)

    dispatchInput(input, 'second')
    await waitUntil(() => (calls.length === 2 ? true : null))

    // The first run was superseded — its signal aborts so a signal-aware
    // transform can cancel its own I/O. The live run's signal stays open.
    expect(calls[0]?.signal?.aborted).toBe(true)
    expect(calls[1]?.signal?.aborted).toBe(false)

    calls[1]?.resolve('SECOND')
    calls[0]?.resolve('FIRST')
    await api.settleTransforms()
    expect(api.values.field).toBe('SECOND')
  })

  // Surface guard: the three transform keys must reach BOTH proxy access
  // forms — the call form `fields('field')` and the dot form `fields.field`.
  // (Regression: commit 3 added them to the leaf base + types but not the
  // proxy's FIELD_STATE_KEYS allowlist, so both forms read `undefined`.)
  it('exposes transforming / busy / transformError on both fields(path) and fields.path', async () => {
    const { transform, calls } = makeSettlerTransform()
    const { api, input } = mount({
      schema: z.object({ field: z.string() }),
      defaultValues: { field: '' },
      transforms: [transform],
    })
    dispatchInput(input, 'x')
    await waitUntil(() => (calls.length === 1 ? true : null))

    for (const view of [api.fields('field'), api.fields.field]) {
      expect(view.transforming).toBe(true)
      expect(view.busy).toBe(true)
      expect(view.transformError).toBe(null)
    }

    calls[0]?.resolve('X')
    await api.settleTransforms()
  })

  // The root rollup: form.meta inherits transforming / busy from its
  // descendants (transformError is leaf-only → null at the root).
  it('rolls transforming / busy up to form.meta while a transform is in flight', async () => {
    const { transform, calls } = makeSettlerTransform()
    const { api, input } = mount({
      schema: z.object({ field: z.string() }),
      defaultValues: { field: '' },
      transforms: [transform],
    })

    expect(api.meta.transforming).toBe(false)
    expect(api.meta.busy).toBe(false)

    dispatchInput(input, 'x')
    await waitUntil(() => (calls.length === 1 ? true : null))
    expect(api.meta.transforming).toBe(true)
    expect(api.meta.busy).toBe(true)
    expect(api.meta.transformError).toBe(null)

    calls[0]?.resolve('X')
    await waitUntil(() => (api.meta.transforming === false ? true : null))
    expect(api.meta.busy).toBe(false)
  })

  it('a synchronous chain that reads ctx.signal gets a never-aborted signal', () => {
    let seen: AbortSignal | null = null
    const { api, input } = mount({
      schema: z.object({ field: z.string() }),
      defaultValues: { field: '' },
      transforms: [
        (v: unknown, ctx?: { signal: AbortSignal }) => {
          seen = ctx?.signal ?? null
          return String(v).toUpperCase()
        },
      ],
    })
    dispatchInput(input, 'abc')

    expect(api.values.field).toBe('ABC') // committed synchronously
    expect(seen).not.toBe(null)
    expect((seen as unknown as AbortSignal | null)?.aborted).toBe(false)
  })
})
