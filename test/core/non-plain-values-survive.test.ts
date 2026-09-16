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
 * covers the unset walker, which was still enumerating on kinds Attaform
 * already supported. (The schema-fingerprint walkers were the other case;
 * they were deleted along with `AbstractSchema.fingerprint()`, so the
 * enumeration bug they carried went with them.)
 *
 * The fix in each case is the same shape: test whether the value is a
 * plain record, rather than asking whether it is one of the things we
 * thought of.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { canonicalizePath } from '../../src/runtime/core/paths'
import { walkUnsetSentinels } from '../../src/runtime/core/unset-walker'
import { zodV4Adapter } from '../../src/runtime/adapters/zod-v4/adapter'
import type { AbstractSchema } from '../../src/runtime/types/types-api'
import type { GenericForm } from '../../src/runtime/types/types-core'

/** The shape `walkUnsetSentinels` asks for, with no cast at the call site. */
type WalkerSchema = AbstractSchema<GenericForm, GenericForm>

const adapterFor = (schema: z.ZodObject): WalkerSchema =>
  zodV4Adapter(schema)('f', { maxRecursionDepth: 64 })

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
