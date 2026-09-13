// @vitest-environment jsdom
/**
 * Retention pins for the memoised `form.values()` snapshot (#567).
 *
 * The call form returns a detached snapshot rather than the live
 * readonly proxy, and memoises it so repeated calls between writes stay
 * as cheap as the proxy return they replaced. A cache is where that fix
 * can quietly turn into a leak: `materializeFormValue` deep-copies the
 * plain-data spine but shares non-plain instances (Map, Set, File,
 * Blob) by REFERENCE, and Vue keeps a computed's last value until
 * something reads it again. Without an explicit release, a form that
 * held a 50 MB File and then cleared it kept that File reachable
 * through the stale copy until the next read or teardown, where the
 * live proxy this replaced dropped it at once.
 *
 * The surface subscribes to `onFormChange` and empties the previous
 * snapshot box on every write, so retention ends at the next mutation
 * rather than the next read. These tests force a collection and assert
 * the dropped value is genuinely unreachable, across each write funnel:
 * a deep leaf write, a field-array removal, `clear()`, and `reset()`.
 *
 * They need `--expose-gc`, which the test wrapper passes (see
 * `scripts/run-with-webstorage-flag.mjs`). Run through `pnpm test`;
 * a bare `vitest` has no `globalThis.gc` and these skip rather than
 * fail, which is why the skip is loud.
 */
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { makeMounter } from '../utils/form-harness'

const schema = z.object({
  nested: z.object({ deep: z.object({ blob: z.any() }) }),
  rows: z.array(z.object({ blob: z.any() })),
})

const hasGc = typeof (globalThis as { gc?: () => void }).gc === 'function'

/** Run enough collection cycles that an unreachable value is cleared. */
async function collect(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    ;(globalThis as { gc?: () => void }).gc?.()
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

/** A payload big enough that retaining it would matter, held by reference. */
function payload(): Map<string, Uint8Array> {
  return new Map([['blob', new Uint8Array(3 * 1024 * 1024)]])
}

function mountForm() {
  return makeMounter(useForm, schema, {
    defaultValues: { nested: { deep: { blob: null } }, rows: [] },
  })().api
}

/**
 * Seed the form with a tracked payload, take a snapshot the way a
 * submit handler would, then run `drop` and report whether the payload
 * became unreachable. The payload is scoped so the caller never holds
 * a strong reference of its own.
 */
async function retainedAfter(
  seed: (form: ReturnType<typeof mountForm>, value: Map<string, Uint8Array>) => void,
  drop: (form: ReturnType<typeof mountForm>) => void
): Promise<boolean> {
  const form = mountForm()
  const ref = ((): WeakRef<object> => {
    const value = payload()
    seed(form, value)
    return new WeakRef(value)
  })()
  await nextTick()

  // Populate the memoised snapshot, retaining nothing here.
  void form.values()

  drop(form)
  await nextTick()
  await collect()
  return ref.deref() !== undefined
}

describe.skipIf(!hasGc)('form.values() snapshot retention', () => {
  it('a deep leaf write releases the previous snapshot payload', async () => {
    const retained = await retainedAfter(
      (form, value) => form.setValue('nested.deep.blob', value),
      (form) => form.setValue('nested.deep.blob', null)
    )
    expect(retained).toBe(false)
  })

  it('a field-array removal releases it', async () => {
    const retained = await retainedAfter(
      (form, value) => form.setValue('rows', [{ blob: value }]),
      (form) => form.remove('rows', 0)
    )
    expect(retained).toBe(false)
  })

  it('clear() releases it', async () => {
    const retained = await retainedAfter(
      (form, value) => form.setValue('nested.deep.blob', value),
      (form) => form.clear()
    )
    expect(retained).toBe(false)
  })

  it('reset() releases it', async () => {
    const retained = await retainedAfter(
      (form, value) => form.setValue('nested.deep.blob', value),
      (form) => form.reset()
    )
    expect(retained).toBe(false)
  })
})

describe.skipIf(hasGc)('form.values() snapshot retention (skipped)', () => {
  it('needs --expose-gc; run through pnpm test', () => {
    expect(hasGc).toBe(false)
  })
})
