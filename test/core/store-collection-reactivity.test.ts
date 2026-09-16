// @vitest-environment jsdom
/**
 * What the store's three per-path collections have to track, now that
 * they track it shallowly.
 *
 * `fields`, `originals` and `errorCells` were `reactive(new Map())`.
 * Vue's deep collection handlers wrap every value a read HANDS BACK in
 * a reactive proxy, so iterating one of these maps minted a fresh proxy
 * per entry per pass. On a 400-row table re-reading `form.list()` after
 * a keystroke, that wrapping was the single largest cost in the frame,
 * and it bought nothing: `FieldRecord`, `OriginalsRecord` and
 * `ErrorCell` are `readonly` in every field, and every writer REPLACES
 * the record through `.set()` rather than mutating it.
 *
 * `shallowReactive` keeps the half that is load-bearing. Reads of a
 * specific key still track that key, `set` / `delete` / iteration still
 * fire, and a change to one field still leaves another field's
 * computeds alone. The cases below are that contract, written as the
 * consequences a consumer can see, because the reason the deep half was
 * safe to drop is an invariant about the WRITERS, and an invariant is
 * exactly the kind of thing that stops holding quietly.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import type { App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { makeMounter } from '../utils/form-harness'

const schema = z.object({
  first: z.string().min(2, 'too short'),
  second: z.string(),
  profile: z.object({ city: z.string(), zip: z.string() }),
  rows: z.array(z.object({ label: z.string() })),
})

const DEFAULTS = {
  first: 'ok',
  second: 'ok',
  profile: { city: 'NYC', zip: '10001' },
  rows: [{ label: 'a' }],
}

const mount = makeMounter(useForm, schema, { defaultValues: DEFAULTS, validateOn: 'change' })

describe('the store collections still track what their readers depend on', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  function form() {
    const mounted = mount()
    apps.push(mounted.app)
    return mounted.api
  }

  it('fields: a record replaced at one path is visible at that path', async () => {
    const api = form()
    expect(api.fields.first.touched).toBe(false)
    api.touch('first')
    await nextTick()
    expect(api.fields.first.touched).toBe(true)
  })

  it('fields: a record replaced at one path leaves a sibling alone', async () => {
    // The per-key half of the tracking, which `shallowReactive` keeps
    // in full and which is the reason these are collections rather than
    // one big ref.
    const api = form()
    api.touch('first')
    await nextTick()
    expect(api.fields.second.touched).toBe(false)
  })

  it('fields: a path that did not exist yet becomes visible when it appears', async () => {
    // Appending an array row introduces a `fields` key nobody has read.
    // A collection that tracked only existing keys would leave the new
    // row's state stuck at its default forever.
    const api = form()
    api.append('rows', { label: 'b' })
    await nextTick()
    expect(api.list('rows').length).toBe(2)
    api.touch('rows.1.label')
    await nextTick()
    expect(api.fields.rows[1]?.label?.touched).toBe(true)
  })

  it('originals: a path appearing after construction still settles dirty', async () => {
    // The stated reason `originals` was made reactive: `append`
    // introduces a new index and seeds an `originals` entry for it, and
    // the `dirty` computed has to pick that up.
    const api = form()
    expect(api.meta.dirty).toBe(false)
    api.append('rows', { label: 'b' })
    await nextTick()
    expect(api.meta.dirty).toBe(true)
    api.remove('rows', 1)
    await nextTick()
    expect(api.meta.dirty).toBe(false)
  })

  it('originals: a leaf baseline survives a write and a write back', async () => {
    // `OriginalsRecord.value` holds form DATA, and `field.original` is
    // the read that surfaces it. A shallow collection hands back the
    // stored record rather than a proxy of it, so the contract is that
    // the value is the baseline, not that it is reactive.
    const api = form()
    expect(api.fields.profile.city.original).toBe('NYC')
    api.setValue('profile.city', 'Boston')
    await nextTick()
    // The baseline does not move with the write, and dirty sees the gap
    // at the leaf and at the container above it.
    expect(api.fields.profile.city.original).toBe('NYC')
    expect(api.fields.profile.city.dirty).toBe(true)
    // The container rollup lives on the call form; dot descent into a
    // container resolves child keys, not the container's own state.
    expect(api.fields('profile')?.dirty).toBe(true)
    api.setValue('profile.city', 'NYC')
    await nextTick()
    expect(api.fields.profile.city.dirty).toBe(false)
    expect(api.fields('profile')?.dirty).toBe(false)
  })

  it('errorCells: an error written at a path reaches every surface reading it', async () => {
    const api = form()
    api.setErrors('second', [{ message: 'from the server', code: 'user:server' }])
    await nextTick()
    // The three surfaces that read the cell: the per-path errors view,
    // the aggregate, and the field-state rollup.
    expect(api.errors('second')?.map((e) => e.code)).toContain('user:server')
    expect(api.meta.errors.map((e) => e.code)).toContain('user:server')
    expect(api.fields.second.errors.map((e) => e.code)).toContain('user:server')
  })

  it('errorCells: clearing a cell removes it from the aggregate', async () => {
    const api = form()
    api.setErrors('second', [{ message: 'gone soon', code: 'user:temp' }])
    await nextTick()
    expect(api.meta.errorCount).toBeGreaterThan(0)
    api.clearErrors('second')
    await nextTick()
    expect(api.meta.errors.map((e) => e.code)).not.toContain('user:temp')
  })

  it('errorCells: an error at one path leaves a sibling field valid', async () => {
    const api = form()
    api.setErrors('second', [{ message: 'only here', code: 'user:only' }])
    await nextTick()
    expect(api.fields.first.errors).toEqual([])
    expect(api.fields.second.errors.length).toBe(1)
  })
})
