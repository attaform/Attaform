/**
 * Regression suite for the O(N^2) -> O(N) container field-state fix.
 *
 * `buildContainerFieldStateBase` used to aggregate a container's rolled-up
 * state by scanning the ENTIRE `originals` map (every leaf in the whole
 * form) and filtering to its own descendants. One container therefore cost
 * O(total form leaves); `form.list` over N rows built N element containers,
 * so array ops and every post-op re-render were O(N^2). The fix walks each
 * container's OWN subtree value instead (`visitActiveLeafPaths`), re-gated
 * on `originals.has`, dropping per-container work to O(subtree) and the
 * list / array path to O(N).
 *
 * These tests pin the structural property (per-container work decoupled
 * from total form size), the finer reactive dependency (a sibling subtree
 * no longer invalidates this container), and the equivalence edges the
 * value-walk has to preserve byte-for-byte against the old scan — most
 * notably a present-but-`undefined` leaf that an optional field was cycled
 * through, which the old `hasAtPath` (key-existence) gate still rolled up.
 */
import { describe, expect, it, vi } from 'vitest'
import { createFormStore } from '../../src/runtime/core/create-form-store'
import { buildFieldStateAccessor } from '../../src/runtime/core/field-state-api'
import * as paths from '../../src/runtime/core/paths'
import { fakeSchema } from '../utils/fake-schema'

type RowsForm = { rows: { c0: string; c1: string }[] }
type GroupForm = { group: { keep: string; opt?: string } }

const LEAVES_PER_ROW = 2

function rowsAccessor(rowCount: number) {
  const rows = Array.from({ length: rowCount }, () => ({ c0: '', c1: '' }))
  const state = createFormStore<RowsForm>({
    formKey: 'rows',
    schema: fakeSchema<RowsForm>({ rows }),
  })
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const getFormMetaBase = () => ({ submissionAttempts: 0 }) as never
  return { state, getFieldState: buildFieldStateAccessor(state, 'rows-instance', getFormMetaBase) }
}

describe('container field-state aggregation — linear in array length', () => {
  it('per-element-container work is decoupled from total row count (O(subtree), not O(total))', () => {
    function elementWalkCalls(rowCount: number): number {
      const { state, getFieldState } = rowsAccessor(rowCount)
      const s0 = getFieldState(['rows', 0])
      void s0.value.dirty // prime: materialize the computed before spying
      // Invalidate just this element so the re-read re-runs its walk.
      state.setValueAtPath(['rows', 0, 'c0'], 'x')
      const spy = vi.spyOn(paths, 'keyForSegments')
      void s0.value.dirty
      const calls = spy.mock.calls.length
      spy.mockRestore()
      return calls
    }
    const small = elementWalkCalls(8)
    const large = elementWalkCalls(64)
    // The walk visits only this row's own leaves (c0, c1) regardless of how
    // many sibling rows exist. > 0 catches a revert to the tuple-key scan
    // (which never calls keyForSegments); equality across an 8x row-count
    // jump catches any per-container cost that scales with N.
    expect(small).toBeGreaterThan(0)
    expect(small).toBe(LEAVES_PER_ROW)
    expect(large).toBe(small)
  })

  it('a sibling subtree mutation does NOT invalidate a container computed', () => {
    const { state, getFieldState } = rowsAccessor(4)
    const s0 = getFieldState(['rows', 0])
    void s0.value.dirty // prime
    // Mutate a SIBLING row; the value-walk for rows.0 never read rows.1, so
    // rows.0's computed must stay cached. (The whole-`originals` scan read
    // every row, so this used to re-invalidate every element each op — the
    // quadratic.)
    state.setValueAtPath(['rows', 1, 'c0'], 'changed')
    const spy = vi.spyOn(paths, 'keyForSegments')
    void s0.value.dirty // cache hit => no walk => zero keyForSegments calls
    const calls = spy.mock.calls.length
    spy.mockRestore()
    expect(calls).toBe(0)
  })

  it('an own-subtree mutation DOES re-evaluate the container and flips dirty', () => {
    const { state, getFieldState } = rowsAccessor(4)
    const s0 = getFieldState(['rows', 0])
    expect(s0.value.dirty).toBe(false)
    const before = s0.value
    state.setValueAtPath(['rows', 0, 'c1'], 'typed')
    const after = s0.value
    expect(after).not.toBe(before) // recomputed
    expect(after.dirty).toBe(true)
    expect(after.pristine).toBe(false)
    // A different row stays pristine — no cross-element bleed.
    expect(getFieldState(['rows', 1]).value.dirty).toBe(false)
  })

  it('an empty container rolls up pristine / blank with no errors', () => {
    const { getFieldState } = rowsAccessor(0)
    const rowsState = getFieldState(['rows']).value
    expect(rowsState.value).toEqual([])
    expect(rowsState.pristine).toBe(true)
    expect(rowsState.dirty).toBe(false)
    expect(rowsState.blank).toBe(true)
    expect(rowsState.errors).toEqual([])
  })

  it('shrinking the array drops the removed element from the rollup (no ghost-originals leak)', () => {
    const { state, getFieldState } = rowsAccessor(3)
    const rowsState = getFieldState(['rows'])
    void rowsState.value.dirty // prime
    // Remove the tail row by writing a shorter array. The removed row's leaf
    // keys stay in `originals` (monotonic), but they're gone from the live
    // value, so the value-walk must not enumerate them.
    state.setValueAtPath(
      ['rows'],
      [
        { c0: '', c1: '' },
        { c0: '', c1: '' },
      ]
    )
    const spy = vi.spyOn(paths, 'keyForSegments')
    void rowsState.value.dirty
    const calls = spy.mock.calls.length
    spy.mockRestore()
    expect((rowsState.value.value as unknown[]).length).toBe(2)
    // 2 surviving rows x 2 leaves; the third row's ghost is never visited.
    expect(calls).toBe(2 * LEAVES_PER_ROW)
  })

  it('rolls up a present-but-undefined leaf an optional field was cycled through', () => {
    // hasAtPath (the gate the walk replaces) keys on key-EXISTENCE, so a
    // leaf written then set back to undefined stays present in form.value
    // and in `originals`, and must still contribute its field-record state.
    // A naive value-diff that skipped undefined would silently drop it.
    const state = createFormStore<GroupForm>({
      formKey: 'group',
      schema: fakeSchema<GroupForm>({ group: { keep: 'k' } }),
    })
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const getFormMetaBase = () => ({ submissionAttempts: 0 }) as never
    const getFieldState = buildFieldStateAccessor(state, 'group-instance', getFormMetaBase)

    // Write the optional leaf (enters `originals`), mark it interacted, then
    // cycle it back to undefined (present-undefined, still in originals).
    state.setValueAtPath(['group', 'opt'], 'v')
    state.markInteracted(['group', 'opt'])
    const ok = state.setValueAtPath(['group', 'opt'], undefined)
    expect(ok).toBe(true)

    // Sanity: the leaf is genuinely present-undefined, not deleted.
    const groupVal = getFieldState(['group']).value.value as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(groupVal, 'opt')).toBe(true)
    expect(groupVal['opt']).toBeUndefined()

    // The container must still see the interacted flag from that leaf.
    expect(getFieldState(['group']).value.interacted).toBe(true)
  })
})
