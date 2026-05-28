// @vitest-environment jsdom
/**
 * PASS2-7 — nested-array identity follows its element across outer-array
 * mutations. Pre-fix the `tokens` / `baselines` maps inside `arrayIdentity`
 * were keyed by absolute path (e.g. `items.1` for the inner array under
 * outer index 1) but `migrateArrayElementState` only migrated the path-
 * keyed maps it knew about (`fields`, `userErrors`, `originals`, blank
 * marks) — the identity tracker's internal maps were left untouched.
 *
 * Consequences:
 *
 *   - After `form.remove('items', 0)`, the inner array's tokens at
 *     `items.1` stayed at `items.1`. Reading `form.fields('items.0.0').key`
 *     allocated a NEW token (no entry at the relocated key), and the inner
 *     `v-for :key` reset for every nested row — Vue tore down + recreated
 *     every nested input.
 *   - The orphaned entry at `items.1.*` leaked indefinitely (an unbounded
 *     token Map leak proportional to outer-array churn).
 *
 * The fix exposes `applyRemap(arrayPath, remap)` on the `ArrayIdentity`
 * interface; `migrateArrayElementState` invokes it alongside the existing
 * Map / Set migrations so the identity tracker's internal state stays in
 * lockstep with the rest of the per-element bookkeeping.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { makeMounter } from '../utils/form-harness'

const schemaV4 = zV4.object({
  rows: zV4.array(zV4.array(zV4.string())),
})

const schemaV3 = zV3.object({
  rows: zV3.array(zV3.array(zV3.string())),
})

const defaults = { rows: [['a', 'b'], ['c', 'd'], ['e']] }

const adapters = [
  { name: 'v4', mount: makeMounter(useFormV4, schemaV4, { defaultValues: defaults }) },
  { name: 'v3', mount: makeMounter(useFormV3, schemaV3, { defaultValues: defaults }) },
] as const

describe.each(adapters)('nested-array identity migration — $name', ({ mount }) => {
  const apps: ReturnType<typeof mount>['app'][] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  function mountOne() {
    const { api, app } = mount()
    apps.push(app)
    return api
  }

  it('outer remove: inner tokens follow the surviving rows to their new outer index', () => {
    const form = mountOne()
    // Materialise inner tokens at outer indices 1 and 2 before the mutation.
    const cTokenBefore = form.fields('rows.1.0').key
    const dTokenBefore = form.fields('rows.1.1').key
    const eTokenBefore = form.fields('rows.2.0').key
    expect(cTokenBefore).toBeTruthy()
    expect(dTokenBefore).toBeTruthy()
    expect(eTokenBefore).toBeTruthy()

    // Remove outer index 0 (the `['a', 'b']` row); `['c','d']` shifts to 0,
    // `['e']` shifts to 1.
    form.remove('rows', 0)

    // Inner tokens must carry to the new outer positions.
    expect(form.fields('rows.0.0').key).toBe(cTokenBefore)
    expect(form.fields('rows.0.1').key).toBe(dTokenBefore)
    expect(form.fields('rows.1.0').key).toBe(eTokenBefore)
  })

  it('outer move: inner tokens follow the moved row to its destination outer index', () => {
    const form = mountOne()
    const cToken = form.fields('rows.1.0').key
    const dToken = form.fields('rows.1.1').key

    form.move('rows', 1, 0)

    expect(form.fields('rows.0.0').key).toBe(cToken)
    expect(form.fields('rows.0.1').key).toBe(dToken)
  })

  it('outer swap: inner tokens swap together with their parent rows', () => {
    const form = mountOne()
    const aToken = form.fields('rows.0.0').key
    const bToken = form.fields('rows.0.1').key
    const cToken = form.fields('rows.1.0').key
    const dToken = form.fields('rows.1.1').key

    form.swap('rows', 0, 1)

    expect(form.fields('rows.0.0').key).toBe(cToken)
    expect(form.fields('rows.0.1').key).toBe(dToken)
    expect(form.fields('rows.1.0').key).toBe(aToken)
    expect(form.fields('rows.1.1').key).toBe(bToken)
  })

  it('outer insert: an inserted row gets a fresh inner-array identity (no leak from old slot)', () => {
    const form = mountOne()
    const cToken = form.fields('rows.1.0').key

    form.insert('rows', 1, ['x', 'y'])

    // The inserted row at outer index 1 must get a brand-new inner token;
    // the surviving 'c' element (now at outer index 2) keeps its original.
    const newInnerToken = form.fields('rows.1.0').key
    expect(newInnerToken).not.toBe(cToken)
    expect(form.fields('rows.2.0').key).toBe(cToken)
  })

  it('outer replace-at: the new row gets a fresh inner-array identity', () => {
    const form = mountOne()
    const originalCToken = form.fields('rows.1.0').key

    form.replace('rows', 1, ['z'])

    expect(form.fields('rows.1.0').key).not.toBe(originalCToken)
  })
})
