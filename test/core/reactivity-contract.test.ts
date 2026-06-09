// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, watch, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Reactivity contract for the targeted in-place write (Bust 2 / T2).
 *
 * The standing lock for the ONE intended observable change: a container's
 * object reference changes IFF the write targets that container or alters
 * its structure. A write to a descendant LEAF mutates the leaf's slot in
 * place, preserving the identity of every ancestor container.
 *
 * Consequence (the thing this suite pins): a by-reference (non-deep) watch
 * on a container STOPS firing when only a descendant leaf changes. Deep
 * watches and leaf watches are unchanged. Everything else (values, errors,
 * dirty, list/key identity) is locked byte-identical by the behavior-lock
 * golden — this suite owns the reactivity surface the golden can't see.
 *
 * Captured against both adapters per zod-v3/v4 parity: the write path is
 * shared core, so a regression would move both identically and slip past
 * cross-adapter checks alone.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Adapter = { tag: string; z: any; useForm: any }
const ADAPTERS: Adapter[] = [
  { tag: 'v4', z: zV4, useForm: useFormV4 },
  { tag: 'v3', z: zV3 as any, useForm: useFormV3 },
]

const apps: App[] = []
afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
  document.body.innerHTML = ''
})

function mount(a: Adapter): any {
  const schema = a.z.object({
    a: a.z.string(),
    address: a.z.object({ zip: a.z.string(), city: a.z.string() }),
    rows: a.z.array(a.z.object({ name: a.z.string(), qty: a.z.number() })),
  })
  const defaultValues = {
    a: '',
    address: { zip: '', city: '' },
    rows: [
      { name: 'r0', qty: 0 },
      { name: 'r1', qty: 1 },
      { name: 'r2', qty: 2 },
    ],
  }
  let captured: any
  const App = defineComponent({
    setup() {
      captured = a.useForm({
        schema,
        key: `reactivity-contract-${a.tag}-${Math.random().toString(36).slice(2)}`,
        defaultValues,
      })
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  apps.push(app)
  if (captured === undefined) throw new Error('useForm did not return')
  return captured
}

describe.each(ADAPTERS)(
  'reactivity contract — ancestor identity stable on leaf write [$tag]',
  (a) => {
    it('a descendant-leaf write does NOT fire a by-ref watch on its container; deep + leaf watches DO', async () => {
      const form = mount(a)

      let rowsByRef = 0
      let rowsDeep = 0
      let rowLeaf = 0
      const stops = [
        watch(
          () => form.values.rows,
          () => {
            rowsByRef++
          }
        ),
        watch(
          () => form.values.rows,
          () => {
            rowsDeep++
          },
          { deep: true }
        ),
        watch(
          () => form.values.rows[1]?.name,
          () => {
            rowLeaf++
          }
        ),
      ]

      const rowsBefore = form.values.rows
      const row1Before = form.values.rows[1]

      form.setValue('rows.1.name', 'EDITED')
      await nextTick()

      // The intended change: editing a row FIELD leaves the array reference
      // (and the row's own reference) untouched — a by-ref watcher stays quiet.
      expect(rowsByRef).toBe(0)
      expect(form.values.rows).toBe(rowsBefore)
      expect(form.values.rows[1]).toBe(row1Before)

      // Deep and leaf reactivity are unchanged: both see the edit.
      expect(rowsDeep).toBeGreaterThan(0)
      expect(rowLeaf).toBeGreaterThan(0)
      expect(form.values.rows[1]?.name).toBe('EDITED')

      stops.forEach((s) => s())
    })

    it('a nested-leaf write preserves the parent object reference; the container-target write replaces it', async () => {
      const form = mount(a)

      let addressByRef = 0
      const stop = watch(
        () => form.values.address,
        () => {
          addressByRef++
        }
      )

      const addressBefore = form.values.address

      // Leaf write under address: address keeps identity, by-ref watch quiet.
      form.setValue('address.zip', '90210')
      await nextTick()
      expect(addressByRef).toBe(0)
      expect(form.values.address).toBe(addressBefore)
      expect(form.values.address.zip).toBe('90210')

      // Container-TARGET write: address is the write target, so it (correctly)
      // gets a new reference and the by-ref watch fires.
      form.setValue('address', { zip: '10001', city: 'NYC' })
      await nextTick()
      expect(addressByRef).toBeGreaterThan(0)
      expect(form.values.address).not.toBe(addressBefore)

      stop()
    })

    it('does not deadlock when a sibling watcher writes back (mirror pattern)', async () => {
      const form = mount(a)
      const stop = watch(
        () => form.values.a,
        (next) => {
          // Mirror `a` into `address.city` — a write-back on every change.
          form.setValue('address.city', String(next))
        }
      )

      form.setValue('a', 'mirror-me')
      await nextTick()
      await nextTick()

      expect(form.values.a).toBe('mirror-me')
      expect(form.values.address.city).toBe('mirror-me')

      stop()
    })
  }
)
