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
 * Dictionary forms: a `z.record(K, V)` schema root. The form value is a
 * homogeneous map keyed by runtime-known keys (a members table keyed by
 * member id, a settings editor, a tag map). `form.record()` with no
 * argument is the root entry view, one `FieldState` per entry. zod-v3
 * and zod-v4 are first-class peers, so the suite runs against both.
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
const uniqueKey = (prefix: string): string => `frec-root-${prefix}-${(counter += 1)}`

type Member = { role: string; tier: number }
type RootRecordForm = Record<string, Member>

// `useForm` overloads differ between adapters; the suite only needs the
// shared runtime surface (`record`, `fields`, `setValue`, `register`).
type SharedForm = UseFormReturnType<RootRecordForm>

function runRootRecordSuite(
  label: string,
  buildForm: (key: string) => { api: SharedForm; unmount: () => void },
  buildEmpty: (key: string) => { api: SharedForm; unmount: () => void }
): void {
  describe(`record root (${label})`, () => {
    const callFields = (form: SharedForm, path: string): { readonly key: string; value: unknown } =>
      (form.fields as unknown as (p: string) => { readonly key: string; value: unknown })(path)

    it('exposes one field state per entry, keyed by the entry key', () => {
      const { api, unmount } = buildForm(uniqueKey('shape'))
      try {
        const entries = api.record()
        expect(Object.keys(entries)).toEqual(['alice', 'bob'])
        expect(entries['alice']?.value).toEqual({ role: 'admin', tier: 1 })
        expect(entries['bob']?.value).toEqual({ role: 'member', tier: 2 })
      } finally {
        unmount()
      }
    })

    it('reads entry sub-fields through the form value surface', () => {
      const { api, unmount } = buildForm(uniqueKey('read'))
      try {
        expect(api.values()['alice']?.role).toBe('admin')
      } finally {
        unmount()
      }
    })

    it('root entries are the same field states the fields call form returns', () => {
      const { api, unmount } = buildForm(uniqueKey('same'))
      try {
        expect(api.record()['alice']).toBe(callFields(api, 'alice'))
      } finally {
        unmount()
      }
    })

    it('grows when an entry is added via setValue', () => {
      const { api, unmount } = buildForm(uniqueKey('grow'))
      try {
        api.setValue('carol', { role: 'member', tier: 3 })
        const entries = api.record()
        expect(Object.keys(entries)).toEqual(['alice', 'bob', 'carol'])
        expect(entries['carol']?.value).toEqual({ role: 'member', tier: 3 })
      } finally {
        unmount()
      }
    })

    it('updates an entry sub-field through a dotted path', () => {
      const { api, unmount } = buildForm(uniqueKey('subfield'))
      try {
        api.setValue('alice.role', 'owner')
        expect(api.record()['alice']?.value).toEqual({ role: 'owner', tier: 1 })
      } finally {
        unmount()
      }
    })

    it('defaults a bare record root to an empty map', () => {
      const { api, unmount } = buildEmpty(uniqueKey('empty'))
      try {
        expect(api.values()).toEqual({})
        expect(Object.keys(api.record())).toEqual([])
      } finally {
        unmount()
      }
    })

    it('is a frozen, read-only object', () => {
      const { api, unmount } = buildForm(uniqueKey('frozen'))
      try {
        expect(Object.isFrozen(api.record())).toBe(true)
      } finally {
        unmount()
      }
    })
  })
}

runRootRecordSuite(
  'zod-v4',
  (key) =>
    mountWith(() =>
      useFormV4({
        schema: zV4.record(zV4.string(), zV4.object({ role: zV4.string(), tier: zV4.number() })),
        defaultValues: { alice: { role: 'admin', tier: 1 }, bob: { role: 'member', tier: 2 } },
        key,
      })
    ) as { api: SharedForm; unmount: () => void },
  (key) =>
    mountWith(() =>
      useFormV4({
        schema: zV4.record(zV4.string(), zV4.object({ role: zV4.string(), tier: zV4.number() })),
        key,
      })
    ) as { api: SharedForm; unmount: () => void }
)

runRootRecordSuite(
  'zod-v3',
  (key) =>
    mountWith(() =>
      useFormV3({
        schema: zV3.record(zV3.string(), zV3.object({ role: zV3.string(), tier: zV3.number() })),
        defaultValues: { alice: { role: 'admin', tier: 1 }, bob: { role: 'member', tier: 2 } },
        key,
      })
    ) as { api: SharedForm; unmount: () => void },
  (key) =>
    mountWith(() =>
      useFormV3({
        schema: zV3.record(zV3.string(), zV3.object({ role: zV3.string(), tier: zV3.number() })),
        key,
      })
    ) as { api: SharedForm; unmount: () => void }
)

describe('record root typing', () => {
  it('offers the no-arg record() view and rejects path-addressed entries', () => {
    const { api, unmount } = mountWith(() =>
      useFormV4({
        schema: zV4.record(zV4.string(), zV4.object({ role: zV4.string(), tier: zV4.number() })),
        defaultValues: { alice: { role: 'admin', tier: 1 } },
        key: uniqueKey('types'),
      })
    )
    try {
      expectTypeOf(api.record()).toEqualTypeOf<
        Readonly<Record<string, FieldState<{ role: string; tier: number }>>>
      >()
      // @ts-expect-error a record root is viewed at the root; entries are not record paths
      api.record('alice')
    } finally {
      unmount()
    }
  })

  it('rejects the no-arg record() view on a fixed-object root', () => {
    const { api, unmount } = mountWith(() =>
      useFormV4({
        schema: zV4.object({ title: zV4.string() }),
        key: uniqueKey('fixed'),
      })
    )
    try {
      // @ts-expect-error a fixed-object root has no no-arg record() view
      api.record()
    } finally {
      unmount()
    }
  })
})
