// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { unset } from '../../src'
import { useAbstractForm as useForm } from '../../src/abstract'
import { attachRegistryToApp, createRegistry } from '../../src/runtime/core/registry'
import type { UseFormReturnType } from '../../src/runtime/types/types-api'
import { fakeSchema } from '../utils/fake-schema'

/**
 * Identity-keyed element state: a structural array mutation relocates an
 * element's NON-DERIVED per-element state (value baseline, dirty, touched,
 * user-set errors, blank display) so it follows the element to its new
 * index instead of bleeding onto whatever element shifts into the old slot.
 * The dirty BASELINE is per-element, so a moved element keeps its own
 * dirty verdict; structural changes (remove / insert / reorder) still
 * register the form as dirty against its construction-time shape.
 */

type ListForm = { tags: string[] }

function harness(initial: string[]) {
  let captured!: UseFormReturnType<ListForm>
  const Probe = defineComponent({
    setup() {
      captured = useForm<ListForm>({
        schema: fakeSchema<ListForm>({ tags: initial }),
        key: `mig-${Math.random().toString(36).slice(2)}`,
      })
      return () => h('div')
    },
  })
  const app = createApp(Probe)
  attachRegistryToApp(app, createRegistry())
  app.mount(document.createElement('div'))
  return { app, form: captured }
}

describe('identity-keyed element state — move carries every element fact', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('carries an edited value and its original baseline to the new index', () => {
    const { app, form } = harness(['a', 'b', 'c'])
    apps.push(app)
    form.setValue('tags.0', 'EDITED')
    expect(form.fields('tags.0')?.dirty).toBe(true)

    form.move('tags', 0, 2)

    expect(form.values.tags).toEqual(['b', 'c', 'EDITED'])
    const moved = form.fields('tags.2')
    expect(moved?.value).toBe('EDITED')
    expect(moved?.original).toBe('a')
    expect(moved?.dirty).toBe(true)
  })

  it('carries touched to the new index', () => {
    const { app, form } = harness(['a', 'b', 'c'])
    apps.push(app)
    form.touch('tags.0')
    expect(form.fields('tags.0')?.touched).toBe(true)

    form.move('tags', 0, 2)

    expect(form.fields('tags.2')?.touched).toBe(true)
  })

  it('carries user-set errors to the new index', () => {
    const { app, form } = harness(['a', 'b', 'c'])
    apps.push(app)
    form.setErrors([{ message: 'bad', path: ['tags', 0], code: 'custom:test' }])
    expect(form.fields('tags.0')?.errors.map((e) => e.message)).toEqual(['bad'])

    form.move('tags', 0, 2)

    const moved = form.fields('tags.2')
    expect(moved?.errors.map((e) => e.message)).toEqual(['bad'])
    expect(moved?.errors[0]?.path).toEqual(['tags', 2])
  })

  it('carries blank display to the new index', () => {
    const { app, form } = harness(['a', 'b', 'c'])
    apps.push(app)
    form.setValue('tags.0', unset)
    expect(form.fields('tags.0')?.blank).toBe(true)

    form.move('tags', 0, 2)

    expect(form.fields('tags.2')?.blank).toBe(true)
  })

  it('does not bleed state onto the element that shifts into the old slot', () => {
    const { app, form } = harness(['a', 'b', 'c'])
    apps.push(app)
    form.setValue('tags.0', 'EDITED')
    form.touch('tags.0')
    form.setErrors([{ message: 'bad', path: ['tags', 0], code: 'custom:test' }])

    form.move('tags', 0, 2)

    // 'b' shifts into index 0 and must arrive clean.
    const shifted = form.fields('tags.0')
    expect(shifted?.value).toBe('b')
    expect(shifted?.original).toBe('b')
    expect(shifted?.dirty).toBe(false)
    expect(shifted?.touched).toBe(false)
    expect(shifted?.errors).toEqual([])
  })

  it('swap exchanges full element state both ways', () => {
    const { app, form } = harness(['a', 'b'])
    apps.push(app)
    form.setValue('tags.0', 'EDITED')
    form.touch('tags.0')

    form.swap('tags', 0, 1)

    expect(form.values.tags).toEqual(['b', 'EDITED'])
    const movedToOne = form.fields('tags.1')
    expect(movedToOne?.original).toBe('a')
    expect(movedToOne?.dirty).toBe(true)
    expect(movedToOne?.touched).toBe(true)

    const movedToZero = form.fields('tags.0')
    expect(movedToZero?.original).toBe('b')
    expect(movedToZero?.dirty).toBe(false)
    expect(movedToZero?.touched).toBe(false)
  })
})

describe('identity-keyed element state — structural changes stay dirty', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('a removal keeps the form dirty', () => {
    const { app, form } = harness(['a', 'b'])
    apps.push(app)
    expect(form.meta.dirty).toBe(false)
    form.remove('tags', 0)
    expect(form.meta.dirty).toBe(true)
  })

  it('a pure reorder keeps the form dirty even when every element is pristine', () => {
    const { app, form } = harness(['a', 'b'])
    apps.push(app)
    expect(form.meta.dirty).toBe(false)
    form.move('tags', 0, 1)
    expect(form.meta.dirty).toBe(true)
  })

  it('an insert keeps the form dirty', () => {
    const { app, form } = harness(['a', 'b'])
    apps.push(app)
    expect(form.meta.dirty).toBe(false)
    form.insert('tags', 1, 'x')
    expect(form.meta.dirty).toBe(true)
  })

  it('a reset after a reorder returns the form to pristine', () => {
    const { app, form } = harness(['a', 'b'])
    apps.push(app)
    form.move('tags', 0, 1)
    expect(form.meta.dirty).toBe(true)
    form.reset()
    expect(form.meta.dirty).toBe(false)
  })
})

describe('identity-keyed element state — a fresh element registers', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('an inserted element is touchable and reads dirty, without disturbing the shifted neighbor', () => {
    const { app, form } = harness(['a', 'b'])
    apps.push(app)
    form.insert('tags', 1, 'x')

    expect(form.values.tags).toEqual(['a', 'x', 'b'])
    expect(form.fields('tags.1')?.dirty).toBe(true)
    form.touch('tags.1')
    expect(form.fields('tags.1')?.touched).toBe(true)

    // 'b' shifted to index 2 and kept its own clean baseline.
    expect(form.fields('tags.2')?.dirty).toBe(false)
    expect(form.fields('tags.2')?.touched).toBe(false)
  })

  it('a replaced element starts fresh, dropping the prior occupant state', () => {
    const { app, form } = harness(['a', 'b'])
    apps.push(app)
    form.touch('tags.0')
    expect(form.fields('tags.0')?.touched).toBe(true)

    form.replace('tags', 0, 'z')

    expect(form.values.tags).toEqual(['z', 'b'])
    expect(form.fields('tags.0')?.touched).toBe(false)
    expect(form.fields('tags.0')?.dirty).toBe(true)
  })
})
