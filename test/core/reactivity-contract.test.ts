// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, watch, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Reactivity contract for the targeted in-place write (Bust 2 / T2) and the
 * in-place array reconcile (Tier 2).
 *
 * The standing lock for the intended observable changes: a container's object
 * reference changes IFF the write targets that container or alters its
 * structure — with ONE carve-out for the typed array helpers (below). A write
 * to a descendant LEAF mutates the leaf's slot in place, preserving the
 * identity of every ancestor container.
 *
 * Consequence (the thing this suite pins): a by-reference (non-deep) watch
 * on a container STOPS firing when only a descendant leaf changes. Deep
 * watches and leaf watches are unchanged. Everything else (values, errors,
 * dirty, list/key identity) is locked byte-identical by the behavior-lock
 * golden — this suite owns the reactivity surface the golden can't see.
 *
 * Array carve-out: the typed array helpers (append / insert / remove / swap /
 * move / replace) reconcile the array IN PLACE, so the array's reference stays
 * stable across the op — a reorder fires only the moved indices, not a
 * whole-array re-render. The reconcile also keeps every plain-object container
 * on the path to the array stable, so appending to an object-nested array
 * (`address.contacts`) re-renders only that list, not its parent object's
 * bindings. A by-reference watch on the array (or any object on its path)
 * therefore stays quiet on a helper op; length / element / deep watches fire as
 * before. An EXPLICIT setValue(arrayPath, wholeNewArray) is a container-target
 * write and still replaces the reference, preserving the object/array symmetry.
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
    address: a.z.object({
      zip: a.z.string(),
      city: a.z.string(),
      contacts: a.z.array(a.z.object({ name: a.z.string() })),
    }),
    rows: a.z.array(a.z.object({ name: a.z.string(), qty: a.z.number() })),
  })
  const defaultValues = {
    a: '',
    address: { zip: '', city: '', contacts: [{ name: 'c0' }, { name: 'c1' }] },
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
      form.setValue('address', { zip: '10001', city: 'NYC', contacts: [] })
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

    it('an in-place array op (swap) preserves the array reference; by-ref quiet, deep + moved index fire', async () => {
      const form = mount(a)

      let rowsByRef = 0
      let rowsDeep = 0
      let row0Leaf = 0
      let row1Leaf = 0
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
          () => form.values.rows[0]?.name,
          () => {
            row0Leaf++
          }
        ),
        watch(
          () => form.values.rows[1]?.name,
          () => {
            row1Leaf++
          }
        ),
      ]

      const rowsBefore = form.values.rows

      form.swap('rows', 0, 2)
      await nextTick()

      // The array reference is preserved across the in-place reconcile, so the
      // by-ref watch stays quiet — a reorder is NOT a whole-array re-render.
      expect(rowsByRef).toBe(0)
      expect(form.values.rows).toBe(rowsBefore)

      // Deep reactivity + the two MOVED indices update; the untouched middle
      // row's leaf watch stays quiet (the swap is surgical).
      expect(rowsDeep).toBeGreaterThan(0)
      expect(row0Leaf).toBeGreaterThan(0)
      expect(row1Leaf).toBe(0)
      expect(form.values.rows[0]?.name).toBe('r2')
      expect(form.values.rows[2]?.name).toBe('r0')

      stops.forEach((s) => s())
    })

    it('append keeps the array reference; by-ref quiet, length + deep fire', async () => {
      const form = mount(a)

      let rowsByRef = 0
      let rowsLen = 0
      let rowsDeep = 0
      const stops = [
        watch(
          () => form.values.rows,
          () => {
            rowsByRef++
          }
        ),
        watch(
          () => form.values.rows.length,
          () => {
            rowsLen++
          }
        ),
        watch(
          () => form.values.rows,
          () => {
            rowsDeep++
          },
          { deep: true }
        ),
      ]

      const rowsBefore = form.values.rows

      form.append('rows', { name: 'r3', qty: 3 })
      await nextTick()

      // Append grows the array in place: the reference is preserved (by-ref
      // quiet), but the length and deep watches see the new element.
      expect(rowsByRef).toBe(0)
      expect(form.values.rows).toBe(rowsBefore)
      expect(rowsLen).toBeGreaterThan(0)
      expect(rowsDeep).toBeGreaterThan(0)
      expect(form.values.rows.length).toBe(4)
      expect(form.values.rows[3]?.name).toBe('r3')

      stops.forEach((s) => s())
    })

    it('an explicit setValue to the array path replaces the reference; by-ref fires', async () => {
      const form = mount(a)

      let rowsByRef = 0
      const stop = watch(
        () => form.values.rows,
        () => {
          rowsByRef++
        }
      )

      const rowsBefore = form.values.rows

      // A direct container-target write (no arrayOp hint) replaces the array
      // reference like any other targeted write — the by-ref watch fires.
      form.setValue('rows', [{ name: 'only', qty: 9 }])
      await nextTick()

      expect(rowsByRef).toBeGreaterThan(0)
      expect(form.values.rows).not.toBe(rowsBefore)
      expect(form.values.rows.length).toBe(1)
      expect(form.values.rows[0]?.name).toBe('only')

      stop()
    })

    it('append to an object-nested array keeps the parent object AND array refs stable; length + deep fire', async () => {
      const form = mount(a)

      let addressByRef = 0
      let contactsByRef = 0
      let contactsLen = 0
      let contactsDeep = 0
      const stops = [
        watch(
          () => form.values.address,
          () => {
            addressByRef++
          }
        ),
        watch(
          () => form.values.address.contacts,
          () => {
            contactsByRef++
          }
        ),
        watch(
          () => form.values.address.contacts.length,
          () => {
            contactsLen++
          }
        ),
        watch(
          () => form.values.address.contacts,
          () => {
            contactsDeep++
          },
          { deep: true }
        ),
      ]

      const addressBefore = form.values.address
      const contactsBefore = form.values.address.contacts

      form.append('address.contacts', { name: 'c2' })
      await nextTick()

      // The object spine on the path to the mutated array keeps its reference:
      // appending to a nested array re-renders only that list, not its parent.
      expect(addressByRef).toBe(0)
      expect(contactsByRef).toBe(0)
      expect(form.values.address).toBe(addressBefore)
      expect(form.values.address.contacts).toBe(contactsBefore)

      // Length + deep see the new element; the value is correct.
      expect(contactsLen).toBeGreaterThan(0)
      expect(contactsDeep).toBeGreaterThan(0)
      expect(form.values.address.contacts.length).toBe(3)
      expect(form.values.address.contacts[2]?.name).toBe('c2')

      stops.forEach((s) => s())
    })

    it('swap within an object-nested array keeps the parent object AND array refs stable; moved indices fire', async () => {
      const form = mount(a)

      let addressByRef = 0
      let contactsByRef = 0
      let contactsDeep = 0
      let c0Leaf = 0
      let c1Leaf = 0
      const stops = [
        watch(
          () => form.values.address,
          () => {
            addressByRef++
          }
        ),
        watch(
          () => form.values.address.contacts,
          () => {
            contactsByRef++
          }
        ),
        watch(
          () => form.values.address.contacts,
          () => {
            contactsDeep++
          },
          { deep: true }
        ),
        watch(
          () => form.values.address.contacts[0]?.name,
          () => {
            c0Leaf++
          }
        ),
        watch(
          () => form.values.address.contacts[1]?.name,
          () => {
            c1Leaf++
          }
        ),
      ]

      const addressBefore = form.values.address
      const contactsBefore = form.values.address.contacts

      form.swap('address.contacts', 0, 1)
      await nextTick()

      // Both the parent object and the array keep their references across the
      // in-place reorder; only the two swapped elements' deps fire.
      expect(addressByRef).toBe(0)
      expect(contactsByRef).toBe(0)
      expect(form.values.address).toBe(addressBefore)
      expect(form.values.address.contacts).toBe(contactsBefore)

      expect(contactsDeep).toBeGreaterThan(0)
      expect(c0Leaf).toBeGreaterThan(0)
      expect(c1Leaf).toBeGreaterThan(0)
      expect(form.values.address.contacts[0]?.name).toBe('c1')
      expect(form.values.address.contacts[1]?.name).toBe('c0')

      stops.forEach((s) => s())
    })
  }
)
