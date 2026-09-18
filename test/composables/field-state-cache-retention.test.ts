// @vitest-environment jsdom
/**
 * Retention pins for the per-path field-state cache (#612).
 *
 * `getFieldStateAt` memoises one `ComputedRef` per canonical path so
 * repeated reads share a Vue subscription. Each entry holds the path's
 * `value` AND its `original`, so the cache pins form data, not just
 * bookkeeping, and it has to be bounded by the paths the form currently
 * has rather than every path ever read. Unbounded, a `z.record` whose
 * keys churn or an array whose indices do keeps every value it ever
 * held: measured at 200 of 200 removed keys still reachable, 12.5 MB
 * pinned by a form whose value was `{}`.
 *
 * So the accessor drops entries for dynamic paths the form no longer
 * has, swept on write once the dynamic set outgrows its threshold. A
 * path bounded by a fixed object shape is never swept, so an absent
 * optional field is not dropped and rebuilt on a loop.
 *
 * Evicting is invisible to consumers: a field view comes from a
 * separate cache and re-resolves through this accessor on every read,
 * so the identity-stability contract is untouched. The last group pins
 * that, because releasing memory by breaking identity would satisfy the
 * retention pins on their own.
 *
 * These need `--expose-gc`, which the test wrapper passes (see
 * `scripts/run-with-webstorage-flag.mjs`). Run through `pnpm test`; a
 * bare `vitest` has no `globalThis.gc` and these skip rather than fail,
 * which is why the skip is loud.
 */
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { makeMounter } from '../utils/form-harness'

const schema = z.object({
  prefs: z.record(z.string(), z.date()),
  rows: z.array(z.object({ at: z.date() })),
  fixed: z.object({ at: z.date() }),
})

const hasGc = typeof (globalThis as { gc?: () => void }).gc === 'function'

/** Run enough collection cycles that an unreachable value is cleared. */
async function collect(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    ;(globalThis as { gc?: () => void }).gc?.()
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

function mountForm() {
  return makeMounter(useForm, schema, {
    defaultValues: { prefs: {}, rows: [], fixed: { at: new Date(0) } },
  })().api
}

type Form = ReturnType<typeof mountForm>

/**
 * Each write sweeps a bounded slice of the cached dynamic paths, so a
 * dead entry is dropped within one pass rather than on the write that
 * killed it. Churning this many untracked keys afterwards drives
 * several full passes, which is what makes "released" a deterministic
 * assertion rather than a timing one. Every other record key is left
 * in place, so this settles the cache without disturbing the form.
 */
const SETTLE_KEYS = 40

function churnUntracked(form: Form): void {
  for (let i = 0; i < SETTLE_KEYS; i++) {
    const before = { ...form.values.prefs }
    form.setValue('prefs', { ...before, [`settle${i}`]: new Date(i) })
    void form.fields(`prefs.settle${i}`)?.value
    form.setValue('prefs', before)
  }
}

/**
 * Write `count` tracked payloads one at a time, run `touch` against
 * each while it is live, remove it, and report how many survive a
 * forced collection. Each payload is minted inside a scope the test
 * does not hold, so the probe cannot retain what it measures.
 */
async function survivorsAfterChurn(
  count: number,
  touch: (form: Form, key: string) => void
): Promise<number> {
  const form = mountForm()
  const refs: WeakRef<object>[] = []
  for (let i = 0; i < count; i++) {
    const key = `k${i}`
    refs.push(
      ((): WeakRef<object> => {
        const value = new Date(i + 1)
        form.setValue(`prefs.${key}`, value)
        touch(form, key)
        return new WeakRef(value)
      })()
    )
    form.setValue('prefs', {})
  }
  churnUntracked(form)
  await nextTick()
  await collect()
  return refs.filter((ref) => ref.deref() !== undefined).length
}

describe.skipIf(!hasGc)('field-state cache retention', () => {
  it('a control run retains nothing, so the probe measures the cache', async () => {
    expect(await survivorsAfterChurn(120, () => {})).toBe(0)
  })

  it('reading a churned record key releases its value', async () => {
    const survivors = await survivorsAfterChurn(120, (form, key) => {
      void form.fields(`prefs.${key}`)?.value
    })
    expect(survivors).toBe(0)
  })

  it('reading any FieldState key releases it, not just value', async () => {
    const survivors = await survivorsAfterChurn(120, (form, key) => {
      void form.fields(`prefs.${key}`)?.dirty
    })
    expect(survivors).toBe(0)
  })

  it('dot access releases it too', async () => {
    const survivors = await survivorsAfterChurn(120, (form, key) => {
      const prefs: Record<string, { value: unknown } | undefined> = form.fields.prefs
      void prefs[key]?.value
    })
    expect(survivors).toBe(0)
  })

  it('the replaced original is released, not only the current value', async () => {
    const form = mountForm()
    const refs: WeakRef<object>[] = []
    for (let i = 0; i < 120; i++) {
      refs.push(
        ((): WeakRef<object> => {
          const first = new Date(i + 1)
          form.setValue(`prefs.k${i}`, first)
          void form.fields(`prefs.k${i}`)?.value
          // Replace it, so the entry's `original` is the only holder.
          form.setValue(`prefs.k${i}`, new Date(0))
          return new WeakRef(first)
        })()
      )
      form.setValue('prefs', {})
    }
    churnUntracked(form)
    await nextTick()
    await collect()
    expect(refs.filter((ref) => ref.deref() !== undefined)).toHaveLength(0)
  })

  it('churned array indices release their values', async () => {
    const form = mountForm()
    const refs: WeakRef<object>[] = []
    for (let i = 0; i < 120; i++) {
      refs.push(
        ((): WeakRef<object> => {
          const value = new Date(i + 1)
          form.setValue('rows', [{ at: value }])
          void form.fields('rows.0.at')?.value
          return new WeakRef(value)
        })()
      )
      form.setValue('rows', [])
    }
    churnUntracked(form)
    await nextTick()
    await collect()
    expect(refs.filter((ref) => ref.deref() !== undefined)).toHaveLength(0)
  })
})

describe('field-state cache correctness under sweeping', () => {
  it('a live dynamic path keeps its view identity across sweeps', () => {
    const form = mountForm()
    form.setValue('prefs.keep', new Date(1))
    const view = form.fields('prefs.keep')
    churnUntracked(form)
    expect(form.fields('prefs.keep')).toBe(view)
    expect(form.fields.prefs.keep).toBe(view)
  })

  it('a live dynamic path still reads correctly after sweeps', () => {
    const form = mountForm()
    form.setValue('prefs.keep', new Date(1))
    churnUntracked(form)
    form.setValue('prefs.keep', new Date(2))
    expect(form.fields('prefs.keep')?.value).toStrictEqual(new Date(2))
    expect(form.fields('prefs.keep')?.dirty).toBe(true)
    expect(form.fields('prefs.keep')?.path).toEqual(['prefs', 'keep'])
  })

  it('a fixed-shape path is never swept, absent or not', () => {
    const form = mountForm()
    const before = form.fields('fixed.at')
    churnUntracked(form)
    expect(form.fields('fixed.at')).toBe(before)
    expect(form.fields.fixed.at.value).toStrictEqual(new Date(0))
  })

  it('a rebuilt entry reports the same state the original did', () => {
    const form = mountForm()
    form.setValue('prefs.gone', new Date(1))
    void form.fields('prefs.gone')?.value
    form.setValue('prefs', {})
    churnUntracked(form)
    // The entry is gone from the cache; reading rebuilds it.
    form.setValue('prefs.gone', new Date(3))
    expect(form.fields('prefs.gone')?.value).toStrictEqual(new Date(3))
    expect(form.fields('prefs.gone')?.path).toEqual(['prefs', 'gone'])
  })
})

describe.skipIf(hasGc)('field-state cache retention (skipped)', () => {
  it('needs --expose-gc; run through pnpm test', () => {
    expect(hasGc).toBe(false)
  })
})
