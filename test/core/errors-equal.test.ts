import { describe, expect, it } from 'vitest'
import { errorsEqual } from '../../src/runtime/core/history'
import type { PathKey } from '../../src/runtime/core/paths'
import type { ValidationError } from '../../src/runtime/types/types-api'

/**
 * Direct coverage for history.ts's `errorsEqual` — the snapshot-delta
 * equality check used to decide whether an undo/redo step needs to
 * record an error change. It was previously exercised only transitively
 * through the history suites, where ValidationError objects pass by
 * reference and the `av === bvi` identity short-circuit meant the
 * field-by-field fallback almost never ran. These cases construct
 * reference-distinct-but-field-equal errors to drive that fallback and
 * every mismatch branch.
 */
const k = (s: string): PathKey => s as PathKey

const err = (over: Partial<ValidationError> = {}): ValidationError => ({
  message: 'taken',
  code: 'api:duplicate',
  formKey: 'f',
  path: ['email'],
  ...over,
})

type Entries = ReadonlyArray<readonly [PathKey, ValidationError[]]>

describe('errorsEqual — outer structure', () => {
  it('two empty entry lists are equal', () => {
    expect(errorsEqual([], [])).toBe(true)
  })

  it('differing list lengths are unequal', () => {
    expect(errorsEqual([[k('email'), [err()]]], [])).toBe(false)
  })

  it('a key present in a but missing in b is unequal', () => {
    const a: Entries = [[k('email'), [err()]]]
    const b: Entries = [[k('username'), [err()]]]
    expect(errorsEqual(a, b)).toBe(false)
  })

  it('same key with different per-entry counts is unequal', () => {
    const a: Entries = [[k('email'), [err(), err()]]]
    const b: Entries = [[k('email'), [err()]]]
    expect(errorsEqual(a, b)).toBe(false)
  })

  it('key order does not matter (map-based lookup)', () => {
    const a: Entries = [
      [k('email'), [err()]],
      [k('username'), [err()]],
    ]
    const b: Entries = [
      [k('username'), [err()]],
      [k('email'), [err()]],
    ]
    expect(errorsEqual(a, b)).toBe(true)
  })
})

describe('errorsEqual — per-entry field compare (the fallback past the identity short-circuit)', () => {
  it('the same ValidationError reference short-circuits to equal', () => {
    const shared = err()
    expect(errorsEqual([[k('email'), [shared]]], [[k('email'), [shared]]])).toBe(true)
  })

  it('reference-distinct but field-equal entries are equal', () => {
    const a: Entries = [[k('email'), [err()]]]
    const b: Entries = [[k('email'), [err()]]]
    expect(errorsEqual(a, b)).toBe(true)
  })

  it('a differing message is unequal', () => {
    const a: Entries = [[k('email'), [err({ message: 'taken' })]]]
    const b: Entries = [[k('email'), [err({ message: 'in use' })]]]
    expect(errorsEqual(a, b)).toBe(false)
  })

  it('a differing code is unequal', () => {
    const a: Entries = [[k('email'), [err({ code: 'api:a' })]]]
    const b: Entries = [[k('email'), [err({ code: 'api:b' })]]]
    expect(errorsEqual(a, b)).toBe(false)
  })

  it('a differing formKey is unequal', () => {
    const a: Entries = [[k('email'), [err({ formKey: 'one' })]]]
    const b: Entries = [[k('email'), [err({ formKey: 'two' })]]]
    expect(errorsEqual(a, b)).toBe(false)
  })
})

describe('errorsEqual — path compare', () => {
  it('the same path array reference skips the element loop', () => {
    const path = ['address', 'line1']
    const a: Entries = [[k('address.line1'), [err({ path })]]]
    const b: Entries = [[k('address.line1'), [err({ path })]]]
    expect(errorsEqual(a, b)).toBe(true)
  })

  it('differing path lengths are unequal', () => {
    const a: Entries = [[k('a'), [err({ path: ['a'] })]]]
    const b: Entries = [[k('a'), [err({ path: ['a', 'b'] })]]]
    expect(errorsEqual(a, b)).toBe(false)
  })

  it('equal length but a differing element is unequal', () => {
    const a: Entries = [[k('a'), [err({ path: ['a', 'b'] })]]]
    const b: Entries = [[k('a'), [err({ path: ['a', 'c'] })]]]
    expect(errorsEqual(a, b)).toBe(false)
  })

  it('distinct path arrays with equal elements (incl. numeric) are equal', () => {
    const a: Entries = [[k('items.0.name'), [err({ path: ['items', 0, 'name'] })]]]
    const b: Entries = [[k('items.0.name'), [err({ path: ['items', 0, 'name'] })]]]
    expect(errorsEqual(a, b)).toBe(true)
  })
})
