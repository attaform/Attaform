// @vitest-environment jsdom
import { createApp, defineComponent, h } from 'vue'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z as zV3 } from 'zod-v3'
import { z as zV4 } from 'zod'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { useForm as useFormV4 } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { FieldState, UseFormReturnType } from '../../src/runtime/types/types-api'

/**
 * `form.list` over a record. The array-vs-record fork is decided at
 * runtime from the value (`Array.isArray`), and a record entry's `key`
 * is its natural key, surfaced through the existing `getSchemasAtPath`
 * contract. zod-v3 and zod-v4 are first-class peers, so the same suite
 * runs against both adapters.
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
const uniqueKey = (prefix: string): string => `flr-${prefix}-${(counter += 1)}`

type RecordSuiteForm = {
  title: string
  scores: Record<string, number>
  meta: { label: string }
}

// `useForm` overloads differ between adapters; the suite only needs the
// shared runtime surface (`list`, `fields`, `setValue`, `values`).
type SharedForm = UseFormReturnType<RecordSuiteForm>

function runRecordSuite(
  label: string,
  buildForm: (key: string) => { api: SharedForm; unmount: () => void }
): void {
  describe(`form.list over a record (${label})`, () => {
    const callFields = (form: SharedForm, path: string): { readonly key: string; value: unknown } =>
      (form.fields as unknown as (p: string) => { readonly key: string; value: unknown })(path)

    it('returns one entry per key, in insertion order, with values', () => {
      const { api, unmount } = buildForm(uniqueKey('order'))
      try {
        const rows = api.list('scores')
        expect(rows).toHaveLength(2)
        expect(rows.map((row) => row.value)).toEqual([1, 2])
      } finally {
        unmount()
      }
    })

    it('each entry carries its natural key', () => {
      const { api, unmount } = buildForm(uniqueKey('keys'))
      try {
        expect(api.list('scores').map((row) => row.key)).toEqual(['alpha', 'beta'])
      } finally {
        unmount()
      }
    })

    it('entries are the same field states the form.fields call form returns', () => {
      const { api, unmount } = buildForm(uniqueKey('same'))
      try {
        expect(api.list('scores')[0]).toBe(callFields(api, 'scores.alpha'))
        expect(api.list('scores')[1]).toBe(callFields(api, 'scores.beta'))
      } finally {
        unmount()
      }
    })

    it('grows when a key is added and the key follows it', () => {
      const { api, unmount } = buildForm(uniqueKey('grow'))
      try {
        api.setValue('scores.gamma', 3)
        const rows = api.list('scores')
        expect(rows).toHaveLength(3)
        expect(rows.map((row) => row.key)).toEqual(['alpha', 'beta', 'gamma'])
        expect(rows.map((row) => row.value)).toEqual([1, 2, 3])
      } finally {
        unmount()
      }
    })

    it('shrinks when a key is dropped via a wholesale write', () => {
      const { api, unmount } = buildForm(uniqueKey('shrink'))
      try {
        api.setValue('scores', { beta: 2 })
        const rows = api.list('scores')
        expect(rows).toHaveLength(1)
        expect(rows[0]?.key).toBe('beta')
      } finally {
        unmount()
      }
    })

    it('keeps fixed-object fields and the record container keyless', () => {
      const { api, unmount } = buildForm(uniqueKey('keyless'))
      try {
        // A fixed-shape object field and a plain scalar are not
        // collection elements, so their key is empty.
        expect(callFields(api, 'meta.label').key).toBe('')
        expect(callFields(api, 'title').key).toBe('')
        // The record container itself is the aggregate, not an element.
        expect(callFields(api, 'scores').key).toBe('')
      } finally {
        unmount()
      }
    })

    it('is a frozen, read-only array', () => {
      const { api, unmount } = buildForm(uniqueKey('frozen'))
      try {
        expect(Object.isFrozen(api.list('scores'))).toBe(true)
      } finally {
        unmount()
      }
    })
  })
}

runRecordSuite(
  'zod-v4',
  (key) =>
    mountWith(() =>
      useFormV4({
        schema: zV4.object({
          title: zV4.string(),
          scores: zV4.record(zV4.string(), zV4.number()),
          meta: zV4.object({ label: zV4.string() }),
        }),
        defaultValues: { title: 't', scores: { alpha: 1, beta: 2 }, meta: { label: 'm' } },
        key,
      })
    ) as { api: SharedForm; unmount: () => void }
)

runRecordSuite(
  'zod-v3',
  (key) =>
    mountWith(() =>
      useFormV3({
        schema: zV3.object({
          title: zV3.string(),
          scores: zV3.record(zV3.string(), zV3.number()),
          meta: zV3.object({ label: zV3.string() }),
        }),
        defaultValues: { title: 't', scores: { alpha: 1, beta: 2 }, meta: { label: 'm' } },
        key,
      })
    ) as { api: SharedForm; unmount: () => void }
)

describe('form.list collection-path typing', () => {
  it('accepts records and arrays, rejects scalars and fixed objects', () => {
    const { api, unmount } = mountWith(() =>
      useFormV4({
        schema: zV4.object({
          title: zV4.string(),
          roster: zV4.array(zV4.string()),
          scores: zV4.record(zV4.string(), zV4.number()),
          meta: zV4.object({ label: zV4.string() }),
        }),
        defaultValues: { title: 't', roster: ['a'], scores: { x: 1 }, meta: { label: 'm' } },
        key: uniqueKey('types'),
      })
    )
    try {
      expectTypeOf(api.list('scores')).toEqualTypeOf<readonly FieldState<number>[]>()
      expectTypeOf(api.list('roster')).toEqualTypeOf<readonly FieldState<string>[]>()
      // @ts-expect-error a scalar leaf is not a collection
      api.list('title')
      // @ts-expect-error a fixed-shape object is not a collection
      api.list('meta')
    } finally {
      unmount()
    }
  })
})
