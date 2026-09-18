// @vitest-environment jsdom
/**
 * Attaform must never be the reason a third-party page goes down.
 *
 * A form library runs a lot of code it did not write. Some of it is
 * handed over deliberately (`onSubmit`, `onError`, `register`
 * transforms) and some of it is embedded in the schema and invoked
 * during Attaform's own walks (`z.lazy(() => ...)`,
 * `.default(() => ...)`, `.catch(() => ...)`). On top of that, every
 * value a consumer writes gets walked, and a property on it can be an
 * accessor that throws.
 *
 * Any of those throwing inside a walk comes out of `useForm(...)` or
 * `setValue(...)` and takes the host component with it. This file is
 * the standing audit for that: every extension point Attaform exposes
 * gets something that throws pushed through it, and the assertion is
 * that nothing escapes, synchronously or as an unhandled rejection.
 *
 * It is written as a table on purpose. A new extension point should
 * arrive as a new row here, because the way this class of gap survives
 * is a guard added where one bug was observed rather than where the
 * class of bug lives: before this suite there were nine call sites
 * invoking consumer schema functions and exactly one of them was
 * guarded, and v3 guarded all three of its introspector entry points
 * while v4 guarded one.
 *
 * Out of scope, deliberately: `InvalidPathError` on `errors('a..b')`
 * and `InvalidUseFormConfigError` / `ReservedFormKeyError` at
 * `useForm`. Those are synchronous throws on direct API misuse at the
 * call site, the same category as a `TypeError` on a bad argument, and
 * they are meant to be loud.
 *
 * One extension point in this class lives in its own file rather than as a
 * row here, because it needs a mounted app and a registry instead of this
 * table's `makeMounter`: a `useWizard({ steps })` function or `lazy()`
 * resolver is consumer code the wizard invokes during its compile pass.
 * See `test/composables/wizard-slot-throw-containment.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { makeMounter } from '../utils/form-harness'
import { spreadConsumerRecord } from '../../src/runtime/core/safe-assign'

/**
 * Stands in for any consumer function. Returns `never`, which is
 * assignable wherever a value is expected, so it drops into
 * `.default()`, `.catch()`, `.refine()`, `.transform()` and
 * `z.lazy()` on both majors with no cast at any call site.
 */
const BOOM = (): never => {
  throw new Error('consumer boom')
}

/** Drain microtasks and Vue ticks so a deferred escape has time to land. */
async function drain(times = 25): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

/**
 * A plain record carrying a throwing accessor.
 *
 * Plain on purpose: a class instance is carried by reference and never
 * walked, so it is not the hazard. The reachable shape is a literal
 * built with `Object.defineProperty`, or a Vue `reactive()` object
 * whose prototype is still `Object.prototype`.
 */
function withThrowingGetter(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const o: Record<string, unknown> = { ...extra }
  Object.defineProperty(o, 'trap', { enumerable: true, get: BOOM })
  return o
}

/**
 * Capture escapes that bypass a `try` entirely. Registered per test and
 * torn down after, so one leaking test cannot be blamed on another.
 */
let escapes: string[]
const onRejection = (e: unknown) => escapes.push(`unhandledRejection: ${String(e)}`)
const onException = (e: unknown) => escapes.push(`uncaughtException: ${String(e)}`)

beforeEach(() => {
  escapes = []
  process.on('unhandledRejection', onRejection)
  process.on('uncaughtException', onException)
})
afterEach(() => {
  process.off('unhandledRejection', onRejection)
  process.off('uncaughtException', onException)
})

/** Run `fn`, asserting nothing escapes synchronously or asynchronously. */
async function expectContained(fn: () => Promise<void> | void): Promise<void> {
  let thrown: unknown = null
  try {
    await fn()
  } catch (err) {
    thrown = err
  }
  await drain()
  expect(thrown, `escaped synchronously: ${String(thrown)}`).toBeNull()
  expect(escapes, 'escaped asynchronously').toEqual([])
}

/** Silence the dev diagnostics the containment paths emit by design. */
function muted<T>(fn: () => T): T {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    return fn()
  } finally {
    warn.mockRestore()
    error.mockRestore()
  }
}

/**
 * Each adapter names its own spelling of the same shapes. Written as
 * factories rather than a shared `z` because a union of the two Zod
 * namespaces has no callable `object` signature, and because the two
 * majors genuinely differ in places (`z.function()`, v3's `ZodEffects`).
 */
const ADAPTERS = [
  {
    name: 'zod v4',
    useForm: useFormV4,
    plain: () => zV4.object({ a: zV4.string() }),
    tooShort: () => zV4.object({ a: zV4.string().min(5) }),
    throwingDefault: () => zV4.object({ a: zV4.string().default(BOOM) }),
    throwingCatch: () => zV4.object({ a: zV4.string().catch(BOOM) }),
    throwingLazy: () => zV4.object({ a: zV4.lazy(BOOM) }),
    brokenAndOk: () => zV4.object({ broken: zV4.string().default(BOOM), ok: zV4.string() }),
    throwingRefine: () => zV4.object({ a: zV4.string().refine(BOOM) }),
    throwingTransform: () => zV4.object({ a: zV4.string().transform(BOOM) }),
    throwingPreprocess: () => zV4.object({ a: zV4.preprocess(BOOM, zV4.string()) }),
    nestedAndOpen: () =>
      zV4.object({ nested: zV4.object({ b: zV4.string() }), open: zV4.unknown() }),
    nestedOnly: () => zV4.object({ nested: zV4.object({ b: zV4.string(), c: zV4.string() }) }),
    bag: () => zV4.object({ bag: zV4.record(zV4.string(), zV4.unknown()) }),
    list: () => zV4.object({ xs: zV4.array(zV4.object({ b: zV4.string() })) }),
    openList: () => zV4.object({ xs: zV4.array(zV4.unknown()) }),
    openVariant: () =>
      zV4.object({
        src: zV4.discriminatedUnion('k', [
          zV4.object({ k: zV4.literal('a'), x: zV4.unknown() }),
          zV4.object({ k: zV4.literal('b'), y: zV4.string() }),
        ]),
      }),
  },
  {
    name: 'zod v3',
    useForm: useFormV3,
    plain: () => zV3.object({ a: zV3.string() }),
    tooShort: () => zV3.object({ a: zV3.string().min(5) }),
    throwingDefault: () => zV3.object({ a: zV3.string().default(BOOM) }),
    throwingCatch: () => zV3.object({ a: zV3.string().catch(BOOM) }),
    throwingLazy: () => zV3.object({ a: zV3.lazy(BOOM) }),
    brokenAndOk: () => zV3.object({ broken: zV3.string().default(BOOM), ok: zV3.string() }),
    throwingRefine: () => zV3.object({ a: zV3.string().refine(BOOM) }),
    throwingTransform: () => zV3.object({ a: zV3.string().transform(BOOM) }),
    throwingPreprocess: () => zV3.object({ a: zV3.preprocess(BOOM, zV3.string()) }),
    nestedAndOpen: () =>
      zV3.object({ nested: zV3.object({ b: zV3.string() }), open: zV3.unknown() }),
    nestedOnly: () => zV3.object({ nested: zV3.object({ b: zV3.string(), c: zV3.string() }) }),
    bag: () => zV3.object({ bag: zV3.record(zV3.string(), zV3.unknown()) }),
    list: () => zV3.object({ xs: zV3.array(zV3.object({ b: zV3.string() })) }),
    openList: () => zV3.object({ xs: zV3.array(zV3.unknown()) }),
    openVariant: () =>
      zV3.object({
        src: zV3.discriminatedUnion('k', [
          zV3.object({ k: zV3.literal('a'), x: zV3.unknown() }),
          zV3.object({ k: zV3.literal('b'), y: zV3.string() }),
        ]),
      }),
  },
] as const

describe.each(ADAPTERS)('consumer code cannot escape into the host app: $name', (adapter) => {
  const { useForm } = adapter

  // ── schema-embedded functions Attaform invokes during its own walks ──

  it('a .default(() => ...) factory that throws', async () => {
    // The sharpest one: this runs inside the blank-derivation walk that
    // `useForm(...)` awaits, so an escape kills component setup.
    await expectContained(() =>
      muted(() => {
        const { api } = makeMounter(useForm, adapter.throwingDefault(), {})()
        void api.values.a
      })
    )
  })

  it('a .catch(() => ...) fallback that throws', async () => {
    await expectContained(() =>
      muted(() => {
        const { api } = makeMounter(useForm, adapter.throwingCatch(), {})()
        void api.values.a
      })
    )
  })

  it('a z.lazy(() => ...) factory that throws', async () => {
    await expectContained(() =>
      muted(() => {
        const { api } = makeMounter(useForm, adapter.throwingLazy(), {})()
        void api.values.a
      })
    )
  })

  it('a throwing factory still leaves the rest of the form usable', () => {
    // Containment that produces a dead form is not containment. The
    // contained field reads as absent, the way a field the schema never
    // described does, and its siblings are untouched.
    const { api } = muted(() =>
      makeMounter(useForm, adapter.brokenAndOk(), { defaultValues: { ok: 'fine' } })()
    )
    expect(api.values.broken).toBeUndefined()
    expect(api.values.ok).toBe('fine')
    muted(() => api.setValue('ok', 'still writable'))
    expect(api.values.ok).toBe('still writable')
  })

  // ── consumer callbacks the runtime invokes on purpose ──

  it('an onSubmit that throws', async () => {
    await expectContained(async () => {
      const { api } = makeMounter(useForm, adapter.plain(), {})()
      await api.handleSubmit(BOOM)()
    })
  })

  it('an onError that throws', async () => {
    await expectContained(async () => {
      const { api } = makeMounter(useForm, adapter.tooShort(), {
        defaultValues: { a: '' },
      })()
      await api.handleSubmit(() => {}, BOOM)()
    })
  })

  it('a register transform that throws', async () => {
    await expectContained(async () => {
      const { api } = makeMounter(useForm, adapter.plain(), {})()
      const scope = effectScope()
      muted(() => {
        scope.run(() => api.register('a', { transforms: [BOOM] }))
        api.setValue('a', 'x')
      })
      await drain()
      scope.stop()
    })
  })

  it('a defaultValues function that throws', async () => {
    await expectContained(() =>
      muted(() => {
        makeMounter(useForm, adapter.plain(), { defaultValues: BOOM })()
      })
    )
  })

  // ── schema validators ──

  it.each([
    ['a sync .refine that throws', 'throwingRefine'],
    ['a .transform that throws', 'throwingTransform'],
    ['a z.preprocess that throws', 'throwingPreprocess'],
  ] as const)('%s', async (_label, key) => {
    await expectContained(async () => {
      const { api } = muted(() => makeMounter(useForm, adapter[key]())())
      muted(() => api.setValue('a', 'x'))
      const scope = effectScope()
      scope.run(() => api.validate())
      await drain()
      scope.stop()
    })
  })

  // ── consumer VALUES with hostile accessors ──

  it.each([
    [
      'setValue at an object path',
      (api: { setValue: (p: string, v: unknown) => unknown }) =>
        api.setValue('nested', withThrowingGetter({ b: 'ok' })),
    ],
    [
      'setValue at an opaque leaf',
      (api: { setValue: (p: string, v: unknown) => unknown }) =>
        api.setValue('open', withThrowingGetter()),
    ],
  ])('a throwing getter survives %s', async (_label, act) => {
    await expectContained(async () => {
      const { api } = makeMounter(useForm, adapter.nestedAndOpen(), {})()
      muted(() => act(api as { setValue: (p: string, v: unknown) => unknown }))
      await drain()
      void api.meta.dirty
    })
  })

  it('a throwing getter survives mount, whole-form write, reset and submit', async () => {
    await expectContained(async () => {
      const { api } = muted(() =>
        makeMounter(useForm, adapter.nestedOnly(), {
          defaultValues: { nested: withThrowingGetter({ b: 'x' }) },
        })()
      )
      muted(() => api.setValue({ nested: withThrowingGetter({ b: 'y' }) }))
      await drain()
      muted(() => api.reset({ nested: withThrowingGetter({ b: 'z' }) }))
      await drain()
      await api.handleSubmit(() => {})()
    })
  })

  it.each([
    ['has', () => new Proxy({ a: 1 }, { has: BOOM })],
    ['get', () => new Proxy({ a: 1 }, { get: BOOM })],
  ])('a Proxy whose %s trap throws survives a read BY PATH through it', async (_l, makeProxy) => {
    // The distinct hazard from the block below: there the proxy is read
    // whole by a walker, here a path descends INTO it. `form.values(path)`
    // and `form.fields(path).value` are the two surfaces a template binds,
    // so a throw on this route comes out of the component's render.
    await expectContained(async () => {
      const { api } = makeMounter(useForm, adapter.nestedAndOpen(), {})()
      muted(() => api.setValue('open', makeProxy()))
      await drain()
      muted(() => api.values('open.a'))
      muted(() => api.values('open'))
      void api.meta.dirty
    })
  })

  it('a throwing getter survives an array append', async () => {
    await expectContained(async () => {
      const { api } = makeMounter(useForm, adapter.list(), { defaultValues: { xs: [] } })()
      muted(() => api.append('xs', withThrowingGetter({ b: 'q' })))
      await drain()
    })
  })

  it.each([
    ['ownKeys', () => new Proxy({ a: 1 }, { ownKeys: BOOM })],
    ['getOwnPropertyDescriptor', () => new Proxy({ a: 1 }, { getOwnPropertyDescriptor: BOOM })],
    ['get', () => new Proxy({ a: 1 }, { get: BOOM })],
    // `has` is the trap a read DESCENT hits: `descendStep` presence-tests
    // each segment with `key in container` before reading it, deliberately
    // (on a reactive array that tracks one index instead of `.length`).
    // An existence check is no safer than a read, and this one runs under
    // every FieldState rollup: that is, during the host's render.
    ['has', () => new Proxy({ a: 1 }, { has: BOOM })],
  ])('a Proxy whose %s trap throws', async (_label, makeProxy) => {
    // Enumeration is not a safe read. `Object.keys` invokes `ownKeys`
    // and `getOwnPropertyDescriptor`, so a Proxy can throw before a
    // single property has been touched, which no amount of per-key
    // guarding would catch. Vue's `reactive()` returns a Proxy, so this
    // is not a hypothetical shape to meet in form state.
    await expectContained(async () => {
      const { api } = makeMounter(useForm, adapter.nestedAndOpen(), {})()
      muted(() => api.setValue('open', makeProxy()))
      await drain()
      void api.meta.dirty
      await api.handleSubmit(() => {})()
    })
  })

  it('an array whose index is a throwing accessor', async () => {
    // An index can be an accessor just as a key can, and `slice()`
    // reads every one of them.
    await expectContained(async () => {
      const { api } = makeMounter(useForm, adapter.openList(), { defaultValues: { xs: [] } })()
      const arr: unknown[] = []
      Object.defineProperty(arr, '0', { enumerable: true, configurable: true, get: BOOM })
      Object.defineProperty(arr, 'length', { value: 1, writable: true })
      muted(() => api.setValue('xs', arr))
      await drain()
      void api.meta.dirty
    })
  })

  it('a throwing getter survives a discriminated-union variant switch', async () => {
    await expectContained(async () => {
      const { api } = makeMounter(useForm, adapter.openVariant(), {
        defaultValues: { src: { k: 'a' } },
      })()
      muted(() => api.setValue('src.x', withThrowingGetter({ b: 1 })))
      await drain()
      muted(() => api.setValue('src.k', 'b'))
      await drain()
      muted(() => api.setValue('src.k', 'a'))
      await drain()
    })
  })

  it('guarding the read does not stop ordinary keys being walked', async () => {
    // The counterweight. A guard that silently dropped every key would
    // pass every containment test above and break the library.
    const { api } = makeMounter(useForm, adapter.nestedOnly(), {})()
    api.setValue('nested', { b: 'kept', c: 'also kept' })
    await nextTick()
    const read = api.values.nested as { b: string; c: string }
    expect(read.b).toBe('kept')
    expect(read.c).toBe('also kept')
  })

  it('a hostile object keeps its ordinary keys where the schema allows them', async () => {
    // Same counterweight, this time WITH the throwing accessor present.
    // It needs an open container: on a closed `z.object` the extra
    // `trap` key is rejected as a typo by the write gate, which is
    // correct and unrelated to the accessor.
    const { api } = makeMounter(useForm, adapter.bag(), { defaultValues: { bag: {} } })()
    muted(() => api.setValue('bag', withThrowingGetter({ b: 'kept', c: 'also kept' })))
    await nextTick()
    const read = api.values.bag as { b: string; c: string }
    expect(read.b).toBe('kept')
    expect(read.c).toBe('also kept')
  })
})

describe('an async .refine that throws', () => {
  /**
   * Split out from the table above because closing this one needed a
   * different mechanism, and because the reasoning is worth keeping.
   *
   * Zod v3 cannot mark an async refinement statically: it wraps every
   * predicate in a sync closure: so it discovers one by RUNNING it.
   * `executeRefinement` calls the predicate, sees a Promise come back,
   * throws "Async refinement encountered during synchronous parse", and
   * discards that promise on the way out. A predicate that REJECTS
   * therefore surfaced as an unhandled rejection in the host app, from
   * a parse the consumer never asked for, at mount, on `reset()`, and
   * on every discriminated-union variant switch.
   *
   * There is nothing for Attaform to catch, because the promise never
   * reaches Attaform. `wrapAsyncSafeRefinements` makes it reachable:
   * before any sync parse it rebuilds each `ZodEffects` with a
   * refinement that calls the original, attaches a no-op `catch` when
   * the result is thenable, and returns that same result. Zod still
   * sees a Promise, still throws its sync-detect error, and the strip
   * recovery still runs; the promise is simply no longer unowned.
   *
   * The alternative considered and rejected was pre-stripping every
   * schema containing any `.refine()`, since v3's `containsAsyncRefine`
   * is conservative. That would have dropped sync-refine seeding at
   * mount for every form using a refinement, which the last two tests
   * here exist to protect.
   */
  it('is contained on v4', async () => {
    await expectContained(async () => {
      const schema = zV4.object({
        a: zV4.string().refine(async () => {
          await Promise.resolve()
          throw new Error('consumer boom')
        }),
      })
      const { api } = muted(() => makeMounter(useFormV4, schema)())
      muted(() => api.setValue('a', 'x'))
      const scope = effectScope()
      scope.run(() => api.validate())
      await drain()
      scope.stop()
    })
  })

  it.each([
    [
      'at mount',
      async (_api: unknown) => {
        await Promise.resolve()
      },
    ],
    [
      'on reset()',
      async (api: { reset: () => unknown }) => {
        muted(() => api.reset())
        await drain()
      },
    ],
  ] as const)('is contained on v3 %s', async (_label, act) => {
    // Every one of these leaked before `wrapAsyncSafeRefinements`.
    // A macrotask is required: Node emits `unhandledRejection` only
    // after a full turn in which nothing attached a handler, so
    // microtask pumping alone never sees one.
    const seen: unknown[] = []
    const capture = (e: unknown) => seen.push(e)
    process.off('unhandledRejection', onRejection)
    process.on('unhandledRejection', capture)
    try {
      const schema = zV3.object({
        a: zV3.string().refine(async () => {
          await Promise.resolve()
          throw new Error('consumer boom')
        }),
      })
      const { api } = muted(() => makeMounter(useFormV3, schema)())
      await act(api)
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      process.off('unhandledRejection', capture)
      process.on('unhandledRejection', onRejection)
    }
    expect(seen).toEqual([])
  })

  it('is contained on v3 across a discriminated-union variant switch', async () => {
    const seen: unknown[] = []
    const capture = (e: unknown) => seen.push(e)
    process.off('unhandledRejection', onRejection)
    process.on('unhandledRejection', capture)
    try {
      const schema = zV3.object({
        src: zV3.discriminatedUnion('k', [
          zV3.object({
            k: zV3.literal('a'),
            x: zV3.string().refine(async () => {
              await Promise.resolve()
              throw new Error('consumer boom')
            }),
          }),
          zV3.object({ k: zV3.literal('b'), y: zV3.string() }),
        ]),
      })
      const { api } = muted(() =>
        makeMounter(useFormV3, schema, {
          validateOn: 'change',
          defaultValues: { src: { k: 'a' } },
        })()
      )
      await drain()
      muted(() => api.setValue('src.k', 'b'))
      await nextTick()
      muted(() => api.setValue('src.k', 'a'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      process.off('unhandledRejection', capture)
      process.on('unhandledRejection', onRejection)
    }
    expect(seen).toEqual([])
  })

  it('still seeds a SYNC refine error at mount', async () => {
    // The counterweight the whole mechanism was chosen to protect.
    // Pre-stripping every schema with a refinement would have closed
    // the leak and broken this.
    const schema = zV3.object({ a: zV3.string().refine((v) => v.length > 3, 'too short') })
    const { api } = makeMounter(useFormV3, schema, { defaultValues: { a: 'x' } })()
    await drain()
    expect(api.errors('a')[0]?.message).toBe('too short')
  })

  it('still reports an async refine through validation', async () => {
    // The other counterweight: wrapping must not swallow the verdict,
    // only the orphaned promise.
    const schema = zV3.object({
      a: zV3.string().refine(async (v: string) => {
        await Promise.resolve()
        return v.length > 3
      }, 'too short'),
    })
    const { api } = makeMounter(useFormV3, schema, { defaultValues: { a: 'x' } })()
    await drain()
    let submitted = false
    await api.handleSubmit(() => {
      submitted = true
    })()
    expect(submitted).toBe(false)
    expect(api.errors('a')[0]?.message).toBe('too short')
  })
})

describe('spreadConsumerRecord matches the spread it stands in for', () => {
  /**
   * The guarded fallback only runs for an object that already threw, so
   * nothing else exercises it. These pin the two ways it could quietly
   * diverge from `{ ...src }`, both of which it did before review.
   */
  const hostile = (extra: Record<string, unknown>) => {
    const o: Record<string, unknown> = { ...extra }
    Object.defineProperty(o, 'trap', { enumerable: true, get: BOOM })
    return o
  }

  it('takes the spread fast path for a well-behaved object', () => {
    const src = { a: 1, b: 2 }
    expect(spreadConsumerRecord(src)).toEqual({ a: 1, b: 2 })
  })

  it('keeps a key whose value is explicitly undefined', () => {
    // `{ ...{ a: undefined } }` keeps the key. The runtime reads an
    // explicit `undefined` at a key as "the consumer named this slot
    // empty", so dropping it would change the shape rather than just
    // the value.
    const out = spreadConsumerRecord(hostile({ a: undefined, b: 1 }))
    expect('a' in out).toBe(true)
    expect(out['a']).toBeUndefined()
    expect(out['b']).toBe(1)
  })

  it('lands a literal __proto__ key as an own data property', () => {
    // The spread uses `CreateDataProperty` and so bypasses the
    // inherited `__proto__` setter. A plain `out[key] = value` in the
    // fallback would reassign the prototype chain instead.
    //
    // Built with `defineProperty`, not a literal: `{ __proto__: x }` is
    // special syntax that sets the prototype rather than creating an
    // own key, so the literal form would not test anything.
    const src = hostile({ ok: 1 })
    Object.defineProperty(src, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      writable: true,
      configurable: true,
    })

    const out = spreadConsumerRecord(src)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(Object.hasOwn(out, '__proto__')).toBe(true)
    const witness: Record<string, unknown> = {}
    expect(witness['polluted']).toBeUndefined()
    expect(out['ok']).toBe(1)
  })

  it('reads a throwing accessor as undefined rather than propagating', () => {
    const out = spreadConsumerRecord(hostile({ ok: 1 }))
    expect(out['ok']).toBe(1)
    expect(out['trap']).toBeUndefined()
  })
})
