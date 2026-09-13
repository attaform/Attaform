// @vitest-environment jsdom
/**
 * Values that are not plain records must survive every walker whole.
 *
 * The recurring defect is enumeration: a walker lists the built-ins it
 * knows to skip (`Date`, `RegExp`, `Map`, `Set`, functions) and rebuilds
 * everything else key by key. That is closed over the values someone
 * remembered, never over the values that exist, so a `File`, a `Blob`, a
 * `URL`, or any consumer class instance gets flattened into a plain
 * object with its prototype gone. #605 fixed two such walkers; this file
 * covers the two that were still enumerating, both reachable on kinds
 * Attaform already supported before this branch.
 *
 * The fix in each case is the same shape: test whether the value is a
 * plain record, rather than asking whether it is one of the things we
 * thought of.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { z as z3 } from 'zod-v3'
import { canonicalStringify } from '../../src/runtime/core/canonical-stringify'
import { canonicalizePath } from '../../src/runtime/core/paths'
import { zodAdapter as zodV3Adapter } from '../../src/runtime/adapters/zod-v3'
import { walkUnsetSentinels } from '../../src/runtime/core/unset-walker'
import { zodV4Adapter } from '../../src/runtime/adapters/zod-v4/adapter'
import type { AbstractSchema } from '../../src/runtime/types/types-api'
import type { GenericForm } from '../../src/runtime/types/types-core'

/** The shape `walkUnsetSentinels` asks for, with no cast at the call site. */
type WalkerSchema = AbstractSchema<GenericForm, GenericForm>

const adapterFor = (schema: z.ZodObject): WalkerSchema =>
  zodV4Adapter(schema)('f', { maxRecursionDepth: 64 })
const adapterForV3 = (schema: z3.ZodObject<z3.ZodRawShape>) =>
  zodV3Adapter(schema)('f', { maxRecursionDepth: 64 })

describe('canonicalStringify distinguishes Map and Set contents', () => {
  it('does not collapse a Map, a Set and {} to the same string', () => {
    // All three used to serialise as '{}': a Map and a Set keep their
    // contents off the own-property list, so the key walk saw nothing.
    const shapes = [
      canonicalStringify(new Map([['a', 1]])),
      canonicalStringify(new Set(['a'])),
      canonicalStringify({}),
    ]
    expect(new Set(shapes).size).toBe(3)
  })

  it('separates two Maps with different entries and agrees on equal ones', () => {
    expect(canonicalStringify(new Map([['a', 1]]))).not.toBe(
      canonicalStringify(new Map([['b', 9]]))
    )
    expect(canonicalStringify(new Map([['a', 1]]))).toBe(canonicalStringify(new Map([['a', 1]])))
  })

  it('separates two Sets with different members and ignores insertion order', () => {
    expect(canonicalStringify(new Set(['x']))).not.toBe(canonicalStringify(new Set(['y'])))
    // Membership is unordered, so two Sets holding the same members are
    // the same value however they were built.
    expect(canonicalStringify(new Set(['x', 'y']))).toBe(canonicalStringify(new Set(['y', 'x'])))
  })

  it('serialises nested values inside a Map rather than stopping at the entry', () => {
    expect(canonicalStringify(new Map([['a', { n: 1 }]]))).not.toBe(
      canonicalStringify(new Map([['a', { n: 2 }]]))
    )
  })
})

describe('schema fingerprints see through Map and Set defaults', () => {
  it('separates two v3 z.set schemas declaring different defaults', async () => {
    // Live on main before this branch: `z.set()` has always been
    // supported, and its declared default reached the fingerprint
    // through `canonicalStringify`. Two structurally different schemas
    // sharing a form key is the one thing the fingerprint exists to
    // notice, so agreeing here defeated the whole diagnostic.
    const a = adapterForV3(z3.object({ s: z3.set(z3.string()).default(new Set(['x'])) }))
    const b = adapterForV3(z3.object({ s: z3.set(z3.string()).default(new Set(['y'])) }))
    expect(await a.fingerprint()).not.toBe(await b.fingerprint())
  })

  it('still agrees on two v3 schemas declaring the same default', async () => {
    // The counterweight: separating different values must not make
    // equal values disagree, or every form would warn about itself.
    const a = adapterForV3(z3.object({ s: z3.set(z3.string()).default(new Set(['x'])) }))
    const b = adapterForV3(z3.object({ s: z3.set(z3.string()).default(new Set(['x'])) }))
    expect(await a.fingerprint()).toBe(await b.fingerprint())
  })

  it('v4 collapses a rebuilt default to fn:* — a documented, deliberate limit', async () => {
    // Zod v4 rebuilds a heap-allocated default on every read, so the
    // fingerprint's stability guard cannot tell it from a factory that
    // mints a fresh value per call and collapses both to 'fn:*'. That
    // costs a warning it could have raised. Comparing the two reads
    // structurally instead was tried: it leaks a timestamp from
    // `.default(() => new Date())` into the fingerprint and makes the
    // same schema disagree with itself a second later, which is the
    // worse trade. Pinned so the limit stays a decision, not a
    // surprise. See `stableValueRepr` in zod-v4/fingerprint.ts.
    const a = adapterFor(z.object({ s: z.set(z.string()).default(new Set(['x'])) }))
    const b = adapterFor(z.object({ s: z.set(z.string()).default(new Set(['y'])) }))
    expect(await a.fingerprint()).toBe(await b.fingerprint())
    expect(await a.fingerprint()).toContain('fn:*')
  })
})

describe('the unset walker carries non-plain values through whole', () => {
  class Money {
    amount = 5
    nested: unknown = { note: undefined }
    format(): string {
      return `$${this.amount}`
    }
  }

  it('keeps a class instance intact at an opaque leaf', () => {
    // Previously returned `{ amount: 5, nested: {} }`: the prototype was
    // dropped, `format` went with it, and the nested key was silently
    // lost on the rebuild.
    const schema = adapterFor(z.object({ price: z.unknown() }))
    const money = new Money()
    const out = walkUnsetSentinels({ price: money }, schema)
    const read = (out.cleanedValues as { price: unknown }).price
    expect(read).toBe(money)
    expect(read).toBeInstanceOf(Money)
    expect((read as Money).format()).toBe('$5')
  })

  it('keeps a File intact at an opaque leaf', () => {
    const schema = adapterFor(z.object({ doc: z.instanceof(File) }))
    const file = new File(['hello'], 'a.txt', { type: 'text/plain' })
    const out = walkUnsetSentinels({ doc: file }, schema)
    const read = (out.cleanedValues as { doc: unknown }).doc
    expect(read).toBe(file)
    expect(read).toBeInstanceOf(File)
    expect((read as File).name).toBe('a.txt')
  })

  it('keeps a Map intact at a z.map leaf', () => {
    const schema = adapterFor(z.object({ index: z.map(z.string(), z.number()) }))
    const index = new Map([['a', 1]])
    const out = walkUnsetSentinels({ index }, schema)
    const read = (out.cleanedValues as { index: unknown }).index
    expect(read).toBe(index)
    expect((read as Map<string, number>).get('a')).toBe(1)
  })

  it('still descends into plain records and arrays', () => {
    // The counterweight. Carrying non-plain values through must not
    // stop the walker descending into the shapes it exists to walk.
    const schema = adapterFor(z.object({ user: z.object({ name: z.string(), age: z.number() }) }))
    const out = walkUnsetSentinels({ user: { name: 'ada' } }, schema)
    const read = (out.cleanedValues as { user: { name: string; age: number } }).user
    expect(read.name).toBe('ada')
    // `age` was unspecified, so the walker synthesised it from the
    // schema and marked it blank — proof the descent still happens.
    expect(read.age).toBe(0)
    expect(out.paths).toContain(canonicalizePath(['user', 'age']).key)
  })
})
