/**
 * Perf gate for `buildContainerFieldStateBase`'s descendant walk.
 *
 * The hot path runs once per `form.meta` read (and every container
 * field-state read). It iterates `state.originals` to aggregate leaf
 * dirty/blank/focused/blurred flags. Each iteration must NOT
 * re-canonicalize the leaf path: the `originals` Map is keyed by the
 * canonical key already, so the loop can destructure the key off the
 * iteration tuple.
 *
 * Pre-fix this test fails because the loop calls `canonicalizePath`
 * per leaf; post-fix it passes (constant calls regardless of N). Phase
 * 3 of the audit-remediation plan owns this regression boundary.
 */
import { describe, expect, it, vi } from 'vitest'
import { createFormStore } from '../../src/runtime/core/create-form-store'
import { buildFieldStateAccessor } from '../../src/runtime/core/field-state-api'
import * as paths from '../../src/runtime/core/paths'
import { fakeSchema } from '../utils/fake-schema'

function makeWideForm(leafCount: number) {
  const defaults: Record<string, string> = {}
  for (let i = 0; i < leafCount; i++) defaults[`f${i}`] = ''
  const state = createFormStore<Record<string, string>>({
    formKey: 'wide',
    schema: fakeSchema<Record<string, string>>(defaults),
  })
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const getFormMetaBase = () => ({ submissionAttempts: 0 }) as never
  return {
    state,
    getFieldState: buildFieldStateAccessor(state, 'wide-instance', getFormMetaBase),
  }
}

describe('buildContainerFieldStateBase — leaf-walk canonicalize budget', () => {
  it('does not re-canonicalize per leaf when reading the root container state on a 500-leaf form', () => {
    const LEAVES = 500
    const { state, getFieldState } = makeWideForm(LEAVES)
    // Prime the accessor so the first canonicalizePath call (on the
    // input `[]`) is not counted against the leaf-walk budget.
    const rootState = getFieldState([])
    // Touch root once to materialize the computed before spying.
    void rootState.value.dirty

    // Trigger a single-leaf mutation so the loop has something to aggregate.
    state.setValueAtPath(['f0'], 'x')

    const spy = vi.spyOn(paths, 'canonicalizePath')
    void rootState.value.dirty
    const calls = spy.mock.calls.length
    spy.mockRestore()

    // The leaf walk visits LEAVES entries; before CORE-P1b each leaf
    // re-canonicalizes its segments. The fixed loop reads the Map's
    // own key. A handful of incidental canonicalizes elsewhere on the
    // path is fine — the gate is that the count is decoupled from N.
    // Set well below `LEAVES` so a regression that re-introduces a
    // per-leaf canonicalize fails loudly. Picked at LEAVES/50 = 10 so
    // the bound is decoupled from the leaf count by an order of
    // magnitude; the post-fix observed count is 0 — every avoidable
    // call removed.
    expect(calls).toBeLessThan(LEAVES / 50)
  })
})
