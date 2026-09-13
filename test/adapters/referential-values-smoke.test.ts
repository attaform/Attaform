// @vitest-environment jsdom
/**
 * Adversarial smoke test for referential field values.
 *
 * Attaform does not dictate what a developer chooses to track. A
 * symbol, a callback, a Promise, a class instance with private state,
 * a WeakMap: all legal field values, none of them serializable, and
 * serializing whatever needs serializing before it crosses the wire is
 * work for the `handleSubmit` callback. That is the developer's call.
 *
 * Attaform's job is narrower and this file is about that job: keep
 * chugging along. Drive every referential kind through the whole
 * lifecycle — mount, read, write, validate, array churn, variant
 * switch, dirty tracking, reset, clear, submit — and assert only that
 * nothing throws, nothing hangs, and nothing silently swaps the value
 * for something else. It deliberately does NOT assert anything about
 * serialization.
 *
 * Written as a probe rather than a specification: the assertions are
 * about Attaform staying upright under values it cannot introspect,
 * not about any particular kind's semantics. Per-kind behaviour lives
 * in `every-zod-kind.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { makeMounter } from '../utils/form-harness'

/** A class whose methods read `#private` state — hostile to proxying. */
class Session {
  #token: string
  label = 'session'
  constructor(token: string) {
    this.#token = token
  }
  reveal(): string {
    return this.#token
  }
}

/**
 * Run `validate()` inside an effect scope and settle it.
 *
 * The scope is not incidental: calling `validate()` outside one is a
 * leak Attaform warns about by design, and this file asserts a silent
 * console, so the harness has to hold up its end.
 *
 * Returns `null` when the status never settles, so a caller can assert
 * on that instead of timing out.
 */
async function settle(
  run: () => { value: { pending: boolean } },
  ticks = 40
): Promise<{ pending: boolean; success: boolean } | null> {
  const scope = effectScope()
  try {
    const status = scope.run(run)
    if (status === undefined) return null
    for (let i = 0; i < ticks && status.value.pending; i++) {
      await Promise.resolve()
      await nextTick()
    }
    return status.value.pending ? null : (status.value as { pending: boolean; success: boolean })
  } finally {
    scope.stop()
  }
}

/** Run `fn` with console.warn and console.error captured. */
async function quietly(fn: () => Promise<void> | void): Promise<string[]> {
  const noise: string[] = []
  const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    noise.push(`warn: ${a.map(String).join(' ')}`)
  })
  const error = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    noise.push(`error: ${a.map(String).join(' ')}`)
  })
  try {
    await fn()
  } finally {
    warn.mockRestore()
    error.mockRestore()
  }
  return noise
}

const ADAPTERS = [
  {
    name: 'zod v4',
    useForm: useFormV4,
    kitchenSink: () =>
      zV4.object({
        label: zV4.string(),
        tag: zV4.symbol(),
        cb: zV4.function(),
        pending: zV4.promise(zV4.string()),
        index: zV4.map(zV4.string(), zV4.number()),
        bag: zV4.set(zV4.string()),
        session: zV4.instanceof(Session),
        anything: zV4.unknown(),
        handlers: zV4.array(zV4.function()),
      }),
    variant: () =>
      zV4.object({
        src: zV4.discriminatedUnion('kind', [
          zV4.object({ kind: zV4.literal('live'), cb: zV4.function(), tag: zV4.symbol() }),
          zV4.object({ kind: zV4.literal('static'), url: zV4.string() }),
        ]),
      }),
    handlerList: () => zV4.object({ handlers: zV4.array(zV4.function()) }),
  },
  {
    name: 'zod v3',
    useForm: useFormV3,
    kitchenSink: () =>
      zV3.object({
        label: zV3.string(),
        tag: zV3.symbol(),
        cb: zV3.function(),
        pending: zV3.promise(zV3.string()),
        index: zV3.map(zV3.string(), zV3.number()),
        bag: zV3.set(zV3.string()),
        session: zV3.instanceof(Session),
        anything: zV3.unknown(),
        handlers: zV3.array(zV3.function()),
      }),
    variant: () =>
      zV3.object({
        src: zV3.discriminatedUnion('kind', [
          zV3.object({ kind: zV3.literal('live'), cb: zV3.function(), tag: zV3.symbol() }),
          zV3.object({ kind: zV3.literal('static'), url: zV3.string() }),
        ]),
      }),
    handlerList: () => zV3.object({ handlers: zV3.array(zV3.function()) }),
  },
] as const

describe.each(ADAPTERS)('referential values keep the form upright — $name', (adapter) => {
  it('mounts a schema holding nine unserializable things at once', () => {
    expect(() => makeMounter(adapter.useForm, adapter.kitchenSink(), {})()).not.toThrow()
  })

  it('survives the full lifecycle without noise', async () => {
    const tag = Symbol('tag')
    const cb = () => 'ok'
    // Resolves to a valid string on purpose. An UNFILLED z.promise
    // field has its own pin at the bottom of this file: on v3 the
    // verdict arrives as a promise rejection rather than a form error,
    // which is zod's behaviour and worth stating separately rather
    // than folding into a general noise assertion.
    const pending = Promise.resolve('later')
    const session = new Session('secret')

    const { api } = makeMounter(adapter.useForm, adapter.kitchenSink(), { strict: true })()

    const noise = await quietly(async () => {
      api.setValue('label', 'hello')
      api.setValue('tag', tag)
      api.setValue('cb', cb)
      api.setValue('pending', pending)
      api.setValue('index', new Map([['a', 1]]))
      api.setValue('bag', new Set(['x']))
      api.setValue('session', session)
      api.setValue('anything', new WeakMap())
      await nextTick()

      expect(await settle(() => api.validate())).not.toBeNull()

      // Read every path back through the reactive proxy.
      void api.values.tag
      void api.values.cb
      void api.values.session
      void api.errors('tag')
      void api.meta.dirty
      await nextTick()
    })

    expect(noise).toEqual([])
    expect(api.values.tag).toBe(tag)
    expect(api.values.label).toBe('hello')
  })

  it('lets a private-field class instance stay callable through the store', () => {
    // The sharpest edge in the reactive tree: Vue proxies a plain class
    // instance, and a method reading `#private` state throws through the
    // proxy. Attaform must not make that worse, and must not silently
    // swap the instance for something else.
    const { api } = makeMounter(adapter.useForm, adapter.kitchenSink(), {})()
    const session = new Session('secret')
    api.setValue('session', session)
    const read = api.values.session
    expect(read).toBeInstanceOf(Session)
    // Reaching the private field may throw through the proxy (that is
    // Vue's boundary, documented in the schema contract). What must NOT
    // happen is a different value coming back.
    let revealed: string | null
    try {
      revealed = (read as Session).reveal()
    } catch {
      revealed = null
    }
    expect(revealed === 'secret' || revealed === null).toBe(true)
    expect((read as Session).label).toBe('session')
  })

  it('churns an array of callbacks through every list helper', async () => {
    // Array helpers rebuild the container on every call. A function
    // element has no own enumerable properties, so a key-by-key rebuild
    // would turn each one into `{}` and the calls below would throw.
    const { api } = makeMounter(adapter.useForm, adapter.handlerList(), {
      defaultValues: { handlers: [] },
    })()
    const a = () => 'a'
    const b = () => 'b'
    const c = () => 'c'

    const noise = await quietly(async () => {
      api.setValue('handlers', [a, b])
      await nextTick()
      api.append('handlers', c)
      api.prepend('handlers', () => 'd')
      api.swap('handlers', 0, 3)
      api.move('handlers', 0, 2)
      api.insert('handlers', 1, () => 'e')
      api.replace('handlers', 0, () => 'f')
      api.remove('handlers', 0)
      await nextTick()
    })

    expect(noise).toEqual([])
    const handlers = api.values.handlers as Array<() => string>
    expect(handlers.length).toBeGreaterThan(0)
    for (const fn of handlers) {
      expect(typeof fn).toBe('function')
      expect(() => fn()).not.toThrow()
    }
    // The read-only list view reaches the same instances, not copies.
    expect(api.list('handlers')[0]?.value).toBe(handlers[0])
  })

  it('round-trips referential values through a variant switch', async () => {
    const { api } = makeMounter(adapter.useForm, adapter.variant(), {
      defaultValues: { src: { kind: 'live' } },
    })()
    const cb = () => 'live'
    const tag = Symbol('live')

    const noise = await quietly(async () => {
      api.setValue('src.cb', cb)
      api.setValue('src.tag', tag)
      await nextTick()
      api.setValue('src.kind', 'static')
      await nextTick()
      api.setValue('src.kind', 'live')
      await nextTick()
    })

    expect(noise).toEqual([])
    // Typed as possibly-absent because that is the runtime truth: the
    // variant memory either restored both or left them unset.
    const restored = api.values.src as { cb?: () => string; tag?: symbol }
    // Variant memory either restored them or left them absent. Either is
    // a legitimate outcome; handing back a mangled `{}` is not.
    expect(restored.cb === undefined || typeof restored.cb === 'function').toBe(true)
    expect(restored.tag === undefined || typeof restored.tag === 'symbol').toBe(true)
    if (typeof restored.cb === 'function') expect(restored.cb()).toBe('live')
  })

  it('resets and clears without mangling anything', async () => {
    const { api } = makeMounter(adapter.useForm, adapter.kitchenSink(), {})()
    const tag = Symbol('tag')

    const noise = await quietly(async () => {
      api.setValue('tag', tag)
      api.setValue('index', new Map([['a', 1]]))
      api.setValue('session', new Session('s'))
      await nextTick()
      api.clear('tag')
      api.clear('index')
      await nextTick()
      api.reset()
      await nextTick()
      api.reset({ tag, index: new Map([['b', 2]]) })
      await nextTick()
    })

    expect(noise).toEqual([])
    expect(api.values.tag).toBe(tag)
    expect(api.values.index).toBeInstanceOf(Map)
    expect((api.values.index as Map<string, number>).get('b')).toBe(2)
  })

  it('hands the whole payload to handleSubmit and lets the developer own it', async () => {
    // The contract in one test. Attaform delivers the values; what the
    // developer does about serialization is theirs. A handler that
    // serializes selectively must be able to see every field it needs.
    const { api } = makeMounter(adapter.useForm, adapter.kitchenSink(), {
      defaultValues: {
        label: 'x',
        tag: Symbol('t'),
        cb: () => 1,
        pending: Promise.resolve('p'),
        index: new Map([['a', 1]]),
        bag: new Set(['b']),
        session: new Session('s'),
        anything: new WeakMap(),
        handlers: [() => 1],
      },
    })()

    let wire: string | undefined
    const noise = await quietly(async () => {
      await api.handleSubmit((data: unknown) => {
        const d = data as { label: string; index: Map<string, number>; bag: Set<string> }
        // Exactly the "that's on them" move: drop what cannot cross the
        // wire, keep what can. Attaform never had to decide this.
        wire = JSON.stringify({ label: d.label, index: [...d.index], bag: [...d.bag] })
      })()
    })

    expect(noise).toEqual([])
    expect(wire).toBe('{"label":"x","index":[["a",1]],"bag":["b"]}')
  })

  it('settles validation for a resolving Promise field', async () => {
    const { api } = makeMounter(adapter.useForm, adapter.kitchenSink(), {})()
    api.setValue('pending', Promise.resolve('done'))
    await nextTick()
    expect(await settle(() => api.validate())).not.toBeNull()
  })

  it('does not hang when a stored function throws on call', async () => {
    // Nothing in Attaform should be calling a stored callback, but if
    // some walker ever did, a throwing one would surface it here rather
    // than in a consumer's app.
    const { api } = makeMounter(adapter.useForm, adapter.kitchenSink(), {})()
    const boom = () => {
      throw new Error('should never be called by Attaform')
    }
    const noise = await quietly(async () => {
      api.setValue('cb', boom)
      api.setValue('handlers', [boom, boom])
      // Filled so this test measures the throwing callback and nothing
      // else; the unfilled-promise divergence has its own pin below.
      api.setValue('pending', Promise.resolve('p'))
      await nextTick()
      await settle(() => api.validate())
      void api.meta.dirty
      api.reset()
      await nextTick()
    })
    expect(noise).toEqual([])
  })
})

describe('z.promise carries Zod semantics, not Attaform semantics', () => {
  /**
   * `z.promise(X)` does not mean "a field holding a promise". It means
   * "a promise that must resolve to X", so validating one has to reach
   * through it. Both majors do, differently, and both behaviours belong
   * to Zod. Pinned here so the divergence is a known property rather
   * than something a consumer discovers in production.
   *
   * A developer who wants to PARK a promise in a field without Zod
   * reaching into it should reach for `z.custom<Promise<T>>()` or
   * `z.unknown()`, which are opaque and carry the value untouched.
   */
  const timeboxed = async (p: Promise<unknown>, ms = 150) =>
    Promise.race([p.then(() => 'settled'), new Promise((r) => setTimeout(() => r('hung'), ms))])

  it('v4 awaits the stored promise, so a never-resolving one blocks validation', async () => {
    const schema = zV4.object({ pending: zV4.promise(zV4.string()) })
    const verdict = await timeboxed(
      schema.safeParseAsync({ pending: new Promise<string>(() => {}) })
    )
    expect(verdict).toBe('hung')
  })

  it('v3 resolves immediately and defers the verdict onto a derived promise', async () => {
    // v3 reports success straight away and puts a still-pending derived
    // promise in `data`. That promise carries the real verdict, and it
    // rejects with a ZodError when the inner value is wrong. A caller
    // that never awaits it gets an unhandled rejection from Zod, which
    // is why this test attaches a handler.
    const schema = zV3.object({ pending: zV3.promise(zV3.string()) })
    const result = await schema.safeParseAsync({ pending: Promise.resolve(undefined) })
    expect(result.success).toBe(true)
    if (!result.success) return
    const derived = result.data.pending as unknown as Promise<string>
    expect(derived).toBeInstanceOf(Promise)
    await expect(derived).rejects.toBeInstanceOf(zV3.ZodError)
  })

  it('an opaque leaf parks a promise without either major reaching into it', async () => {
    // The escape hatch, on both majors. This is what a developer who
    // wants to TRACK a promise (rather than assert on its resolution)
    // should reach for.
    const v4 = zV4.object({ parked: zV4.custom<Promise<string>>((v) => v instanceof Promise) })
    const v3 = zV3.object({ parked: zV3.custom<Promise<string>>((v) => v instanceof Promise) })
    const never = new Promise<string>(() => {})
    expect(await timeboxed(v4.safeParseAsync({ parked: never }))).toBe('settled')
    expect(await timeboxed(v3.safeParseAsync({ parked: never }))).toBe('settled')
  })
})

describe('an unfilled z.promise field reports differently per major', () => {
  /**
   * `z.promise(X)` has no empty member, so an unwritten field holds
   * `undefined`. What each major does with that is worth knowing before
   * you put one in a schema, and it is not symmetric.
   *
   * On v4 the parse awaits and the failure lands as an ordinary form
   * error, the way every other unfilled required field does.
   *
   * On v3 the parse reports SUCCESS and hands back a derived promise
   * carrying the real verdict. Nothing in Attaform awaits that promise
   * (awaiting it is what makes v4 hang on a slow value), so when it
   * rejects it surfaces as an unhandled rejection: a red console entry
   * in the browser, a `window.onunhandledrejection` event, and no form
   * error to go with it.
   *
   * Attaform does not silence it. A blanket `.catch()` on promises
   * reaching the adapter would also swallow rejections from a
   * consumer's own promise sitting in an opaque leaf, which is their
   * signal to see, not ours to hide.
   */
  it('v4 surfaces it as an ordinary form error', async () => {
    const schema = zV4.object({ pending: zV4.promise(zV4.string()) })
    const result = await schema.safeParseAsync({ pending: undefined })
    expect(result.success).toBe(false)
  })

  it('v3 reports success and defers the verdict onto a rejecting promise', async () => {
    const schema = zV3.object({ pending: zV3.promise(zV3.string()) })
    const result = await schema.safeParseAsync({ pending: undefined })
    expect(result.success).toBe(true)
    if (!result.success) return
    // Handled here so the suite stays clean. In a consumer app nothing
    // handles it, which is the whole point of this pin.
    await expect(result.data.pending as unknown as Promise<string>).rejects.toBeInstanceOf(
      zV3.ZodError
    )
  })
})
