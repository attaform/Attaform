// @vitest-environment jsdom
/**
 * A write whose only change is a container holding no leaf lands (#705).
 *
 * The diff reports a value change leaf by leaf, so a container with no leaf
 * in it (`[]`, `{}`, an object whose every key holds `undefined`), and an
 * array slot holding `undefined`, arrived or left unreported. The write
 * reassigned nothing and stamped nothing: `form.values` never changed, while
 * a typed array op still moved the identity tracker, so `form.list` keys and
 * the array disagreed.
 *
 * Each op below pins, together: the value lands, the container and the root
 * stamp forward (D5), `dirty` follows it (D7, a container that held no leaf
 * at the baseline being a baseline of its own), and `form.list` keys match
 * the array. Undo and redo restore it.
 *
 * The last op is the same gap from the other side: an object written over
 * `null` is one patch at the container, and the leaves it brings had no
 * baseline, so they read pristine.
 *
 * Mirrored across both adapters: the diff and the commit tail are shared core.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { historyPlugin } from '../../src/history'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { makeMounter } from '../utils/form-harness'

const ADAPTERS = [
  { name: 'zod-v4', z: zV4 as any, useForm: useFormV4 as any },
  { name: 'zod-v3', z: zV3 as any, useForm: useFormV3 as any },
] as const

type Adapter = (typeof ADAPTERS)[number]

const makeSchema = (z: any): any =>
  z.object({
    note: z.string(),
    matrix: z.array(z.array(z.string())),
    rows: z.array(z.object({ a: z.string().optional() })),
    opt: z.array(z.string()).optional(),
    box: z.object({ a: z.string().optional() }).optional(),
    maybe: z.array(z.string().optional()),
    nul: z.object({ s: z.string() }).nullable(),
  })

// `opt` and `box` take the schema's own defaults: `[]` and `{ a: undefined }`.
const defaults = () => ({ note: 'n', matrix: [['a'], []], rows: [], nul: null })

const T0 = new Date('2026-01-01T00:00:00.000Z')
const T1 = new Date('2026-01-01T00:00:01.000Z')
const T2 = new Date('2026-01-01T00:00:02.000Z')
const T3 = new Date('2026-01-01T00:00:03.000Z')

const apps: App[] = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
  vi.useRealTimers()
})

function mount(adapter: Adapter): any {
  const { api, app } = makeMounter(adapter.useForm, makeSchema(adapter.z), {
    defaultValues: defaults(),
    validateOn: 'submit',
    history: historyPlugin(),
  })()
  apps.push(app)
  return api
}

type Op = {
  readonly name: string
  readonly run: (form: any) => void
  /** The top-level key the op changes, and what it holds afterwards. */
  readonly key: string
  readonly after: unknown
  /** The container the write changed, which must stamp forward. */
  readonly container: readonly (string | number)[]
  /** An array to read `form.list` keys off, when the op resizes one. */
  readonly list?: string
  /** A write that brings the value back to its baseline, and that baseline. */
  readonly back?: { readonly run: (form: any) => void; readonly value: unknown }
}

const OPS: readonly Op[] = [
  {
    name: "remove('matrix', 1) dropping an empty list",
    run: (form) => form.remove('matrix', 1),
    key: 'matrix',
    after: [['a']],
    container: ['matrix'],
    list: 'matrix',
  },
  {
    name: "append('matrix', []) adding an empty list",
    run: (form) => form.append('matrix', []),
    key: 'matrix',
    after: [['a'], [], []],
    container: ['matrix', 2],
    list: 'matrix',
  },
  {
    name: "append('rows', {}) adding a row with no field set",
    run: (form) => form.append('rows', {}),
    key: 'rows',
    after: [{}],
    container: ['rows', 0],
    list: 'rows',
  },
  {
    name: "append('maybe', undefined) adding an undefined slot",
    run: (form) => form.append('maybe', undefined),
    key: 'maybe',
    after: [undefined],
    container: ['maybe'],
    list: 'maybe',
  },
  {
    name: "setValue('opt', undefined) over an empty array, and back",
    run: (form) => form.setValue('opt', undefined),
    key: 'opt',
    after: undefined,
    container: ['opt'],
    back: { run: (form) => form.setValue('opt', []), value: [] },
  },
  {
    name: "setValue('box', undefined) over an object with no field set, and back",
    run: (form) => form.setValue('box', undefined),
    key: 'box',
    after: undefined,
    container: ['box'],
    back: { run: (form) => form.setValue('box', {}), value: {} },
  },
  {
    name: "setValue('nul', { s }) bringing a leaf over null, and back",
    run: (form) => form.setValue('nul', { s: 's' }),
    key: 'nul',
    after: { s: 's' },
    container: ['nul', 's'],
    back: { run: (form) => form.setValue('nul', null), value: null },
  },
]

/** Every `form.list` key is set and distinct, one per element. */
function expectListMatches(form: any, path: string): void {
  const keys = form.list(path).map((field: any) => field.key)
  expect(keys).toHaveLength(form.values[path].length)
  expect(new Set(keys).size).toBe(keys.length)
  expect(keys.every((key: string) => key !== '')).toBe(true)
}

describe.each(ADAPTERS)('$name: a write whose only change holds no leaf', (adapter) => {
  it('a container that holds no leaf at the baseline reads as one, untouched', () => {
    const form = mount(adapter)
    for (const path of [['opt'], ['box'], ['rows'], ['matrix', 1]]) {
      expect(form.fields(path).updatedAt).toBeNull()
      expect(form.fields(path).dirty).toBe(false)
    }
    expect(form.meta.dirty).toBe(false)
  })

  describe.each(OPS)('$name', (op) => {
    it('lands, stamps forward, reads dirty and keeps list keys matched', () => {
      const form = mount(adapter)
      vi.setSystemTime(T1)
      op.run(form)
      expect(form.values[op.key]).toEqual(op.after)
      expect(form.meta.updatedAt).toBe(T1.toISOString())
      expect(form.fields(op.container).updatedAt).toBe(T1.toISOString())
      expect(form.meta.dirty).toBe(true)
      expect(form.fields([op.key]).dirty).toBe(true)
      if (op.list !== undefined) expectListMatches(form, op.list)
      if (op.back !== undefined) {
        vi.setSystemTime(T2)
        op.back.run(form)
        expect(form.values[op.key]).toEqual(op.back.value)
        expect(form.meta.updatedAt).toBe(T2.toISOString())
        expect(form.meta.dirty).toBe(false)
        expect(form.fields([op.key]).dirty).toBe(false)
      }
    })

    it('undo and redo restore it', () => {
      const form = mount(adapter)
      const before = JSON.parse(JSON.stringify(form.values[op.key]))
      op.run(form)
      vi.setSystemTime(T2)
      expect(form.history.undo()).toBe(true)
      expect(form.values[op.key]).toEqual(before)
      expect(form.meta.dirty).toBe(false)
      if (op.list !== undefined) expectListMatches(form, op.list)
      vi.setSystemTime(T3)
      expect(form.history.redo()).toBe(true)
      expect(form.values[op.key]).toEqual(op.after)
      expect(form.meta.updatedAt).toBe(T3.toISOString())
      expect(form.meta.dirty).toBe(true)
      if (op.list !== undefined) expectListMatches(form, op.list)
    })
  })

  it('resetField restores a container that held no leaf at the baseline', () => {
    const form = mount(adapter)
    form.setValue('opt', ['x', 'y'])
    form.resetField('opt')
    expect(form.values.opt).toEqual([])
    expect(form.fields(['opt']).dirty).toBe(false)
    // The restored array is the form's own: editing it leaves the baseline.
    form.append('opt', 'z')
    form.resetField('opt')
    expect(form.values.opt).toEqual([])
  })
})
