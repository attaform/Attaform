import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { crossCopyState } from '../../src/runtime/core/cross-copy-state'
import {
  fieldMetaStore,
  getFieldMetaForSchema,
  getFieldMetaListForSchema,
  type FieldMetaState,
} from '../../src/runtime/core/field-meta-store'
import { fieldMeta } from '../../src/runtime/adapters/zod-v4/field-meta'
import {
  isDefaultDisplayState,
  makeDefaultDisplayState,
} from '../../src/runtime/core/display-state'
import type { GetDisplayState } from '../../src/runtime/types/types-api'

/**
 * Standing guard on the cross-copy invariant (#577).
 *
 * A bundler may compile attaform into more than one module graph, and
 * Nuxt routinely does: a `shared/` module is compiled by Nitro while
 * the page that consumes it comes from the Vite SSR pass. State held
 * at module scope splits in two, a write through one copy is invisible
 * to a read through the other, and because both reads here have a
 * graceful fallback the only symptom is a silent behavioural
 * downgrade. `test/nuxt-shared-slice-meta.e2e.test.ts` pins the
 * end-to-end symptom against a real production build; this file pins
 * the invariant that makes it impossible, cheaply, on every run.
 *
 * The technique: claim each slot with a factory that THROWS. If the
 * owning module registered its state in the cross-copy slot, the
 * factory never runs and the existing instance comes back. If someone
 * moves that state back to module scope, the slot is unclaimed, the
 * factory fires, and the spec fails with the reason.
 */

const FIELD_META_KEY = Symbol.for('attaform:field-meta-state')
const DISPLAY_FAMILY_KEY = Symbol.for('attaform:default-display-state-family')

function claimed<T>(key: symbol, owner: string): T {
  return crossCopyState<T>(key, () => {
    throw new Error(
      `${owner} did not register its state in the cross-copy slot. ` +
        'It is back at module scope and will split across duplicate copies of attaform.'
    )
  })
}

describe('crossCopyState', () => {
  it('returns one instance per key, whoever asks', () => {
    const key = Symbol.for('attaform:test-slot-shared')
    const first = crossCopyState(key, () => ({ n: 1 }))
    const second = crossCopyState(key, () => ({ n: 2 }))
    expect(second).toBe(first)
    expect(second.n).toBe(1)
  })

  it('runs the factory once, on first touch only', () => {
    const key = Symbol.for('attaform:test-slot-factory-count')
    let calls = 0
    const create = (): { n: number } => {
      calls += 1
      return { n: calls }
    }
    crossCopyState(key, create)
    crossCopyState(key, create)
    crossCopyState(key, create)
    expect(calls).toBe(1)
  })

  it('keeps distinct keys apart', () => {
    const a = crossCopyState(Symbol.for('attaform:test-slot-a'), () => ({ id: 'a' }))
    const b = crossCopyState(Symbol.for('attaform:test-slot-b'), () => ({ id: 'b' }))
    expect(a).not.toBe(b)
    expect(b.id).toBe('b')
  })
})

describe('field-meta state is cross-copy (#577)', () => {
  it('the registry reads and writes the shared slot, not module-scoped maps', () => {
    const slot = claimed<FieldMetaState>(FIELD_META_KEY, 'field-meta-store')
    const schema = z.string()
    fieldMetaStore.add(schema, { label: 'Given name' })
    // The slot a second copy of the module would resolve to is the same
    // object this copy just wrote through.
    expect(slot.store.get(schema)).toEqual({ label: 'Given name' })
    expect(getFieldMetaForSchema(schema)).toBe(slot.store.get(schema))
    expect(slot.lists.get(schema)).toEqual([{ label: 'Given name' }])
    expect(getFieldMetaListForSchema(schema)).toBe(slot.lists.get(schema))
  })

  it('the path-map walk installs into the shared slot', () => {
    const slot = claimed<FieldMetaState>(FIELD_META_KEY, 'field-meta-store')
    // Registering through the public surface is the only thing that
    // installs the walk. A registration-only bundler graph has no
    // reader for a module-scoped slot, so the install write is a dead
    // store and Rollup drops it along with the whole walk; a property
    // on a cross-copy carrier is opaque to that analysis.
    z.string().register(fieldMeta, { label: 'Given name' })
    expect(slot.pathMapBuilder).not.toBeNull()
  })
})

describe('default display-state family is cross-copy (#577)', () => {
  it('records reducers in the shared slot so isDefaultDisplayState answers across copies', () => {
    const slot = claimed<WeakSet<GetDisplayState>>(DISPLAY_FAMILY_KEY, 'display-state')
    // `makeDefaultDisplayState` is a public export, so a consumer can
    // build their reducer in a module that lands in a different graph
    // from the page. Split the WeakSet and the container error rollup
    // silently stops applying.
    const reducer = makeDefaultDisplayState({ showDelay: 50, minVisible: 200 })
    expect(slot.has(reducer)).toBe(true)
    expect(isDefaultDisplayState(reducer)).toBe(true)
  })
})
