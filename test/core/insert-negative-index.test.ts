// @vitest-environment jsdom
/**
 * PASS2-6 — `field-arrays.ts:insert` recorded `op.index` against the
 * POST-splice length, not the pre-splice length. For a negative
 * `index` argument, JS `splice` normalises against PRE-splice length
 * (e.g. `-1` on length-2 → position 1), but the recorded
 * `arrayOp.index` was the SAME `index` clamped to `[0, postLen]`,
 * yielding `0` for the negative case. Downstream consumers
 * (`applyArrayOpToMemory`, `arrayIdentity.applyOp`, `remapForOp`)
 * then operated on the wrong slot — variant memory was cleared at
 * index 0 (where nothing happened), and the identity-token list got
 * its splice at index 0 (clobbering the unchanged head element's
 * token instead of the actual new arrival's slot).
 *
 * The fix computes the insertion index BEFORE splice using JS's
 * negative-index normalisation, then passes the same index to both
 * `splice` and the recorded `arrayOp`. Per-element state and tokens
 * now follow the actual permutation.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { makeMounter } from '../utils/form-harness'

const schemaV4 = zV4.object({ tags: zV4.array(zV4.string()) })
const schemaV3 = zV3.object({ tags: zV3.array(zV3.string()) })
const defaults = { tags: ['a', 'b'] }

const adapters = [
  { name: 'v4', mount: makeMounter(useFormV4, schemaV4, { defaultValues: defaults }) },
  { name: 'v3', mount: makeMounter(useFormV3, schemaV3, { defaultValues: defaults }) },
] as const

describe.each(adapters)('insert negative index — $name', ({ mount }) => {
  const apps: ReturnType<typeof mount>['app'][] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  function mountOne() {
    const { api, app } = mount()
    apps.push(app)
    return api
  }

  it("storage matches splice's negative-index normalisation (sanity)", () => {
    const form = mountOne()
    form.insert('tags', -1, 'X')
    expect(form.values.tags).toEqual(['a', 'X', 'b'])
  })

  it('identity tokens record the splice at the actual insertion slot', () => {
    const form = mountOne()
    const aToken = form.fields('tags.0').key
    const bToken = form.fields('tags.1').key

    form.insert('tags', -1, 'X')

    // 'a' is unchanged at index 0; 'X' is fresh at index 1; 'b' shifted to index 2.
    expect(form.fields('tags.0').key).toBe(aToken)
    expect(form.fields('tags.1').key).not.toBe(aToken)
    expect(form.fields('tags.1').key).not.toBe(bToken)
    expect(form.fields('tags.2').key).toBe(bToken)
  })

  it("touched state on 'a' survives an insert(-1) — its index didn't change", () => {
    const form = mountOne()
    form.touch('tags.0')
    expect(form.fields('tags.0').touched).toBe(true)

    form.insert('tags', -1, 'X')

    expect(form.fields('tags.0').touched).toBe(true)
    // 'X' arrived at index 1 with no carry-over.
    expect(form.fields('tags.1').touched).toBe(false)
  })

  it("touched state on 'b' relocates from index 1 to index 2", () => {
    const form = mountOne()
    form.touch('tags.1')

    form.insert('tags', -1, 'X')

    expect(form.fields('tags.2').touched).toBe(true)
    expect(form.fields('tags.1').touched).toBe(false)
  })

  it('a very-negative index clamps to 0 (preLen + idx < 0)', () => {
    const form = mountOne()
    form.touch('tags.0')

    form.insert('tags', -10, 'X')

    expect(form.values.tags).toEqual(['X', 'a', 'b'])
    // 'a' relocates from index 0 to index 1.
    expect(form.fields('tags.1').touched).toBe(true)
    expect(form.fields('tags.0').touched).toBe(false)
  })

  it('negative index on an empty array clamps to 0', () => {
    const form = mountOne()
    // Empty the array first.
    form.remove('tags', 0)
    form.remove('tags', 0)
    expect(form.values.tags).toEqual([])

    form.insert('tags', -1, 'X')
    expect(form.values.tags).toEqual(['X'])
  })
})
