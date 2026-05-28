// @vitest-environment jsdom
/**
 * PASS2-S1 — `form.clear(path)` aligns with `form.setValue(path, unset)`.
 * Pre-fix `clear` wrote the slim primitive (`''` / `0` / `false`) but
 * did NOT mark the path blank, so:
 *
 *   - `displayValue` rendered the slim default (`'0'` for numbers) even
 *     though the consumer had asked for the field to be cleared.
 *   - The synthesised "No value supplied" error never fired on submit;
 *     a required `z.string()` cleared via `form.clear` silently passed
 *     validation with `''`.
 *
 * The fix delegates `clear` to the same path as `setValue(unset)` so
 * the two verbs settle on identical observable state: same storage,
 * same blank-mark, same required-validation verdict.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4, unset as unsetV4 } from '../../src/zod-v4'
import { useForm as useFormV3, unset as unsetV3 } from '../../src/zod-v3'
import { AttaformErrorCode } from '../../src/runtime/core/error-codes'
import { makeMounter } from '../utils/form-harness'

const schemaV4 = zV4.object({
  age: zV4.number(),
  name: zV4.string(),
  agreed: zV4.boolean(),
})

const schemaV3 = zV3.object({
  age: zV3.number(),
  name: zV3.string(),
  agreed: zV3.boolean(),
})

const adapters = [
  { name: 'v4', mount: makeMounter(useFormV4, schemaV4), unset: unsetV4 },
  { name: 'v3', mount: makeMounter(useFormV3, schemaV3), unset: unsetV3 },
] as const

describe.each(adapters)('clear aligns with setValue(unset) — $name', ({ mount, unset }) => {
  const apps: ReturnType<typeof mount>['app'][] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  function mountOne() {
    const { api, app } = mount()
    apps.push(app)
    return api
  }

  it('clear("age") marks the path blank (z.number required)', () => {
    const form = mountOne()
    form.setValue('age', 42)
    expect(form.blankPaths.value.has('age')).toBe(false)

    form.clear('age')

    expect(form.blankPaths.value.has('age')).toBe(true)
    expect(form.values.age).toBe(0)
  })

  it('clear("name") marks the path blank (z.string required)', () => {
    const form = mountOne()
    form.setValue('name', 'ozzy')

    form.clear('name')

    expect(form.blankPaths.value.has('name')).toBe(true)
    expect(form.values.name).toBe('')
  })

  it('clear("agreed") marks the path blank (z.boolean required)', () => {
    const form = mountOne()
    form.setValue('agreed', true)

    form.clear('agreed')

    expect(form.blankPaths.value.has('agreed')).toBe(true)
    expect(form.values.agreed).toBe(false)
  })

  it('handleSubmit rejects with required-blank after clear() on a required leaf', async () => {
    const form = mountOne()
    form.setValue('age', 42)
    form.setValue('name', 'ozzy')
    form.setValue('agreed', true)

    form.clear('age')

    const onSubmit = vi.fn()
    const onError = vi.fn()
    await form.handleSubmit(onSubmit, onError)()

    expect(onSubmit).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    const errors = onError.mock.calls[0]?.[0] as Array<{ code: string; path: unknown[] }>
    expect(
      errors.some((e) => e.code === AttaformErrorCode.NoValueSupplied && e.path[0] === 'age')
    ).toBe(true)
  })

  it('clear() converges to the same state as setValue(unset) for primitives', () => {
    const formA = mountOne()
    const formB = mountOne()

    formA.setValue('age', 42)
    formA.clear('age')

    formB.setValue('age', 42)
    formB.setValue('age', unset)

    // Storage parity.
    expect(formA.values.age).toBe(formB.values.age)
    // Blank-mark parity.
    expect(formA.blankPaths.value.has('age')).toBe(formB.blankPaths.value.has('age'))
  })

  it('whole-form clear() marks every required primitive blank', () => {
    const form = mountOne()
    form.setValue('age', 42)
    form.setValue('name', 'ozzy')
    form.setValue('agreed', true)

    form.clear()

    expect(form.blankPaths.value.has('age')).toBe(true)
    expect(form.blankPaths.value.has('name')).toBe(true)
    expect(form.blankPaths.value.has('agreed')).toBe(true)
  })
})
