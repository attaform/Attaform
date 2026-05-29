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

  // The trailing-trim regex used to be `-+$`, an unanchored repeat that
  // CodeQL's `js/polynomial-redos` query flags as O(n²) worst-case.
  // A consumer-supplied form key with a long internal hyphen run would
  // pin the regex engine; the negative-lookbehind form linearises it.
  it('linearises on a pathological internal hyphen run', () => {
    const pathological = `a${'-'.repeat(1_000_000)}b`
    const t0 = performance.now()
    const stem = readableFormKeyStem(pathological)
    const elapsed = performance.now() - t0
    expect(stem).toBe(pathological)
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
