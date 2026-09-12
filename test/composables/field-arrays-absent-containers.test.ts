// @vitest-environment jsdom
import { createApp, defineComponent, h } from 'vue'
import { describe, expect, it } from 'vitest'
import { z as zV3 } from 'zod-v3'
import { z as zV4 } from 'zod'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { useForm as useFormV4 } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * The field-array helpers against a container that is not there yet: an
 * `.optional()` array, a `.nullable()` array seeded null, a
 * `.default([])` array, and an array inside a discriminated-union
 * variant.
 *
 * The engine always accepted every one of these. The typed path union
 * did not, which is what #541 reported, and
 * `container-path-filters.test.ts` pins that type side. This file pins
 * the behaviour the docs promise beside it: the adding helpers create
 * the array on first write, the reordering helpers no-op while it is
 * absent, and `form.list` / `form.record` read empty instead of
 * throwing. zod-v3 and zod-v4 are first-class peers, so the suite runs
 * against both.
 *
 * The absent cases pass no `defaultValues` at all. That is the one way
 * to reach a genuinely absent optional container: supplying a
 * `defaultValues` object, even one that names no array, runs the
 * defaults walk, which seeds an optional array to `[]`.
 */

function mountWith<R>(setup: () => R): { api: R; unmount: () => void } {
  let captured: R | undefined
  const App = defineComponent({
    setup() {
      captured = setup()
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  if (captured === undefined) throw new Error('mountWith: setup never returned')
  return {
    api: captured,
    unmount: () => {
      app.unmount()
      document.body.removeChild(root)
    },
  }
}

let counter = 0
const uniqueKey = (prefix: string): string => `fa-absent-${prefix}-${(counter += 1)}`

describe('field-array helpers on an absent container (zod-v4)', () => {
  const row = zV4.object({ a: zV4.string() })
  const buildAbsent = (key: string) =>
    mountWith(() =>
      useFormV4({
        schema: zV4.object({
          rows: zV4.array(row).optional(),
          scores: zV4.record(zV4.string(), zV4.number()).optional(),
        }),
        key,
      })
    )
  const buildSeeded = (key: string) =>
    mountWith(() =>
      useFormV4({
        schema: zV4.object({
          nullableRows: zV4.array(row).nullable(),
          defaulted: zV4.array(row).default([{ a: 'seed' }]),
          income: zV4.discriminatedUnion('exists', [
            zV4.object({ exists: zV4.literal(true), entries: zV4.array(row).min(1) }),
            zV4.object({ exists: zV4.literal(false), entries: zV4.array(row).max(0).default([]) }),
          ]),
        }),
        defaultValues: {
          nullableRows: null,
          income: { exists: true, entries: [{ a: '100' }] },
        },
        key,
      })
    )

  it('append creates an absent optional array', () => {
    const { api, unmount } = buildAbsent(uniqueKey('append'))
    expect(api.values('rows')).toBeUndefined()
    api.append('rows', { a: '1' })
    expect(api.values('rows')).toEqual([{ a: '1' }])
    unmount()
  })

  it('prepend and insert create an absent optional array too', () => {
    const { api, unmount } = buildAbsent(uniqueKey('prepend'))
    api.prepend('rows', { a: 'first' })
    api.insert('rows', 0, { a: 'zeroth' })
    expect(api.values('rows')).toEqual([{ a: 'zeroth' }, { a: 'first' }])
    unmount()
  })

  it('swap, move, remove and replace no-op while the array is absent', () => {
    const { api, unmount } = buildAbsent(uniqueKey('reorder'))
    api.swap('rows', 0, 1)
    api.move('rows', 0, 1)
    api.remove('rows', 0)
    api.replace('rows', 0, { a: 'x' })
    expect(api.values('rows')).toBeUndefined()
    unmount()
  })

  it('list and record read an absent container as empty', () => {
    const { api, unmount } = buildAbsent(uniqueKey('read'))
    expect(api.list('rows')).toEqual([])
    expect(api.record('scores')).toEqual({})
    unmount()
  })

  it('append creates a nullable array seeded null', () => {
    const { api, unmount } = buildSeeded(uniqueKey('nullable'))
    expect(api.values('nullableRows')).toBeNull()
    api.append('nullableRows', { a: '1' })
    expect(api.values('nullableRows')).toEqual([{ a: '1' }])
    unmount()
  })

  it('append lands after a defaulted array contents', () => {
    const { api, unmount } = buildSeeded(uniqueKey('defaulted'))
    api.append('defaulted', { a: 'next' })
    expect(api.values('defaulted')).toEqual([{ a: 'seed' }, { a: 'next' }])
    expect(api.list('defaulted')).toHaveLength(2)
    unmount()
  })

  it('appends into a discriminated-union variant array and flips the variant', () => {
    const { api, unmount } = buildSeeded(uniqueKey('du'))
    api.append('income.entries', { a: '2' })
    expect(api.values('income.entries')).toEqual([{ a: '100' }, { a: '2' }])
    api.setValue('income.exists', false)
    expect(api.values('income.exists')).toBe(false)
    unmount()
  })
})

describe('field-array helpers on an absent container (zod-v3)', () => {
  const row = zV3.object({ a: zV3.string() })
  const buildAbsent = (key: string) =>
    mountWith(() =>
      useFormV3({
        schema: zV3.object({
          rows: zV3.array(row).optional(),
          scores: zV3.record(zV3.string(), zV3.number()).optional(),
        }),
        key,
      })
    )
  const buildSeeded = (key: string) =>
    mountWith(() =>
      useFormV3({
        schema: zV3.object({
          nullableRows: zV3.array(row).nullable(),
          defaulted: zV3.array(row).default([{ a: 'seed' }]),
          income: zV3.discriminatedUnion('exists', [
            zV3.object({ exists: zV3.literal(true), entries: zV3.array(row).min(1) }),
            zV3.object({ exists: zV3.literal(false), entries: zV3.array(row).max(0).default([]) }),
          ]),
        }),
        defaultValues: {
          nullableRows: null,
          income: { exists: true, entries: [{ a: '100' }] },
        },
        key,
      })
    )

  it('append creates an absent optional array', () => {
    const { api, unmount } = buildAbsent(uniqueKey('append'))
    expect(api.values('rows')).toBeUndefined()
    api.append('rows', { a: '1' })
    expect(api.values('rows')).toEqual([{ a: '1' }])
    unmount()
  })

  it('swap, move and remove no-op while the array is absent', () => {
    const { api, unmount } = buildAbsent(uniqueKey('reorder'))
    api.swap('rows', 0, 1)
    api.move('rows', 0, 1)
    api.remove('rows', 0)
    expect(api.values('rows')).toBeUndefined()
    unmount()
  })

  it('list and record read an absent container as empty', () => {
    const { api, unmount } = buildAbsent(uniqueKey('read'))
    expect(api.list('rows')).toEqual([])
    expect(api.record('scores')).toEqual({})
    unmount()
  })

  it('append creates a nullable array seeded null', () => {
    const { api, unmount } = buildSeeded(uniqueKey('nullable'))
    api.append('nullableRows', { a: '1' })
    expect(api.values('nullableRows')).toEqual([{ a: '1' }])
    unmount()
  })

  it('appends into a discriminated-union variant array', () => {
    const { api, unmount } = buildSeeded(uniqueKey('du'))
    api.append('income.entries', { a: '2' })
    expect(api.values('income.entries')).toEqual([{ a: '100' }, { a: '2' }])
    unmount()
  })
})
