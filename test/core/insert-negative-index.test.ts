// @vitest-environment jsdom
/**
 * PASS2-6: the typed `insert` helper computes its insertion index BEFORE
 * the splice, under JS's negative-index normalisation, and passes that
 * same index to both `splice` and the recorded `arrayOp`, so per-element
 * state and tokens follow the actual permutation.
 *
 * Recording `op.index` against the POST-splice length diverges on a
 * negative argument: `splice` normalises `-1` on a length-2 array to
 * position 1, while an index clamped to `[0, postLen]` yields 0. Every
 * downstream consumer then works the wrong slot, so variant memory is
 * cleared at index 0 where nothing happened, and the identity-token list
 * splices at index 0, clobbering the unchanged head element's token
 * rather than the new arrival's.
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
