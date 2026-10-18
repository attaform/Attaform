// @vitest-environment jsdom
/**
 * `dirty` sees every removal, and no `flush: 'sync'` observer freezes it
 * (#705, decision D7 of the #705 plan).
 *
 * A container's `dirty` comes from a walk over the leaves present now, plus
 * two structural answers the walk cannot give: whether a tracked array's
 * length or order left its baseline, and whether a path that held a real
 * baseline value was removed and is still absent. Both answers live in
 * plain collections Vue cannot see. So:
 *
 * - a removed path has to be recorded wherever a write takes it away, a
 *   dropped key and a parent write that resizes a nested array included, or
 *   the containers above it read pristine;
 * - a write that brings it back (or grows an array back to its baseline) has
 *   to return them to pristine;
 * - a `flush: 'sync'` observer evaluates the reading in the middle of the
 *   write, after the value moved and before the bookkeeping caught up, so
 *   the bookkeeping has to wake it again once it has.
 *
 * Every row runs unobserved (readings cached before the write) and under
 * `flush: 'sync'` watchers on each reading it asserts. The last block pins
 * the same freeze in the blank bookkeeping, another structure Vue cannot
 * see, on the writes that move it: `reset` and a typed array op.
 *
 * Mirrored across both adapters: the bookkeeping is shared core.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it } from 'vitest'
import { watch, type App, type WatchStopHandle } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { unset, useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { makeMounter } from '../utils/form-harness'

const ADAPTERS = [
  { name: 'zod-v4', z: zV4 as any, useForm: useFormV4 as any },
  { name: 'zod-v3', z: zV3 as any, useForm: useFormV3 as any },
] as const

type Adapter = (typeof ADAPTERS)[number]
type Observation = 'unobserved' | 'sync-observed'
const OBSERVATIONS: readonly Observation[] = ['unobserved', 'sync-observed']

const makeSchema = (z: any): any =>
  z.object({
    note: z.string(),
    addr: z.object({ street: z.string(), unit: z.string().optional() }),
    tags: z.array(z.string()),
    profile: z.object({ langs: z.array(z.string()) }),
    rows: z.array(z.object({ amount: z.string(), memo: z.string().optional() })),
    lists: z.array(z.object({ items: z.array(z.string()) })),
  })

const defaults = () => ({
  note: 'n',
  addr: { street: 's', unit: 'u' },
  tags: ['a', 'b', 'c'],
  profile: { langs: ['en', 'fr'] },
  rows: [
    { amount: '1', memo: 'm1' },
    { amount: '2', memo: 'm2' },
  ],
  lists: [{ items: ['x', 'y'] }, { items: ['z'] }],
})

const apps: App[] = []
const stops: WatchStopHandle[] = []

afterEach(() => {
  while (stops.length > 0) stops.pop()?.()
  while (apps.length > 0) apps.pop()?.unmount()
})

function mount(adapter: Adapter, options: Record<string, unknown> = {}): any {
  const { api, app } = makeMounter(adapter.useForm, makeSchema(adapter.z), {
    defaultValues: defaults(),
    validateOn: 'submit',
    ...options,
  })()
  apps.push(app)
  return api
}

/** `form.fields` at a dotted path, `''` naming the root. */
const fieldAt = (form: any, path: string): any => form.fields(path === '' ? [] : path)

/** `form.meta.dirty`, then `dirty` at each path. */
function dirtyAt(form: any, paths: readonly string[]): Record<string, boolean> {
  const out: Record<string, boolean> = { meta: form.meta.dirty === true }
  for (const path of paths) out[path] = fieldAt(form, path)?.dirty === true
  return out
}

/** Read every reading the row asserts, and under 'sync-observed' watch each. */
function observe(form: any, observation: Observation, paths: readonly string[]): void {
  if (observation === 'unobserved') {
    dirtyAt(form, paths)
    return
  }
  stops.push(
    watch(
      () => form.meta.dirty,
      () => {},
      { flush: 'sync' }
    )
  )
  for (const path of paths) {
    stops.push(
      watch(
        () => fieldAt(form, path)?.dirty,
        () => {},
        { flush: 'sync' }
      )
    )
  }
}

const all = (paths: readonly string[], value: boolean): Record<string, boolean> => ({
  meta: value,
  ...Object.fromEntries(paths.map((path) => [path, value])),
})

describe.each(ADAPTERS)('$name: dirty sees every removal', (adapter) => {
  describe.each(OBSERVATIONS)('%s', (observation) => {
    it('a dropped baseline key dirties its containers, and restoring it returns to pristine', () => {
      const form = mount(adapter)
      const paths = ['', 'addr', 'addr.unit']
      observe(form, observation, paths)
      form.setValue('addr', { street: 's' })
      expect(dirtyAt(form, paths)).toEqual(all(paths, true))
      form.setValue('addr', { street: 's', unit: 'u' })
      expect(dirtyAt(form, paths)).toEqual(all(paths, false))
    })

    it('a dropped key follows its row through a typed op, and restoring it returns to pristine', () => {
      const form = mount(adapter)
      const paths = ['', 'rows', 'rows.0', 'rows.1']
      observe(form, observation, paths)
      form.setValue('rows.0', { amount: '1' })
      expect(dirtyAt(form, paths)).toEqual({
        meta: true,
        '': true,
        rows: true,
        'rows.0': true,
        'rows.1': false,
      })
      // The row that lost its memo moves to index 1, and the loss with it.
      form.swap('rows', 0, 1)
      expect(dirtyAt(form, ['rows.0', 'rows.1'])).toEqual({
        meta: true,
        'rows.0': false,
        'rows.1': true,
      })
      form.swap('rows', 0, 1)
      form.setValue('rows.0.memo', 'm1')
      expect(dirtyAt(form, paths)).toEqual(all(paths, false))
    })

    it('a nested array shrunk in a row follows the row through a typed op', () => {
      const form = mount(adapter)
      const paths = ['lists.0', 'lists.1']
      observe(form, observation, paths)
      form.remove('lists.0.items', 1)
      expect(dirtyAt(form, paths)).toEqual({ meta: true, 'lists.0': true, 'lists.1': false })
      // The row whose list lost an item moves to index 1, and the change with it.
      form.swap('lists', 0, 1)
      expect(dirtyAt(form, paths)).toEqual({ meta: true, 'lists.0': false, 'lists.1': true })
    })

    it('a parent write that shrinks a nested array dirties it, and restoring it returns to pristine', () => {
      const form = mount(adapter)
      const paths = ['', 'profile', 'profile.langs']
      observe(form, observation, paths)
      form.setValue('profile', { langs: ['en'] })
      expect(dirtyAt(form, paths)).toEqual(all(paths, true))
      form.setValue('profile', { langs: ['en', 'fr'] })
      expect(dirtyAt(form, paths)).toEqual(all(paths, false))
    })

    it('a shrink by setValue reads dirty at the array and the root', () => {
      const form = mount(adapter)
      const paths = ['', 'tags']
      observe(form, observation, paths)
      form.setValue('tags', ['a'])
      expect(form.meta.dirty).toBe(true)
      expect(form.fields(['tags']).dirty).toBe(true)
      expect(dirtyAt(form, paths)).toEqual(all(paths, true))
    })

    it('a shrink by remove reads dirty at the array and the root', () => {
      const form = mount(adapter)
      const paths = ['', 'tags']
      observe(form, observation, paths)
      form.remove('tags', 2)
      expect(form.meta.dirty).toBe(true)
      expect(form.fields(['tags']).dirty).toBe(true)
      expect(dirtyAt(form, paths)).toEqual(all(paths, true))
    })

    it('a wholesale write that grows an array back to its baseline reads pristine', () => {
      const form = mount(adapter)
      const paths = ['', 'tags']
      observe(form, observation, paths)
      form.setValue('tags', [])
      expect(dirtyAt(form, paths)).toEqual(all(paths, true))
      form.setValue('tags', ['a', 'b', 'c'])
      expect(dirtyAt(form, paths)).toEqual(all(paths, false))
    })

    it('reset() clears every recorded removal', () => {
      const form = mount(adapter)
      const paths = ['', 'addr', 'rows', 'tags']
      observe(form, observation, paths)
      form.setValue('addr', { street: 's' })
      form.setValue('rows.1', { amount: '2' })
      form.setValue('tags', ['a'])
      expect(dirtyAt(form, paths)).toEqual(all(paths, true))
      form.reset()
      expect(dirtyAt(form, paths)).toEqual(all(paths, false))
    })
  })
})

describe.each(ADAPTERS)('$name: the blank bookkeeping wakes a sync observer', (adapter) => {
  it('reset() marking a path blank settles pristine', () => {
    const form = mount(adapter)
    observe(form, 'sync-observed', ['', 'note'])
    form.reset({ note: unset })
    expect(dirtyAt(form, ['', 'note'])).toEqual(all(['', 'note'], false))
  })

  // A guard: `reset()` writes the field records after it settles the blank
  // sets, which wakes the observer on main too. The pin is the order inside
  // `reset()`, should that later write move.
  it('reset() re-deciding a construction-blank path the user filled settles pristine', () => {
    const form = mount(adapter, { defaultValues: { ...defaults(), note: unset } })
    form.setValue('note', 'typed')
    observe(form, 'sync-observed', ['', 'note'])
    form.reset({ note: 'saved' })
    expect(dirtyAt(form, ['', 'note'])).toEqual(all(['', 'note'], false))
  })

  it('a typed op moves the blank baseline before a sync observer reads it', () => {
    const form = mount(adapter, {
      defaultValues: { ...defaults(), rows: [{ amount: unset }, { amount: '2' }] },
    })
    form.setValue('rows.0.amount', '1')
    observe(form, 'sync-observed', ['rows.0', 'rows.1'])
    form.swap('rows', 0, 1)
    // Index 0 now holds the untouched second row; index 1 the edited first.
    expect(dirtyAt(form, ['rows.0', 'rows.1'])).toEqual({
      meta: true,
      'rows.0': false,
      'rows.1': true,
    })
  })
})
