// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * The field-meta path walk rides the REGISTRATION surface: importing
 * `useForm` alone leaves the walk uninstalled in the shared store
 * slot, and metadata resolution falls back to `.describe()` for the
 * description and humanize for the label. The first `withMeta` /
 * `fieldMeta.add` call installs the walk, after which the path-keyed
 * disambiguation of shared schemas works.
 *
 * ORDER MATTERS in this file: no registration surface is imported
 * statically, the fallback describe-block runs first (specs execute
 * in declaration order), and the install specs pull the surfaces in
 * via dynamic import. Vitest's per-file isolation gives this file a
 * fresh module registry, so no other suite's registrations leak in.
 */

const apps: App[] = []
afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
  document.body.innerHTML = ''
})

function mountWithApp<T>(setup: () => T): T {
  let captured: T | undefined
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
  apps.push(app)
  if (captured === undefined) throw new Error('mountWithApp: setup never returned')
  return captured
}

describe('field-meta walk uninstalled — no registration surface imported', () => {
  it('Zod 4: label humanizes, description reads .describe(), meta is empty', () => {
    const schema = zV4.object({
      firstName: zV4.string().describe('Given name'),
    })
    const form = mountWithApp(() =>
      useFormV4({ schema, key: 'walker-v4-fallback', defaultValues: { firstName: '' } })
    )
    expect(form.fields.firstName.label).toBe('First Name')
    expect(form.fields.firstName.description).toBe('Given name')
    expect(form.fields.firstName.meta).toEqual({})
  })

  it('Zod 3: label humanizes, description reads .describe(), meta is empty', () => {
    const schema = zV3.object({
      firstName: zV3.string().describe('Given name'),
    })
    const form = mountWithApp(() =>
      useFormV3({ schema, key: 'walker-v3-fallback', defaultValues: { firstName: '' } })
    )
    expect(form.fields.firstName.label).toBe('First Name')
    expect(form.fields.firstName.description).toBe('Given name')
    expect(form.fields.firstName.meta).toEqual({})
  })
})

describe('field-meta walk installs on the first registration', () => {
  it('Zod 4: native .register on a shared instance disambiguates per path', async () => {
    // Two registrations on the SAME schema instance: the schema-keyed
    // single-slot store holds only the LAST payload, so resolving
    // 'pickup' to 'Pickup address' is possible only through the
    // path-keyed walk — proving `fieldMeta.add` (via Zod's
    // `.register`) installed it.
    const { fieldMeta } = await import('../../src/runtime/adapters/zod-v4/field-meta')
    const addressSchema = zV4.object({ street: zV4.string() })
    const schema = zV4.object({
      pickup: addressSchema.register(fieldMeta, { label: 'Pickup address' }),
      delivery: addressSchema.register(fieldMeta, { label: 'Delivery address' }),
    })
    const form = mountWithApp(() => useFormV4({ schema, key: 'walker-v4-installed' }))
    expect(form.fields('pickup').label).toBe('Pickup address')
    expect(form.fields('delivery').label).toBe('Delivery address')
  })

  it('Zod 3: fieldMeta.add on a shared instance disambiguates per path', async () => {
    const { fieldMeta } = await import('../../src/runtime/adapters/zod-v3/field-meta')
    const addressSchema = zV3.object({ street: zV3.string() })
    fieldMeta.add(addressSchema, { label: 'Pickup address' })
    fieldMeta.add(addressSchema, { label: 'Delivery address' })
    const schema = zV3.object({
      pickup: addressSchema,
      delivery: addressSchema,
    })
    const form = mountWithApp(() => useFormV3({ schema, key: 'walker-v3-installed' }))
    expect(form.fields('pickup').label).toBe('Pickup address')
    expect(form.fields('delivery').label).toBe('Delivery address')
  })
})
