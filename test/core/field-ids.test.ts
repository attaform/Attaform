import { fc } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { ANONYMOUS_FORM_KEY_PREFIX } from '../../src/runtime/core/defaults'
import {
  computeFieldIdentity,
  fieldIdToken,
  readableFormKeyStem,
} from '../../src/runtime/core/field-ids'
import { canonicalizePath } from '../../src/runtime/core/paths'

const emailKey = canonicalizePath(['email']).key
const nameKey = canonicalizePath(['profile', 'name']).key

// A key with an embedded space, built without a literal space in source.
const SPACE = String.fromCharCode(32)
const SPACED_KEY = `My${SPACE}Form`

// Char-loop reference for the stem: each run of characters outside
// `[A-Za-z0-9_-]` becomes one hyphen, then leading and trailing hyphens
// drop by index. No regex does the trim, so it pins the regex form.
function referenceStem(key: string): string {
  let sanitized = ''
  let inUnsafeRun = false
  for (const ch of key) {
    if (/[A-Za-z0-9_-]/.test(ch)) {
      sanitized += ch
      inUnsafeRun = false
    } else if (!inUnsafeRun) {
      sanitized += '-'
      inUnsafeRun = true
    }
  }
  let start = 0
  let end = sanitized.length
  while (start < end && sanitized[start] === '-') start++
  while (end > start && sanitized[end - 1] === '-') end--
  const trimmed = sanitized.slice(start, end)
  return trimmed === '' ? 'atta' : trimmed
}

describe('fieldIdToken', () => {
  it('is deterministic for the same inputs', () => {
    expect(fieldIdToken('v-0', emailKey)).toBe(fieldIdToken('v-0', emailKey))
  })

  it('is a fixed-length base36 token', () => {
    const token = fieldIdToken('v-0', emailKey)
    expect(token).toHaveLength(7)
    expect(token).toMatch(/^[0-9a-z]+$/)
  })

  it('differs across instance ids for the same path (the duplicate-id guard)', () => {
    expect(fieldIdToken('v-0', emailKey)).not.toBe(fieldIdToken('v-1', emailKey))
  })

  it('differs across paths within one instance', () => {
    expect(fieldIdToken('v-0', emailKey)).not.toBe(fieldIdToken('v-0', nameKey))
  })
})

describe('readableFormKeyStem', () => {
  it('passes through an id-safe key unchanged', () => {
    expect(readableFormKeyStem('signup')).toBe('signup')
  })

  it('substitutes the anon stem for synthetic anonymous keys', () => {
    expect(readableFormKeyStem(`${ANONYMOUS_FORM_KEY_PREFIX}7`)).toBe('atta')
  })

  it('substitutes the anon stem for an empty key', () => {
    expect(readableFormKeyStem('')).toBe('atta')
  })

  it('substitutes the anon stem when a key sanitizes to nothing', () => {
    expect(readableFormKeyStem('!!!')).toBe('atta')
  })

  it('replaces unsafe characters and trims dangling separators', () => {
    const stem = readableFormKeyStem(SPACED_KEY)
    expect(stem).toBe('My-Form')
    expect(stem).not.toMatch(/\s/)
  })

  it('always returns an id-safe stem', () => {
    for (const key of ['signup', '', '!!!', SPACED_KEY, 'a.b/c', `${ANONYMOUS_FORM_KEY_PREFIX}3`]) {
      expect(readableFormKeyStem(key)).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })

  it.each([
    ['', 'atta'],
    ['-', 'atta'],
    ['---', 'atta'],
    ['a--', 'a'],
    ['-a-', 'a'],
    ['--a--b--', 'a--b'],
    ['x!!y??', 'x-y'],
  ])('trims %j to %j, as the char-loop reference does', (key, expected) => {
    expect(readableFormKeyStem(key)).toBe(expected)
    expect(referenceStem(key)).toBe(expected)
  })

  it('agrees with the char-loop reference on 20,000 random keys', () => {
    const arbKey = fc.string({ unit: fc.constantFrom('a', '-', '_', SPACE, '!'), maxLength: 16 })
    fc.assert(
      fc.property(arbKey, (key) => {
        expect(readableFormKeyStem(key)).toBe(referenceStem(key))
      }),
      { seed: 704, numRuns: 20_000 }
    )
  })

  // A trailing-trim `-+$` is an unanchored repeat that CodeQL's
  // `js/polynomial-redos` query flags as O(n²) worst-case: a consumer
  // form key with a long internal hyphen run would pin the regex
  // engine. The trailing branch starts only on the character before a
  // run, which keeps every shape below linear.
  it('linearises on a pathological internal hyphen run', () => {
    const pathological = `a${'-'.repeat(1_000_000)}b`
    const t0 = performance.now()
    const stem = readableFormKeyStem(pathological)
    const elapsed = performance.now() - t0
    expect(stem).toBe(pathological)
    expect(elapsed).toBeLessThan(250)
  })

  it.each([
    ['a dash run', '-'.repeat(100_000), 'atta'],
    ['a leading dash run', `${'-'.repeat(100_000)}a`, 'a'],
    ['a trailing dash run', `a${'-'.repeat(100_000)}`, 'a'],
    ['an a- repetition', 'a-'.repeat(50_000), `${'a-'.repeat(49_999)}a`],
  ])('stays linear on %s', (_shape, key, expected) => {
    const t0 = performance.now()
    const stem = readableFormKeyStem(key)
    const elapsed = performance.now() - t0
    expect(stem).toBe(expected)
    expect(elapsed).toBeLessThan(250)
  })
})

describe('computeFieldIdentity', () => {
  it('composes the id from the readable stem and the path token', () => {
    const identity = computeFieldIdentity('v-0', 'signup', emailKey)
    expect(identity.id).toBe(`signup-${fieldIdToken('v-0', emailKey)}`)
  })

  it('suffixes the satellite aria ids onto the field id', () => {
    const { id, aria } = computeFieldIdentity('v-0', 'signup', emailKey)
    expect(aria.errorId).toBe(`${id}-error`)
    expect(aria.descriptionId).toBe(`${id}-description`)
  })

  it('never produces whitespace in any id (the describedby tokenization guard)', () => {
    const { id, aria } = computeFieldIdentity('v-9', SPACED_KEY, nameKey)
    expect(id).not.toMatch(/\s/)
    expect(aria.errorId).not.toMatch(/\s/)
    expect(aria.descriptionId).not.toMatch(/\s/)
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('produces distinct ids for two mounts of the same keyed form', () => {
    const a = computeFieldIdentity('v-0', 'signup', emailKey)
    const b = computeFieldIdentity('v-1', 'signup', emailKey)
    expect(a.id).not.toBe(b.id)
  })

  it('freezes the aria satellite object', () => {
    const { aria } = computeFieldIdentity('v-0', 'signup', emailKey)
    expect(Object.isFrozen(aria)).toBe(true)
  })
})
