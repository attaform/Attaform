// @vitest-environment jsdom
/**
 * What a `<select v-register>` shows for a path the form does not
 * hold (#569).
 *
 * The house rule for a field with no value is that it displays as its
 * empty value. `displayValue` is where that lives: it folds a blank mark
 * and a null or absent model to `''`. `vRegisterText` paints it into
 * `el.value`, the compile-time `:value` injection on a `<select>` reads
 * the same ref, and so do `setSelected` and the per-option `:selected`
 * expression. A reader that goes to `innerRef` raw compares `undefined`
 * against every option on an unseeded path, matches none and leaves
 * `selectedIndex` at `-1`: an empty box, a state no user can reach by
 * interacting, and one the server disagrees with, since it marks no
 * option, the browser parses the first as selected, and hydration
 * erases it.
 *
 * The report came from a record whose key set is a function of another
 * field, so a key legitimately appears at render time. Seeding the
 * whole key space up front is the workaround, and it is exactly what
 * choosing a record was meant to avoid.
 *
 * This is a display change and only that: nothing is written, so a
 * select that renders never invents a record key, never fabricates a
 * choice the user did not make, and never spends the `blank` signal.
 * A model that HOLDS a value no option carries still shows nothing,
 * because showing an arbitrary option would lie about the form.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { h, nextTick, withDirectives, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { vRegister } from '../../src/runtime/core/directive'
import { unset } from '../../src/runtime/core/unset'
import { makeMounter, waitUntil } from '../utils/form-harness'

const schemaV4 = zV4.object({
  pairs: zV4.record(zV4.string(), zV4.string()).default({}),
  bag: zV4.record(zV4.string(), zV4.array(zV4.string())).default({}),
  color: zV4.string().optional(),
  count: zV4.number().optional(),
  rating: zV4.number(),
})
const schemaV3 = zV3.object({
  pairs: zV3.record(zV3.string(), zV3.string()).default({}),
  bag: zV3.record(zV3.string(), zV3.array(zV3.string())).default({}),
  color: zV3.string().optional(),
  count: zV3.number().optional(),
  rating: zV3.number(),
})

const adapters = [
  { name: 'v4', useFormFn: useFormV4, schema: schemaV4 },
  { name: 'v3', useFormFn: useFormV3, schema: schemaV3 },
] as const

/** `<option value="…">` children, in the order given. */
function options(values: readonly string[]): ReturnType<typeof h>[] {
  return values.map((v) => h('option', { value: v }, v === '' ? 'None' : v))
}

describe.each(adapters)('a <select> on a path the form does not hold ($name)', (adapter) => {
  let app: App | undefined

  afterEach(() => {
    app?.unmount()
    app = undefined
    document.body.innerHTML = ''
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Mounted = { api: any; root: HTMLElement }

  async function mountSelect(
    path: string,
    optionValues: readonly string[],
    defaultValues: Record<string, unknown>,
    selectProps: Record<string, unknown> | null = null
  ): Promise<Mounted & { el: HTMLSelectElement }> {
    const mount = makeMounter(adapter.useFormFn, adapter.schema, { defaultValues }, (form) =>
      withDirectives(h('select', selectProps, options(optionValues)), [
        [vRegister, form.register(path)],
      ])
    )
    const mounted = mount()
    app = mounted.app
    const el = await waitUntil(() => mounted.root.querySelector('select'))
    await nextTick()
    return { api: mounted.api, root: mounted.root, el }
  }

  it('selects the authored empty option for an absent record key', async () => {
    const { el } = await mountSelect('pairs.no', ['', '0'], { pairs: { yes: '1' } })
    expect(el.selectedIndex).toBe(0)
    expect(el.value).toBe('')
  })

  it('shows the empty option wherever the author put it, not the first', async () => {
    // The browser's own fallback is "the first option". The directive's
    // answer is "the option that carries the empty value", which is the
    // one an author writes as the placeholder — it does not have to lead
    // the list.
    const { el } = await mountSelect('color', ['red', '', 'blue'], {})
    expect(el.selectedIndex).toBe(1)
  })

  it('writes nothing: the record key stays absent', async () => {
    const { api, el } = await mountSelect('pairs.no', ['', '0'], { pairs: { yes: '1' } })
    expect(el.selectedIndex).toBe(0)
    expect(api.values.pairs).toEqual({ yes: '1' })
    expect(Object.hasOwn(api.values.pairs, 'no')).toBe(false)
  })

  it('shows nothing when no option carries the empty value', async () => {
    // Falling back to the first option here would record a choice the
    // user never made — `us` because it sorts first. Blank is the
    // truthful paint, and the author's fix is a placeholder option.
    const { api, el } = await mountSelect('color', ['us', 'uk'], {})
    expect(el.selectedIndex).toBe(-1)
    expect(api.values.color).toBeUndefined()
  })

  it('still shows nothing for a value no option carries', async () => {
    const { el } = await mountSelect('color', ['', 'red'], { color: 'purple' })
    expect(el.selectedIndex).toBe(-1)
  })

  it('shows the empty option for a path the `unset` sentinel marked blank', async () => {
    // `unset` writes the schema's slim value and joins the path to
    // `blankPaths`, and `displayValue` reads that set — so a blank
    // numeric select shows the placeholder rather than highlighting
    // `<option value="0">`, which is the slim value storage now holds.
    const { api, el } = await mountSelect('rating', ['', '0', '1'], { rating: 1 })
    expect(el.selectedIndex).toBe(2)
    api.setValue('rating', unset)
    await nextTick()
    expect(api.values.rating).toBe(0)
    expect(el.selectedIndex).toBe(0)
  })

  it('matches the empty option on a numeric leaf', async () => {
    const { el } = await mountSelect('count', ['', '1'], {})
    expect(el.selectedIndex).toBe(0)
  })

  it('returns to the empty option when a held value is cleared away', async () => {
    const { api, el } = await mountSelect('pairs.no', ['', '0'], { pairs: { no: '0' } })
    expect(el.selectedIndex).toBe(1)
    api.setValue('pairs', {})
    await nextTick()
    expect(el.selectedIndex).toBe(0)
  })

  it('keeps the empty option selected once the user picks it', async () => {
    // The placeholder is a real option: picking it writes `''`, and the
    // model then holds the same value the unseeded path displayed. No
    // oscillation between the two readings.
    const { api, el } = await mountSelect('pairs.no', ['', '0'], { pairs: { yes: '1' } })
    el.selectedIndex = 1
    el.dispatchEvent(new Event('change'))
    await nextTick()
    expect(api.values.pairs.no).toBe('0')
    el.selectedIndex = 0
    el.dispatchEvent(new Event('change'))
    await nextTick()
    expect(api.values.pairs.no).toBe('')
    expect(el.selectedIndex).toBe(0)
  })

  it('picks no members on a multi-select, and says nothing about it', async () => {
    // The old path took the "expected an Array or Set" misuse branch and
    // told the consumer to bind a list-typed schema. They had: `bag`'s
    // value type IS `z.array(z.string())`, the key was simply unseeded.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { el } = await mountSelect('bag.missing', ['a', 'b'], { bag: {} }, { multiple: true })
      expect(Array.from(el.options).map((o) => o.selected)).toEqual([false, false])
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('deselects every member when a multi-select path goes away', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { api, el } = await mountSelect(
        'bag.here',
        ['a', 'b'],
        { bag: { here: ['a'] } },
        { multiple: true }
      )
      expect(Array.from(el.options).map((o) => o.selected)).toEqual([true, false])
      api.setValue('bag', {})
      await nextTick()
      expect(Array.from(el.options).map((o) => o.selected)).toEqual([false, false])
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('still warns when a multi-select is bound to a scalar the form holds', async () => {
    // The misuse warning is about a model of the wrong SHAPE, which is a
    // real binding mistake. Only the absent case left it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await mountSelect('color', ['a', 'b'], { color: 'a' }, { multiple: true })
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'expected an Array or Set'
      )
    } finally {
      warn.mockRestore()
    }
  })
})
