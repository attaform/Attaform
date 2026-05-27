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
 * `form.record` reads a record at `path` as one `FieldState` per entry,
 * keyed by the entry's own key — the keyed-object counterpart to the
 * ordered array `form.list` returns for an array path. zod-v3 and zod-v4
 * are first-class peers, so the same suite runs against both adapters.
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
const uniqueKey = (prefix: string): string => `frec-${prefix}-${(counter += 1)}`

type RecordSuiteForm = {
  title: string
  scores: Record<string, number>
  meta: { label: string }
}

// `useForm` overloads differ between adapters; the suite only needs the
// shared runtime surface (`record`, `fields`, `setValue`).
type SharedForm = UseFormReturnType<RecordSuiteForm>

function runRecordSuite(
  label: string,
  buildForm: (key: string) => { api: SharedForm; unmount: () => void }
): void {
  describe(`form.record (${label})`, () => {
    const callFields = (form: SharedForm, path: string): { readonly key: string; value: unknown } =>
      (form.fields as unknown as (p: string) => { readonly key: string; value: unknown })(path)

    it('returns one field state per key, keyed by the key, with values', () => {
      const { api, unmount } = buildForm(uniqueKey('shape'))
      try {
        const entries = api.record('scores')
        expect(Object.keys(entries)).toEqual(['alpha', 'beta'])
        expect(entries['alpha']?.value).toBe(1)
        expect(entries['beta']?.value).toBe(2)
      } finally {
        unmount()
      }
    })

    it('keys mirror the record keys, in insertion order', () => {
      const { api, unmount } = buildForm(uniqueKey('order'))
      try {
        expect(Object.keys(api.record('scores'))).toEqual(['alpha', 'beta'])
      } finally {
        unmount()
      }
    })

    it('entries are the same field states the form.fields call form returns', () => {
      const { api, unmount } = buildForm(uniqueKey('same'))
      try {
        expect(api.record('scores')['alpha']).toBe(callFields(api, 'scores.alpha'))
        expect(api.record('scores')['beta']).toBe(callFields(api, 'scores.beta'))
      } finally {
        unmount()
      }
    })

    it('grows when a key is added', () => {
      const { api, unmount } = buildForm(uniqueKey('grow'))
      try {
        api.setValue('scores.gamma', 3)
        const entries = api.record('scores')
        expect(Object.keys(entries)).toEqual(['alpha', 'beta', 'gamma'])
        expect(entries['gamma']?.value).toBe(3)
      } finally {
        unmount()
      }
    })

    it('shrinks when a key is dropped via a wholesale write', () => {
      const { api, unmount } = buildForm(uniqueKey('shrink'))
      try {
        api.setValue('scores', { beta: 2 })
        expect(Object.keys(api.record('scores'))).toEqual(['beta'])
      } finally {
        unmount()
      }
    })

    it('keeps a record entry FieldState keyless — the key lives on the record view', () => {
      const { api, unmount } = buildForm(uniqueKey('keyless'))
      try {
        // FieldState.key is the array-element identity token; a record
        // entry's stable identity is its own key, surfaced by the
        // `form.record` object, so the entry's `key` stays empty.
        expect(callFields(api, 'scores.alpha').key).toBe('')
        expect(callFields(api, 'meta.label').key).toBe('')
        expect(callFields(api, 'title').key).toBe('')
      } finally {
        unmount()
      }
    })

    it('is a frozen, read-only object', () => {
      const { api, unmount } = buildForm(uniqueKey('frozen'))
      try {
        expect(Object.isFrozen(api.record('scores'))).toBe(true)
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

describe('form.record / form.list path typing', () => {
  it('record accepts records only; list accepts arrays only', () => {
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
      expectTypeOf(api.record('scores')).toEqualTypeOf<
        Readonly<Record<string, FieldState<number>>>
      >()
      expectTypeOf(api.list('roster')).toEqualTypeOf<readonly FieldState<string>[]>()
      // @ts-expect-error a scalar leaf is not a record
      api.record('title')
      // @ts-expect-error a fixed-shape object is not a record
      api.record('meta')
      // @ts-expect-error an array is read through `list`, not `record`
      api.record('roster')
      // @ts-expect-error a record is read through `record`, not `list`
      api.list('scores')
    } finally {
      unmount()
    }
  })
})
