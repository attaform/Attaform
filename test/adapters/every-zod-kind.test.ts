// @vitest-environment jsdom
/**
 * Attaform accepts every Zod kind.
 *
 * Five kinds were refused at adapter construction: `z.promise`,
 * `z.function`, `z.map`, `z.symbol`, and (v4 only) `z.templateLiteral`.
 * The stated reasons did not survive contact with the principle that a
 * public library cannot predict its consumers' use cases. A Map has an
 * obvious form encoding, a template literal is a string, and a symbol
 * or a callback is the developer's call to make: if they want to
 * serialise it before it crosses the wire in `handleSubmit`, that is
 * their business, not the adapter's.
 *
 * The whole construction-time audit is gone with them. It also raised
 * AF03 for any kind it had never heard of, which made a future Zod
 * minor a mount-time crash for anyone using the new kind. Every
 * downstream walker already has a permissive fallback, so an unknown
 * kind is now carried opaquely instead of refused.
 *
 * Every case runs against both majors. v3 has no `z.templateLiteral`,
 * so that row is v4-only and marked as such.
 */
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { makeMounter } from '../utils/form-harness'

/**
 * `validate()` hands back a status ref that starts pending. Drain
 * microtasks plus Vue ticks until the parse settles.
 */
async function settle(status: { value: { pending: boolean } }) {
  for (let i = 0; i < 20 && status.value.pending; i++) {
    await Promise.resolve()
    await nextTick()
  }
  expect(status.value.pending).toBe(false)
  return status.value as { pending: boolean; success: boolean }
}

/** Capture `console.warn` for the length of `fn`. */
function withWarnings(fn: () => void): string[] {
  const warns: string[] = []
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(args.map(String).join(' '))
  })
  try {
    fn()
  } finally {
    spy.mockRestore()
  }
  return warns
}

const ADAPTERS = [
  {
    name: 'zod v4',
    useForm: useFormV4,
    mapScalar: () => zV4.object({ index: zV4.map(zV4.string(), zV4.number()) }),
    symbolScalar: () => zV4.object({ tag: zV4.symbol() }),
    fnScalar: () => zV4.object({ cb: zV4.function() }),
    promiseScalar: () => zV4.object({ pending: zV4.promise(zV4.string()) }),
    mixed: () =>
      zV4.object({
        name: zV4.string(),
        index: zV4.map(zV4.string(), zV4.number()),
        tag: zV4.symbol(),
        cb: zV4.function(),
      }),
    mapVariant: () =>
      zV4.object({
        src: zV4.discriminatedUnion('kind', [
          zV4.object({ kind: zV4.literal('lookup'), index: zV4.map(zV4.string(), zV4.number()) }),
          zV4.object({ kind: zV4.literal('plain'), url: zV4.string() }),
        ]),
      }),
  },
  {
    name: 'zod v3',
    useForm: useFormV3,
    mapScalar: () => zV3.object({ index: zV3.map(zV3.string(), zV3.number()) }),
    symbolScalar: () => zV3.object({ tag: zV3.symbol() }),
    fnScalar: () => zV3.object({ cb: zV3.function() }),
    promiseScalar: () => zV3.object({ pending: zV3.promise(zV3.string()) }),
    mixed: () =>
      zV3.object({
        name: zV3.string(),
        index: zV3.map(zV3.string(), zV3.number()),
        tag: zV3.symbol(),
        cb: zV3.function(),
      }),
    mapVariant: () =>
      zV3.object({
        src: zV3.discriminatedUnion('kind', [
          zV3.object({ kind: zV3.literal('lookup'), index: zV3.map(zV3.string(), zV3.number()) }),
          zV3.object({ kind: zV3.literal('plain'), url: zV3.string() }),
        ]),
      }),
  },
] as const

describe.each(ADAPTERS)('every Zod kind — $name', (adapter) => {
  // ── construction ──────────────────────────────────────────────────

  it.each(['mapScalar', 'symbolScalar', 'fnScalar', 'promiseScalar'] as const)(
    'mounts a form whose leaf is %s',
    (key) => {
      expect(() => makeMounter(adapter.useForm, adapter[key](), {})()).not.toThrow()
    }
  )

  // ── derived blanks ────────────────────────────────────────────────

  it('seeds an empty Map at a z.map leaf', () => {
    const { api } = makeMounter(adapter.useForm, adapter.mapScalar(), {})()
    const seeded = api.values.index
    expect(seeded).toBeInstanceOf(Map)
    expect((seeded as Map<string, number>).size).toBe(0)
  })

  it.each([
    ['symbolScalar', 'tag'],
    ['fnScalar', 'cb'],
    ['promiseScalar', 'pending'],
  ] as const)('leaves %s absent — no canonical empty member to seed', (key, path) => {
    // There is no empty Promise and no empty function, and `Symbol()`
    // mints a fresh value on every call: seeding one would make the
    // derived blank non-deterministic and break reference stability
    // between two structurally identical schemas.
    const { api } = makeMounter(adapter.useForm, adapter[key](), {})()
    expect(api.values[path]).toBeUndefined()
  })

  // ── the value round-trip ──────────────────────────────────────────

  it('carries a Map through setValue by identity', () => {
    const { api } = makeMounter(adapter.useForm, adapter.mapScalar(), {})()
    const index = new Map([['a', 1]])
    const warns = withWarnings(() => api.setValue('index', index))
    const read = api.values.index as Map<string, number>
    expect(warns).toEqual([])
    expect(read).toBeInstanceOf(Map)
    expect(read.get('a')).toBe(1)
    expect(read.size).toBe(1)
  })

  it('carries a symbol through setValue by identity', () => {
    const { api } = makeMounter(adapter.useForm, adapter.symbolScalar(), {})()
    const tag = Symbol('order-id')
    const warns = withWarnings(() => api.setValue('tag', tag))
    expect(warns).toEqual([])
    // Identity, not description: two symbols with the same description
    // are different values, and the consumer keyed something on this one.
    expect(api.values.tag).toBe(tag)
  })

  it('carries a function through setValue by identity', () => {
    const { api } = makeMounter(adapter.useForm, adapter.fnScalar(), {})()
    const cb = () => 'called'
    const warns = withWarnings(() => api.setValue('cb', cb))
    expect(warns).toEqual([])
    // Storage keeps what the consumer wrote. Zod's own `parse` returns
    // a validating WRAPPER for `z.function()` on both majors, so the
    // post-parse view legitimately differs; storage is the input view.
    expect(api.values.cb).toBe(cb)
    expect((api.values.cb as () => string)()).toBe('called')
  })

  it('still reads a function as an updater at a non-function path', () => {
    // The counterweight to the rule above. `setValue(path, fn)` is the
    // functional-update overload everywhere the schema does not
    // specifically declare a function, and that must not change.
    const { api } = makeMounter(adapter.useForm, adapter.mixed(), {
      defaultValues: { name: 'ada' },
    })()
    api.setValue('name', (prev: unknown) => `${String(prev)}!`)
    expect(api.values.name).toBe('ada!')
  })

  it('carries a Promise through setValue by identity', () => {
    const { api } = makeMounter(adapter.useForm, adapter.promiseScalar(), {})()
    const pending = Promise.resolve('done')
    const warns = withWarnings(() => api.setValue('pending', pending))
    expect(warns).toEqual([])
    expect(api.values.pending).toBe(pending)
  })

  // ── the walkers must not flatten them ─────────────────────────────

  it('survives a discriminated-union variant round-trip', async () => {
    // The variant-memory cloner rebuilds a stored object key by key.
    // A Map's entries are not own enumerable properties, so a key-by-key
    // rebuild returns `{}` — the same defect #605 fixed for File.
    const { api } = makeMounter(adapter.useForm, adapter.mapVariant(), {
      defaultValues: { src: { kind: 'lookup', index: new Map() } },
    })()
    const index = new Map([['a', 1]])
    api.setValue('src.index', index)
    await nextTick()

    api.setValue('src.kind', 'plain')
    await nextTick()
    api.setValue('src.kind', 'lookup')
    await nextTick()

    const restored = api.values.src as { index: Map<string, number> }
    expect(restored.index).toBeInstanceOf(Map)
    expect(restored.index.get('a')).toBe(1)
  })

  it('carries every kind through handleSubmit together', async () => {
    const tag = Symbol('order-id')
    const cb = () => 1
    const index = new Map([['a', 1]])
    const { api } = makeMounter(adapter.useForm, adapter.mixed(), {
      defaultValues: { name: 'ada', index, tag, cb },
    })()

    type Submitted = { name: string; index: Map<string, number>; tag: symbol; cb: unknown }
    let seen: Submitted | undefined
    await api.handleSubmit((data: unknown) => {
      seen = data as Submitted
    })()

    expect(seen?.name).toBe('ada')
    expect(seen?.index).toBeInstanceOf(Map)
    expect(seen?.index.get('a')).toBe(1)
    expect(seen?.tag).toBe(tag)
    // `cb` is a validating wrapper Zod built around the consumer's
    // function, so identity is not preserved through a parse. It must
    // still be callable.
    expect(typeof seen?.cb).toBe('function')
  })

  it('validates a Map leaf against its key and value schemas', async () => {
    const { api } = makeMounter(adapter.useForm, adapter.mapScalar(), { strict: true })()

    api.setValue('index', new Map([['a', 1]]))
    expect((await settle(api.validate())).success).toBe(true)

    // A wrong value type inside the Map is the schema's business, and
    // it has to actually fire — otherwise the kind is only nominally
    // supported.
    api.setValue('index', new Map([['a', 'not-a-number']]) as unknown as Map<string, number>)
    expect((await settle(api.validate())).success).toBe(false)
  })

  it('still rejects a write to a path the schema genuinely lacks', () => {
    // The counterweight. Accepting every kind must not accept every
    // path, or the diagnostic that catches `register('addr.zipp')`
    // stops firing.
    const { api } = makeMounter(adapter.useForm, adapter.mapScalar(), {})()
    const warns = withWarnings(() => api.setValue('indexx' as 'index', new Map()))
    expect(warns.join('\n')).toContain('not in your schema')
  })
})

describe('setValue at an opaque leaf keeps the updater overload', () => {
  // `z.any()` / `z.unknown()` / `z.custom()` resolve to the PERMISSIVE
  // accept set, which contains every kind including 'function'. A bare
  // "does this path accept a function" check would silently drop the
  // updater overload at every opaque leaf, so the rule excludes them.
  it.each([
    ['zod v4', useFormV4, zV4.object({ v: zV4.any() })],
    ['zod v3', useFormV3, zV3.object({ v: zV3.any() })],
  ] as const)('%s', (_name, useForm, schema) => {
    const { api } = makeMounter(useForm, schema, { defaultValues: { v: 1 } })()
    api.setValue('v', (prev: unknown) => (prev as number) + 1)
    expect(api.values.v).toBe(2)
  })
})

describe('every Zod kind — zod v4 only', () => {
  it('mounts a z.templateLiteral leaf and seeds the string blank', () => {
    // A template literal parses strings against a pattern, so `''` is
    // its blank. It need not satisfy the pattern, exactly as `''` does
    // not satisfy `z.string().min(5)`.
    const schema = zV4.object({ greeting: zV4.templateLiteral(['hello ', zV4.string()]) })
    const { api } = makeMounter(useFormV4, schema, {})()
    expect(api.values.greeting).toBe('')
  })

  it('accepts a conforming string and rejects a non-conforming one', async () => {
    const schema = zV4.object({ greeting: zV4.templateLiteral(['hello ', zV4.string()]) })
    const { api } = makeMounter(useFormV4, schema, { strict: true })()

    api.setValue('greeting', 'hello world')
    expect((await settle(api.validate())).success).toBe(true)

    api.setValue('greeting', 'goodbye world')
    expect((await settle(api.validate())).success).toBe(false)
  })
})
