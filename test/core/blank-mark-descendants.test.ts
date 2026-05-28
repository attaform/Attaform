// @vitest-environment jsdom
/**
 * PASS2-1 — `setValueAtPath` clears descendant blank-marks on a non-blank
 * write. The pre-fix gate hook only consulted `blankPaths.has(pathKey)`
 * for the EXACT key being written; a write to a container path (`addr`)
 * left every descendant blank-mark (`addr.zip`) intact, even though the
 * consumer just wrote a real value at that leaf. Effects rippled into:
 *
 *   1. `handleSubmit` false-rejects with a synthesised "No value supplied"
 *      error at the descendant — the form is populated but submit fails.
 *   2. `displayValue` at the descendant reads as empty — the input
 *      visually clears even though storage holds the consumer's value.
 *   3. `form.meta.errors` carries the stale required-blank entry.
 *
 * The fix mirrors the already-correct DU-reshape path at
 * `create-form-store.ts:2346` (`isPathKeyUnder` sweep). Pinned across
 * v3 + v4 and across the two consumer-facing entry shapes (path-form
 * `setValue('addr', …)` and root-form `setValue({ addr: … })`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4, unset as unsetV4 } from '../../src/zod-v4'
import { useForm as useFormV3, unset as unsetV3 } from '../../src/zod-v3'
import { AttaformErrorCode } from '../../src/runtime/core/error-codes'
import { makeMounter } from '../utils/form-harness'

const schemaV4 = zV4.object({
  addr: zV4.object({
    zip: zV4.number(),
    city: zV4.string(),
  }),
})

const schemaV3 = zV3.object({
  addr: zV3.object({
    zip: zV3.number(),
    city: zV3.string(),
  }),
})

const adapters = [
  { name: 'v4', mount: makeMounter(useFormV4, schemaV4), unset: unsetV4 },
  { name: 'v3', mount: makeMounter(useFormV3, schemaV3), unset: unsetV3 },
] as const

describe.each(adapters)('setValue clears descendant blank-marks — $name', ({ mount, unset }) => {
  const apps: ReturnType<typeof mount>['app'][] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  function mountOne() {
    const { api, app } = mount()
    apps.push(app)
    return api
  }

  it('path-form: setValue("addr", {zip:N}) clears the addr.zip blank-mark', () => {
    const form = mountOne()
    form.setValue('addr.zip', unset)
    expect(form.blankPaths.value.has('addr.zip')).toBe(true)

    form.setValue('addr', { zip: 12345, city: 'Boise' })
    expect(form.blankPaths.value.has('addr.zip')).toBe(false)
    expect(form.values.addr.zip).toBe(12345)
  })

  it('root-form: setValue({addr:{...}}) clears descendant blank-marks', () => {
    const form = mountOne()
    form.setValue('addr.zip', unset)
    expect(form.blankPaths.value.has('addr.zip')).toBe(true)

    form.setValue({ addr: { zip: 12345, city: 'Boise' } })
    expect(form.blankPaths.value.has('addr.zip')).toBe(false)
    expect(form.values.addr.zip).toBe(12345)
  })

  it('handleSubmit accepts after the container write — no false required-blank rejection', async () => {
    const form = mountOne()
    form.setValue('addr.zip', unset)
    form.setValue('addr.city', 'placeholder')

    // Sanity: with the blank-mark live, submit rejects on the descendant.
    {
      const onSubmit = vi.fn()
      const onError = vi.fn()
      await form.handleSubmit(onSubmit, onError)()
      expect(onSubmit).not.toHaveBeenCalled()
      expect(onError).toHaveBeenCalledTimes(1)
      const errors = onError.mock.calls[0]?.[0] as Array<{ code: string; path: unknown[] }>
      expect(
        errors.some((e) => e.code === AttaformErrorCode.NoValueSupplied && e.path[1] === 'zip')
      ).toBe(true)
    }

    // Container write supplies the real value; submit must now resolve.
    form.setValue('addr', { zip: 12345, city: 'Boise' })

    const onSubmit2 = vi.fn()
    const onError2 = vi.fn()
    await form.handleSubmit(onSubmit2, onError2)()
    expect(onError2).not.toHaveBeenCalled()
    expect(onSubmit2).toHaveBeenCalledTimes(1)
  })

  it('a descendant write with a non-blank meta also clears the mark (exact-key parity)', () => {
    const form = mountOne()
    form.setValue('addr.zip', unset)
    expect(form.blankPaths.value.has('addr.zip')).toBe(true)

    form.setValue('addr.zip', 12345)
    expect(form.blankPaths.value.has('addr.zip')).toBe(false)
  })

  it('a sibling-descendant blank-mark is untouched by a write to a different sub-container', () => {
    const form = mountOne()
    form.setValue('addr.zip', unset)
    expect(form.blankPaths.value.has('addr.zip')).toBe(true)

    // Writing only to a sibling leaf must NOT bleed into addr.zip's mark.
    form.setValue('addr.city', 'Boise')
    expect(form.blankPaths.value.has('addr.zip')).toBe(true)
  })
})
