// @vitest-environment jsdom
//
// Stage 2 — vRegisterFile unified with the transform pipeline.
//
// A file selection now flows through the same assigner every other input
// variant uses: `transforms: [...]` runs (sync or async), `coerce` post-fixes
// the normalized result, and an async transform drives the busy / pending /
// settle / transformError machinery exactly as on a text input — the "drop a
// file, normalize it inline into canonical state" case. A cleared selection
// stays a direct blank commit (no pipeline), and a consumer
// `@update:registerValue` override now works on file inputs too. Verified
// across both zod adapters.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, withDirectives, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { vRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import { DEFAULT_TIMINGS } from '../../src'
import { wait, waitUntil } from '../utils/form-harness'

// ── file-input simulation (jsdom can't drive the native picker) ──────────────
function dispatchChange(el: HTMLInputElement): void {
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

// jsdom marks `el.files` read-only; override with an array-like stand-in that
// mimics the `length` + indexed access + `item(i)` + iterator surface.
function setFiles(el: HTMLInputElement, files: File[]): void {
  const list = {
    ...files,
    length: files.length,
    item(index: number) {
      return files[index] ?? null
    },
    [Symbol.iterator]() {
      let i = 0
      return {
        next: () =>
          i < files.length
            ? { value: files[i++] as File, done: false as const }
            : { value: undefined as unknown as File, done: true as const },
      }
    },
  } as unknown as FileList
  Object.defineProperty(el, 'files', { value: list, configurable: true })
}

function makeFile(name: string): File {
  return new File([new Uint8Array(8)], name, { type: 'text/plain' })
}

// A transform whose single call parks on an externally-resolvable promise, so
// the test owns settlement and can sit inside the in-flight window.
function makeGate(): {
  transform: (value: unknown, ctx?: { signal: AbortSignal }) => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
} {
  let resolveFn: (value: unknown) => void = () => {}
  let rejectFn: (reason: unknown) => void = () => {}
  const promise = new Promise<unknown>((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })
  return {
    transform: () => promise,
    resolve: (value) => resolveFn(value),
    reject: (reason) => rejectFn(reason),
  }
}

type Settler = { input: unknown; resolve: (value: unknown) => void }

// A transform that records each call so a test can settle them out of order.
function makeSettlerTransform(): {
  transform: (value: unknown) => Promise<unknown>
  calls: Settler[]
} {
  const calls: Settler[] = []
  const transform = (value: unknown): Promise<unknown> => {
    const entry: Settler = { input: value, resolve: () => {} }
    const promise = new Promise<unknown>((resolve) => {
      entry.resolve = resolve
    })
    calls.push(entry)
    return promise
  }
  return { transform, calls }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUseForm = (opts: any) => any

const adapters = [
  { name: 'v4', useForm: useFormV4 as AnyUseForm, z: zV4 },
  { name: 'v3', useForm: useFormV3 as AnyUseForm, z: zV3 as unknown as typeof zV4 },
] as const

type Mounted = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: any
  input: HTMLInputElement
  bumpTick: () => void
}

describe.each(adapters)('async file transforms — $name', ({ useForm, z }) => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    document.body.innerHTML = ''
  })

  function mount(opts: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schema: any
    multiple?: boolean
    transforms?: Array<(value: unknown, ctx?: { signal: AbortSignal }) => unknown>
    defaultValues?: Record<string, unknown>
    onUpdate?: (value: unknown) => void
  }): Mounted {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle: { api?: any; bumpTick?: () => void } = {}
    const Parent = defineComponent({
      setup() {
        const tick = ref(0)
        const api = useForm({
          schema: opts.schema,
          key: `axff-${Math.random().toString(36).slice(2)}`,
          strict: false,
          ...(opts.defaultValues ? { defaultValues: opts.defaultValues } : {}),
        })
        handle.api = api
        handle.bumpTick = () => {
          tick.value++
        }
        const rv = api.register(
          'field',
          opts.transforms ? { transforms: opts.transforms } : undefined
        )
        return () => {
          const props: Record<string, unknown> = {
            type: 'file',
            'data-field': 'field',
            // A reactive attribute so `bumpTick` forces a parent re-render that
            // patches THIS input → its directive `beforeUpdate` hook fires.
            'data-tick': tick.value,
          }
          if (opts.multiple === true) props['multiple'] = true
          if (opts.onUpdate) props['onUpdate:registerValue'] = opts.onUpdate
          return withDirectives(h('input', props), [[vRegister, rv]])
        }
      },
    })
    const app = createApp(Parent).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    apps.push(app)
    const input = root.querySelector('[data-field="field"]')
    if (
      handle.api === undefined ||
      handle.bumpTick === undefined ||
      !(input instanceof HTMLInputElement)
    ) {
      throw new Error('mount: api / input never set')
    }
    return { api: handle.api, input, bumpTick: handle.bumpTick }
  }

  it('an async transform on a file pick commits the resolved value and tracks busy', async () => {
    const gate = makeGate()
    const { api, input } = mount({
      schema: z.object({ field: z.string().nullable() }),
      defaultValues: { field: null },
      transforms: [gate.transform],
    })
    await nextTick()

    setFiles(input, [makeFile('roster.csv')])
    dispatchChange(input)
    await nextTick()

    // In flight: the commit is deferred, so storage is still the blank seed.
    expect(api.fields('field').transforming).toBe(true)
    expect(api.fields('field').busy).toBe(true)
    expect(api.values.field).toBeNull()

    gate.resolve('PARSED')
    await waitUntil(() => (api.fields('field').transforming === false ? true : null))

    expect(api.values.field).toBe('PARSED')
    expect(api.fields('field').busy).toBe(false)
  })

  it('a sync transform on a file pick commits in the same cycle (no busy flip)', async () => {
    const { api, input } = mount({
      schema: z.object({ field: z.array(z.string()) }),
      multiple: true,
      defaultValues: { field: [] },
      transforms: [(files) => (files as File[]).map((f) => f.name)],
    })
    await nextTick()

    setFiles(input, [makeFile('a.csv'), makeFile('b.csv')])
    dispatchChange(input)
    await nextTick()

    expect(api.values.field).toEqual(['a.csv', 'b.csv'])
    expect(api.fields('field').transforming).toBe(false)
  })

  it('a file path with no transforms commits the raw selection unchanged', async () => {
    const { api, input } = mount({
      schema: z.object({ field: z.array(z.unknown()) }),
      multiple: true,
      defaultValues: { field: [] },
    })
    await nextTick()

    const picked = [makeFile('a.csv'), makeFile('b.csv')]
    setFiles(input, picked)
    dispatchChange(input)
    await nextTick()

    expect(api.values.field).toHaveLength(2)
    expect(api.values.field[0]).toBe(picked[0])
    expect(api.values.field[1]).toBe(picked[1])
    expect(api.fields('field').transforming).toBe(false)
  })

  it('a rapid re-pick discards the stale run and commits the latest (latest-pick-wins)', async () => {
    const { transform, calls } = makeSettlerTransform()
    const { api, input } = mount({
      schema: z.object({ field: z.array(z.string()) }),
      multiple: true,
      defaultValues: { field: [] },
      transforms: [transform],
    })
    await nextTick()

    setFiles(input, [makeFile('first.csv')])
    dispatchChange(input)
    await nextTick()
    setFiles(input, [makeFile('second.csv')])
    dispatchChange(input)
    await nextTick()

    expect(calls.length).toBe(2)
    // Resolve the SECOND (live) run, then the FIRST (superseded) run — the
    // stale resolve must be discarded, leaving the latest pick's result.
    calls[1]?.resolve(['second'])
    calls[0]?.resolve(['first'])
    await waitUntil(() => (api.fields('field').transforming === false ? true : null))

    expect(api.values.field).toEqual(['second'])
  })

  it('a rejecting file transform sets transformError with no console / unhandled noise', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const { api, input } = mount({
        schema: z.object({ field: z.string().nullable() }),
        defaultValues: { field: null },
        transforms: [() => Promise.reject(new Error('parse-failed'))],
      })
      await nextTick()

      setFiles(input, [makeFile('bad.csv')])
      dispatchChange(input)
      await api.settleTransforms()
      await wait(0)

      expect(api.fields('field').transformError?.message).toContain('parse-failed')
      expect(errSpy).not.toHaveBeenCalled()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      errSpy.mockRestore()
    }
  })

  it('settleTransforms resolves (never rejects) when a file transform rejects', async () => {
    const gate = makeGate()
    const { api, input } = mount({
      schema: z.object({ field: z.string().nullable() }),
      defaultValues: { field: null },
      transforms: [gate.transform],
    })
    await nextTick()

    setFiles(input, [makeFile('x.csv')])
    dispatchChange(input)
    await nextTick()

    gate.reject(new Error('nope'))
    await expect(api.settleTransforms()).resolves.toBeUndefined()
  })

  it('a parent re-render does not cancel an in-flight file transform (no mid-flight revert)', async () => {
    const gate = makeGate()
    const { api, input, bumpTick } = mount({
      schema: z.object({ field: z.array(z.string()) }),
      multiple: true,
      defaultValues: { field: [] },
      transforms: [gate.transform],
    })
    await nextTick()

    setFiles(input, [makeFile('roster.csv')])
    dispatchChange(input)
    await nextTick()
    expect(api.fields('field').transforming).toBe(true)
    expect(api.values.field).toEqual([])

    // Force the file directive's `beforeUpdate` to fire while storage is
    // transiently the blank shape (the deferred commit hasn't landed). The
    // guard must skip the blank re-mark / clear so the write chokepoint never
    // supersedes the live run.
    bumpTick()
    await nextTick()
    expect(api.fields('field').transforming).toBe(true)

    gate.resolve(['alice', 'bob'])
    await waitUntil(() => (api.fields('field').transforming === false ? true : null))
    expect(api.values.field).toEqual(['alice', 'bob'])
  })

  it('clearing the file input cancels an in-flight transform (its late resolve is discarded)', async () => {
    const gate = makeGate()
    const { api, input } = mount({
      schema: z.object({ field: z.array(z.string()) }),
      multiple: true,
      defaultValues: { field: [] },
      transforms: [gate.transform],
    })
    await nextTick()

    setFiles(input, [makeFile('roster.csv')])
    dispatchChange(input)
    await nextTick()
    expect(api.fields('field').transforming).toBe(true)

    // Clear the selection: a direct blank commit funnels through the write
    // chokepoint and supersedes the in-flight run.
    setFiles(input, [])
    dispatchChange(input)
    await nextTick()
    expect(api.fields('field').transforming).toBe(false)

    // The original run's late resolve must not clobber the cleared state.
    gate.resolve(['alice'])
    await wait(0)
    expect(api.values.field).toEqual([])
  })

  it('the submit barrier drains an in-flight file transform before validating', async () => {
    const gate = makeGate()
    const { api, input } = mount({
      schema: z.object({ field: z.array(z.string()) }),
      multiple: true,
      defaultValues: { field: [] },
      transforms: [gate.transform],
    })
    await nextTick()

    setFiles(input, [makeFile('roster.csv')])
    dispatchChange(input)
    await nextTick()
    expect(api.fields('field').transforming).toBe(true)

    let seen: unknown
    const submitted = api.handleSubmit((values: { field: unknown }) => {
      seen = values.field
    })()
    // The submit is parked on the transform drain; resolve it now so the
    // committed value is what validation (and the handler) see.
    gate.resolve(['alice', 'bob'])
    await submitted

    expect(seen).toEqual(['alice', 'bob'])
  })

  it('a consumer @update:registerValue override receives the resolved coerced value once', async () => {
    const gate = makeGate()
    const captured: unknown[] = []
    const { api, input } = mount({
      schema: z.object({ field: z.array(z.string()) }),
      multiple: true,
      defaultValues: { field: [] },
      transforms: [gate.transform],
      onUpdate: (value) => {
        captured.push(value)
      },
    })
    await nextTick()

    setFiles(input, [makeFile('roster.csv')])
    dispatchChange(input)
    await nextTick()

    // In flight on the override path too — busy tracks the window even though
    // the consumer owns the write, and the handler has NOT fired yet.
    expect(api.fields('field').transforming).toBe(true)
    expect(captured).toEqual([])

    gate.resolve(['alice', 'bob'])
    await waitUntil(() => (captured.length === 1 ? true : null))

    expect(captured).toEqual([['alice', 'bob']])
    expect(api.fields('field').transforming).toBe(false)
  })
})

describe.each(adapters)('async file transform — gated display ($name)', ({ useForm, z }) => {
  const apps: App[] = []
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    while (apps.length > 0) apps.pop()?.unmount()
    document.body.innerHTML = ''
  })

  function mount(transform: (value: unknown) => Promise<unknown>): {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api: any
    input: HTMLInputElement
  } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle: { api?: any } = {}
    const Parent = defineComponent({
      setup() {
        const api = useForm({
          schema: z.object({ field: z.array(z.string()) }),
          key: `axff-disp-${Math.random().toString(36).slice(2)}`,
          strict: false,
          defaultValues: { field: [] },
        })
        handle.api = api
        const rv = api.register('field', { transforms: [transform] })
        return () =>
          withDirectives(h('input', { type: 'file', multiple: true, 'data-field': 'field' }), [
            [vRegister, rv],
          ])
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
    return { api: handle.api, input }
  }

  it('a revealed file field drives pending + aria-busy past the show-delay, then settles', async () => {
    const gate = makeGate()
    const { api, input } = mount(gate.transform)

    // Seed a non-blank, valid value and reveal the field via a submit → with
    // the gate open and the field earned-valid, displayState is 'success'.
    api.setValue('field', ['seed'])
    await api.handleSubmit(() => {})()
    await nextTick()
    expect(api.fields('field').displayState).toBe('success')

    // Pick a file → async transform in flight (commit deferred, so the
    // committed 'seed' is still the verdict source).
    setFiles(input, [makeFile('roster.csv')])
    dispatchChange(input)
    await nextTick()
    expect(api.fields('field').transforming).toBe(true)

    // Inside the show-delay the prior success is HELD — no spinner flash.
    expect(api.fields('field').displayState).toBe('success')
    expect(input.hasAttribute('aria-busy')).toBe(false)

    // Cross the show-delay: the long-running transform earns the spinner, and
    // the held success is suppressed under pending (never flashed).
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.showDelay)
    expect(api.fields('field').displayState).toBe('pending')
    expect(input.getAttribute('aria-busy')).toBe('true')

    // Resolve + clear min-visible: back to the settled verdict.
    gate.resolve(['alice', 'bob'])
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.minVisible)
    await nextTick()
    expect(api.fields('field').transforming).toBe(false)
    expect(api.fields('field').displayState).toBe('success')
    expect(input.hasAttribute('aria-busy')).toBe(false)
  })
})
