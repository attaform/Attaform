// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import type { UseFormConfigV4, UseFormReturnV4 } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Container-self errors and descendant errors coexist in the
 * dot-form Proxy materialised tree under the `''` sentinel slot.
 *
 * The contract:
 *
 *   - `form.errors.<container>['']` resolves to the container-self
 *     error array (cross-field refines, server-side container marks).
 *   - `JSON.stringify(form.errors.<container>)` materialises as
 *     `{ '': [...], <descendant keys>: [...] }` — both surfaces visible.
 *   - The root `''` slot (form-level errors, root refines, setErrors)
 *     is the same convention generalised down to every container depth.
 *   - Schemas that legitimately declare a field named `''` share the
 *     slot: the field's own errors and any container-self errors
 *     concatenate into a single array.
 *   - Sparse: containers with no self errors and no descendant errors
 *     don't appear in the materialised tree; no empty `'': []` noise.
 *
 * The flat-array views (`form.errors(path)`, `form.meta.errors`) remain
 * the canonical "everything at this path and below" surfaces; the
 * sentinel slot is a structural-tree affordance, not a replacement.
 */

const apps: App[] = []
afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
  document.body.innerHTML = ''
})

function mount<Schema extends z.ZodObject>(
  schema: Schema,
  defaultValues: UseFormConfigV4<Schema>['defaultValues']
): UseFormReturnV4<Schema> {
  let captured: unknown
  const App = defineComponent({
    setup() {
      captured = (useForm as unknown as (config: unknown) => unknown)({
        schema,
        key: `errors-self-mat-${Math.random().toString(36).slice(2)}`,
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
  return captured as UseFormReturnV4<Schema>
}

describe('form.errors — container-self materialisation under "" sentinel', () => {
  it('container refine + descendant leaf both surface in container sub-tree', () => {
    const schema = z.object({
      profile: z.object({
        bio: z.string(),
      }),
    })
    const form = mount(schema, { profile: { bio: '' } })
    form.setErrors([
      {
        path: ['profile'],
        message: 'cross-field refine failed',
        code: 'api:validation',
      },
      {
        path: ['profile', 'bio'],
        message: 'bio too long',
        code: 'api:validation',
      },
    ])
    const sub = JSON.parse(JSON.stringify(form.errors.profile)) as Record<string, unknown>
    expect(sub).toMatchObject({
      '': [{ message: 'cross-field refine failed' }],
      bio: [{ message: 'bio too long' }],
    })
  })

  it('container refine + descendant leaf both surface at root materialisation', () => {
    const schema = z.object({
      name: z.string(),
      profile: z.object({
        bio: z.string(),
      }),
    })
    const form = mount(schema, { name: '', profile: { bio: '' } })
    form.setErrors([
      { path: ['name'], message: 'name required', code: 'api:validation' },
      {
        path: ['profile'],
        message: 'profile refine failed',
        code: 'api:validation',
      },
      {
        path: ['profile', 'bio'],
        message: 'bio too long',
        code: 'api:validation',
      },
    ])
    const root = JSON.parse(JSON.stringify(form.errors)) as Record<string, unknown>
    expect(root).toMatchObject({
      name: [{ message: 'name required' }],
      profile: {
        '': [{ message: 'profile refine failed' }],
        bio: [{ message: 'bio too long' }],
      },
    })
  })

  it('form.errors.profile[""] returns the container-self error array via dot access', () => {
    const schema = z.object({
      profile: z.object({ bio: z.string() }),
    })
    const form = mount(schema, { profile: { bio: '' } })
    form.setErrors([
      {
        path: ['profile'],
        message: 'profile refine failed',
        code: 'api:validation',
      },
    ])
    const selfErrors = (form.errors.profile as unknown as { ['']: readonly { message: string }[] })[
      ''
    ]
    expect(selfErrors).toEqual([
      expect.objectContaining({ message: 'profile refine failed', path: ['profile'] }),
    ])
  })

  it('root form-level errors live at [] (errors([])), not the "" slot', () => {
    const schema = z.object({ name: z.string() })
    const form = mount(schema, { name: '' })
    form.setErrors([{ message: 'whole-form bad' }])
    // Global errors are at the root `[]`, read via errors([]).
    expect(form.errors([])).toEqual([
      expect.objectContaining({ message: 'whole-form bad', path: [] }),
    ])
    // `errors['']` reads the literal '' field — empty, never the global bucket.
    const rootSelf = (form.errors as unknown as { ['']?: readonly { message: string }[] })['']
    expect(rootSelf ?? []).toEqual([])
  })

  it('schema with literal "" field and container refine share the "" slot (collision)', () => {
    const schema = z.object({
      profile: z.object({
        '': z.string(),
        bio: z.string(),
      }),
    })
    const form = mount(schema, { profile: { '': '', bio: '' } })
    form.setErrors([
      {
        path: ['profile'],
        message: 'container refine failed',
        code: 'api:validation',
      },
      {
        path: ['profile', ''],
        message: 'literal empty key required',
        code: 'api:validation',
      },
    ])
    const sub = JSON.parse(JSON.stringify(form.errors.profile)) as Record<string, unknown>
    expect(sub['']).toBeDefined()
    const slot = sub[''] as readonly { message: string }[]
    const messages = slot.map((e) => e.message).sort()
    expect(messages).toEqual(['container refine failed', 'literal empty key required'])
  })

  it('container with no self errors and no descendant errors does not appear', () => {
    const schema = z.object({
      name: z.string(),
      profile: z.object({ bio: z.string() }),
    })
    const form = mount(schema, { name: '', profile: { bio: '' } })
    form.setErrors([{ path: ['name'], message: 'name required', code: 'api:validation' }])
    const root = JSON.parse(JSON.stringify(form.errors)) as Record<string, unknown>
    expect(root['profile']).toBeUndefined()
    // The sentinel must NOT appear empty.
    expect(Object.keys(root)).not.toContain('')
  })

  it('container refine alone (no descendants) materialises as { "": [...] }', () => {
    const schema = z.object({
      profile: z.object({ bio: z.string() }),
    })
    const form = mount(schema, { profile: { bio: '' } })
    form.setErrors([
      {
        path: ['profile'],
        message: 'lonely refine',
        code: 'api:validation',
      },
    ])
    const sub = JSON.parse(JSON.stringify(form.errors.profile)) as Record<string, unknown>
    expect(sub).toEqual({
      '': [expect.objectContaining({ message: 'lonely refine', path: ['profile'] })],
    })
  })

  it('nested container refines both surface at root materialisation', () => {
    const schema = z.object({
      outer: z.object({
        inner: z.object({ leaf: z.string() }),
      }),
    })
    const form = mount(schema, { outer: { inner: { leaf: '' } } })
    form.setErrors([
      {
        path: ['outer'],
        message: 'outer refine',
        code: 'api:validation',
      },
      {
        path: ['outer', 'inner'],
        message: 'inner refine',
        code: 'api:validation',
      },
      {
        path: ['outer', 'inner', 'leaf'],
        message: 'leaf bad',
        code: 'api:validation',
      },
    ])
    const root = JSON.parse(JSON.stringify(form.errors)) as Record<string, unknown>
    expect(root).toMatchObject({
      outer: {
        '': [{ message: 'outer refine' }],
        inner: {
          '': [{ message: 'inner refine' }],
          leaf: [{ message: 'leaf bad' }],
        },
      },
    })
  })

  it('iteration over form.errors.<arrayPath> reflects the live array indices', () => {
    const schema = z.object({
      items: z.array(z.object({ sku: z.string().min(1, 'sku required') })),
    })
    const form = mount(schema, { items: [] })
    form.append('items', { sku: '' })
    form.append('items', { sku: '' })
    form.append('items', { sku: '' })
    // Same enumeration contract as `form.fields.<arrayPath>`: the
    // live indices walk the underlying array, regardless of which
    // ones actually carry errors at the moment. Consumers that
    // render a per-index error summary via
    // `v-for="(_, idx) in form.errors.items"` need every index to
    // be reachable so they can call `form.errors(['items', idx])`
    // (or descend further) and decide whether to render anything
    // at that row.
    expect(Object.keys(form.errors.items)).toEqual(['0', '1', '2'])
    expect(Array.isArray(form.errors.items)).toBe(true)
    expect((form.errors.items as unknown as { length: number }).length).toBe(3)
    form.remove('items', 1)
    expect(Object.keys(form.errors.items)).toEqual(['0', '1'])
  })

  it('call form returns the flat self+descendants aggregate (regression)', () => {
    const schema = z.object({
      profile: z.object({ bio: z.string() }),
    })
    const form = mount(schema, { profile: { bio: '' } })
    form.setErrors([
      {
        path: ['profile'],
        message: 'profile refine',
        code: 'api:validation',
      },
      {
        path: ['profile', 'bio'],
        message: 'bio bad',
        code: 'api:validation',
      },
    ])
    const flat = (form.errors as unknown as (path: string) => readonly { message: string }[])(
      'profile'
    )
    const messages = flat.map((e) => e.message).sort()
    expect(messages).toEqual(['bio bad', 'profile refine'])
  })
})
