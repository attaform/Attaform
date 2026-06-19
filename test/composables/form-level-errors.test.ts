// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { useForm } from '../../src/zod'
import type { UseFormReturn } from '../../src/zod'
import { z } from 'zod'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { ValidationError } from '../../src/runtime/types/types-api'

/**
 * Global (form-level) errors are just `setErrors` entries with no path:
 * they live at the root path `[]`, stored in the `'[]'` PathKey bucket.
 * There is no separate form-level setter; `setErrors` covers field and
 * global errors alike. Global entries are visible across these reads:
 *
 *   - `form.meta.errors` — the flat aggregate, unfiltered.
 *   - `form.errors([])` — the dedicated global read (root bucket only).
 *   - `form.errors()` — the full aggregate (every field error plus the
 *     global bucket).
 *
 * They are NOT a child key of the errors proxy: `JSON.stringify(form.
 * errors)` and proxy iteration don't surface them under `''` (the root
 * `[]` bucket has no `''` slot — `''` is a free field key), and
 * `form.errors('')` reads the unrelated literal `''` field.
 */

const schema = z.object({
  email: z.string().email('bad email'),
  password: z.string().min(8, 'min 8 chars'),
})

type Api = UseFormReturn<typeof schema>

function mount(): { app: App; api: Api } {
  const handle: { api?: Api } = {}
  const App = defineComponent({
    setup() {
      handle.api = useForm({ schema, key: 'form-level-errors', strict: false })
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  return { app, api: handle.api as Api }
}

const formLevel = (errors: readonly ValidationError[]): readonly ValidationError[] =>
  errors.filter((e) => e.path.length === 0)

describe('setErrors — global / form-level errors at []', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('writes a single global error (no path) with the default code', () => {
    const { app, api } = mount()
    apps.push(app)

    api.setErrors([{ message: 'Capacity exceeded' }])

    const entries = formLevel(api.meta.errors)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      message: 'Capacity exceeded',
      path: [],
      formKey: api.key,
      code: 'atta:user-error',
    })
  })

  it('writes multiple global errors in order', () => {
    const { app, api } = mount()
    apps.push(app)

    api.setErrors([{ message: 'a' }, { message: 'b' }, { message: 'c' }])

    const entries = formLevel(api.meta.errors)
    expect(entries.map((e) => e.message)).toEqual(['a', 'b', 'c'])
    for (const e of entries) expect(e.path).toEqual([])
  })

  it('whole-layer setErrors replaces (does not append) on each call', () => {
    const { app, api } = mount()
    apps.push(app)

    api.setErrors([{ message: 'first' }])
    api.setErrors([{ message: 'second' }])

    const entries = formLevel(api.meta.errors)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.message).toBe('second')
  })

  it('scoped setErrors([], …) sets the global bucket without disturbing field errors', () => {
    const { app, api } = mount()
    apps.push(app)

    api.setErrors('email', [{ message: 'taken', code: 'api:duplicate' }])
    api.setErrors([], [{ message: 'Capacity exceeded' }])

    expect(api.errors.email?.[0]?.message).toBe('taken')
    const entries = formLevel(api.meta.errors)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.message).toBe('Capacity exceeded')
    // Two total: one field, one global.
    expect(api.meta.errors).toHaveLength(2)
  })

  it('clearErrors([]) clears the global bucket only', () => {
    const { app, api } = mount()
    apps.push(app)

    api.setErrors('email', [{ message: 'taken', code: 'api:duplicate' }])
    api.setErrors([], [{ message: 'one' }, { message: 'two' }])

    api.clearErrors([])

    expect(formLevel(api.meta.errors)).toHaveLength(0)
    // Field error survives.
    expect(api.errors.email?.[0]?.message).toBe('taken')
  })

  it('per-entry code override propagates onto the ValidationError', () => {
    const { app, api } = mount()
    apps.push(app)

    api.setErrors([
      { message: 'a', code: 'capacity:exceeded' },
      { message: 'b' }, // default code
    ])

    const entries = formLevel(api.meta.errors)
    expect(entries[0]?.code).toBe('capacity:exceeded')
    expect(entries[1]?.code).toBe('atta:user-error')
  })

  it('global errors surface via errors([]) and meta.errors, not the proxy tree', () => {
    const { app, api } = mount()
    apps.push(app)

    api.setErrors([{ message: 'Capacity exceeded' }])

    // Global errors live at the root `[]`, reached via the dedicated
    // `errors([])` channel and the flat `meta.errors` aggregate. They
    // are NOT a child key, so the serialised proxy tree has no `''`
    // slot for them and `errors('')` reads the unrelated literal `''`
    // field (empty here).
    expect(api.errors([])).toMatchObject([{ message: 'Capacity exceeded' }])
    expect(api.meta.errors).toHaveLength(1)
    const tree = JSON.parse(JSON.stringify(api.errors)) as Record<string, unknown>
    expect(tree['']).toBeUndefined()
    expect(api.errors('')).toEqual([])
  })

  it('whole-layer setErrors respects each entry path; formKey is stamped from the form', () => {
    const { app, api } = mount()
    apps.push(app)

    // A server's ValidationError[] pipes in without mapping: each entry
    // lands at its OWN path (a missing path is the global bucket), and
    // the form stamps its own formKey on each.
    api.setErrors([
      {
        path: ['email'],
        message: 'taken',
        code: 'api:duplicate',
      },
      {
        message: 'Capacity exceeded',
        code: 'api:capacity',
      },
    ])

    expect(api.errors.email?.[0]).toMatchObject({
      message: 'taken',
      path: ['email'],
      formKey: api.key,
      code: 'api:duplicate',
    })
    const entries = formLevel(api.meta.errors)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      message: 'Capacity exceeded',
      path: [],
      formKey: api.key,
      code: 'api:capacity',
    })
  })
})
