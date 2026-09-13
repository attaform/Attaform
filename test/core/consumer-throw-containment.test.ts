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
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { makeMounter } from '../utils/form-harness'

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
  },
] as const

describe.each(ADAPTERS)('consumer code cannot escape into the host app — $name', (adapter) => {
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
        strict: true,
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

  it('a getDisplayState override that throws', async () => {
    await expectContained(async () => {
      const { api } = makeMounter(useForm, adapter.plain(), { getDisplayState: BOOM })()
      muted(() => api.setValue('a', 'x'))
      await drain()
      void api.field?.('a')?.displayState
    })
  })

  // ── schema validators ──

  it.each([
    ['a sync .refine that throws', 'throwingRefine'],
    ['a .transform that throws', 'throwingTransform'],
    ['a z.preprocess that throws', 'throwingPreprocess'],
  ] as const)('%s', async (_label, key) => {
    await expectContained(async () => {
      const { api } = muted(() => makeMounter(useForm, adapter[key](), { strict: true })())
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

  it('a throwing getter survives an array append', async () => {
    await expectContained(async () => {
      const { api } = makeMounter(useForm, adapter.list(), { defaultValues: { xs: [] } })()
      muted(() => api.append('xs', withThrowingGetter({ b: 'q' })))
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
   * Split out from the table above because the two majors differ, and
   * one of them has a limit Attaform cannot close.
   *
   * On v4 it is fully contained. On v3 the strict construction pass
   * runs a sync `safeParse` against the real schema so sync refines and
   * container checks seed at mount. Zod v3 cannot mark an async refine
   * statically (it wraps every predicate in a sync closure), so it
   * discovers one by RUNNING it: `executeRefinement` calls the
   * predicate, sees a Promise come back, and throws "Async refinement
   * encountered during synchronous parse". Attaform catches that throw
   * and retries against a stripped tree, which is the recovery the
   * whole design turns on.
   *
   * The promise the predicate already returned is dropped by Zod before
   * that throw, so when a consumer's async predicate REJECTS there is no
   * reference for Attaform to attach a handler to. It surfaces as one
   * unhandled rejection at mount.
   *
   * Not silently lost, and not closable from here. The same failure is
   * reported properly on the real async validation path, so the leak is
   * a duplicate signal rather than the only one. Closing it would mean
   * pre-stripping every schema containing any `.refine()`, since v3's
   * `containsAsyncRefine` is conservative and cannot tell sync from
   * async, which would drop sync-refine seeding at mount for every form
   * that uses a refinement. That trade is not worth one console entry
   * for a predicate the consumer should not have let throw.
   */
  it('is contained on v4', async () => {
    await expectContained(async () => {
      const schema = zV4.object({
        a: zV4.string().refine(async () => {
          await Promise.resolve()
          throw new Error('consumer boom')
        }),
      })
      const { api } = muted(() => makeMounter(useFormV4, schema, { strict: true })())
      muted(() => api.setValue('a', 'x'))
      const scope = effectScope()
      scope.run(() => api.validate())
      await drain()
      scope.stop()
    })
  })

  it('leaks exactly one rejection from Zod v3 at mount, and nothing else', async () => {
    // Asserted rather than suppressed. The leak is a documented Zod v3
    // limit, so the test states it as an observed fact: if Zod ever
    // stops dropping that promise, or if Attaform starts leaking a
    // SECOND one, this fails and someone reads the note above.
    //
    // The capture also keeps the run clean. `expectContained` cannot be
    // used here for the obvious reason.
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
      muted(() => makeMounter(useFormV3, schema, { strict: true })())
      // A macrotask, not just microtasks: Node emits `unhandledRejection`
      // only after a full turn in which nothing attached a handler, so
      // `drain()`'s microtask pumping never sees it.
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      process.off('unhandledRejection', capture)
      process.on('unhandledRejection', onRejection)
    }
    expect(seen).toHaveLength(1)
    expect(String(seen[0])).toContain('consumer boom')
  })

  it('mounts, stays writable, and still refuses to submit', async () => {
    // The containment that actually matters: whatever Zod drops on the
    // floor, the form works and the failure reaches the channel a
    // consumer reads. Uses a rejecting-by-returning-false predicate so
    // this assertion is not entangled with the leak above.
    const schema = zV3.object({
      a: zV3.string().refine(async () => {
        await Promise.resolve()
        return false
      }, 'nope'),
    })
    const { api } = muted(() => makeMounter(useFormV3, schema, { strict: true })())
    muted(() => api.setValue('a', 'x'))
    await drain()
    expect(api.values.a).toBe('x')

    let submitted = false
    await api.handleSubmit(() => {
      submitted = true
    })()
    // A failing validator is a failed validation, not a successful one.
    expect(submitted).toBe(false)
  })
})
