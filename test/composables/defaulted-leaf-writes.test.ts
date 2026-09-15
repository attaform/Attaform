// @vitest-environment jsdom
/**
 * What actually puts a defaulted leaf back to its default.
 *
 * `docs/schemas/storage-shape.md` used to carry
 * `form.setValue('flag', undefined) // OK; default fills the gap`.
 * There is no such mechanism. The write fails the slim gate, dev-warns,
 * and no-ops — storage keeps whatever it already held, which on a
 * freshly mounted form is the default, so the snippet's implied
 * assertion passed by accident and the wrong mental model survived.
 *
 * Three verbs do have an answer here, and they give three different
 * ones. Pinned together because the page now prescribes choosing
 * between them, and a reader who picks `clear` expecting `reset`'s
 * result ships a form that submits `false` for a "notify me" toggle
 * that was declared `true`.
 *
 * Both majors: the slim gate and the reset path are shared core, and
 * a divergence here would be invisible from either adapter's own
 * suite.
 */
import { describe, expect, it, vi } from 'vitest'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { makeMounter } from '../utils/form-harness'

/** Capture `console.warn` / `console.error` for the length of `fn`. */
function noise(fn: () => void): string[] {
  const out: string[] = []
  const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(' '))
  })
  const error = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(' '))
  })
  try {
    fn()
  } finally {
    warn.mockRestore()
    error.mockRestore()
  }
  return out
}

const ADAPTERS = [
  {
    name: 'zod v4',
    useForm: useFormV4,
    schema: () => zV4.object({ flag: zV4.boolean().default(true), note: zV4.string() }),
  },
  {
    name: 'zod v3',
    useForm: useFormV3,
    schema: () => zV3.object({ flag: zV3.boolean().default(true), note: zV3.string() }),
  },
] as const

describe.each(ADAPTERS)('writing at a defaulted leaf — $name', (adapter) => {
  it('seeds the declared default at mount', () => {
    const { api } = makeMounter(adapter.useForm, adapter.schema(), {})()
    expect(api.values.flag).toBe(true)
  })

  it('refuses `undefined` at the leaf, loudly, and changes nothing', () => {
    const { api } = makeMounter(adapter.useForm, adapter.schema(), {})()
    api.setValue('flag', false)

    const warned = noise(() => api.setValue('flag', undefined as unknown as boolean))

    expect(warned.join('\n')).toContain('the schema expects boolean')
    // The point of the pin: storage is untouched, NOT reset to `true`.
    // A form that had been edited keeps the edit.
    expect(api.values.flag).toBe(false)
  })

  it('`resetField` is the verb that re-seeds the declared default', () => {
    const { api } = makeMounter(adapter.useForm, adapter.schema(), {})()
    api.setValue('flag', false)

    const warned = noise(() => api.resetField('flag'))

    expect(warned).toEqual([])
    expect(api.values.flag).toBe(true)
  })

  it('`clear` ignores the default and writes the falsy concrete', () => {
    // The trap the page now warns about: `clear` is "wipe to blank",
    // not "back to the starting state". On a `.default(true)` leaf
    // those are opposite answers.
    const { api } = makeMounter(adapter.useForm, adapter.schema(), {})()

    const warned = noise(() => api.clear('flag'))

    expect(warned).toEqual([])
    expect(api.values.flag).toBe(false)
  })
})
