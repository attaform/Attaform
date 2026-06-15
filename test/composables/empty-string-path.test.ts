// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * `''` is a real one-segment path (the literal empty-key field `['']`),
 * distinct from the root `[]`. Form-level (global) errors live at the
 * root `[]`, NOT at `['']` — so `''` is a free, ordinary field key. The
 * contract:
 *
 *   - `errors()` → all errors (full aggregate, == `meta.errors`)
 *   - `errors([])` → ONLY the global bucket (root `.refine()`,
 *     `setFormErrors`); a dedicated channel undiluted by field errors
 *   - `errors('')` → the literal `''` field (empty for a normal schema
 *     with no `''` key), never the global bucket
 *   - `errors('field')` → unchanged subtree-at-field
 *   - `values('')` → undefined for normal schemas (no literal `''` key)
 *   - `values()` / `values([])` → whole form
 *
 * Adapter side: Zod errors with `path: []` (root `.refine()`) store at
 * the root `[]` bucket (PathKey `'[]'`) directly, no rerouting.
 */

const apps: App[] = []
afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
  document.body.innerHTML = ''
})

function mountWithApp<T>(setup: () => T): T {
  const handle: { captured?: T } = {}
  const App = defineComponent({
    setup() {
      handle.captured = setup()
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  apps.push(app)
  if (handle.captured === undefined) throw new Error('mountWithApp: setup never returned')
  return handle.captured
}

async function flushValidations(form: { meta: { validating: boolean } }): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await nextTick()
    if (!form.meta.validating) break
  }
  await nextTick()
  await nextTick()
}

type ErrorsCallForm = (
  path?: string | readonly (string | number)[]
) => readonly { message: string }[] | undefined
type ValuesCallForm = (path?: string | readonly (string | number)[]) => unknown

function callErrors(form: { errors: unknown }): ErrorsCallForm {
  return form.errors as unknown as ErrorsCallForm
}
function callValues(form: { values: unknown }): ValuesCallForm {
  return form.values as unknown as ValuesCallForm
}

// -----------------------------------------------------------------------------
// v3 adapter
// -----------------------------------------------------------------------------

describe('empty-string path semantics — zod-v3 adapter', () => {
  const schema = zV3
    .object({
      from: zV3.string().min(1, 'Required'),
      to: zV3.string().min(1, 'Required'),
    })
    .refine((v) => v.from !== v.to, { message: 'must differ' })

  function makeForm() {
    return mountWithApp(() =>
      useFormV3({
        schema: schema as unknown as zV3.ZodObject<{
          from: zV3.ZodString
          to: zV3.ZodString
        }>,
        key: `empty-path-v3-${Math.random()}`,
        strict: false,
        defaultValues: { from: '', to: '' },
      })
    )
  }

  it('errors() returns every error (full aggregate)', async () => {
    const form = makeForm()
    await form.handleSubmit(
      () => {},
      () => {}
    )()
    await flushValidations(form)
    const all = (callErrors(form)() ?? []).map((e) => e.message).sort()
    expect(all).toEqual(['Required', 'Required', 'must differ'].sort())
  })

  it('errors([]) returns ONLY the global (root .refine) bucket', async () => {
    const form = makeForm()
    await form.handleSubmit(
      () => {},
      () => {}
    )()
    await flushValidations(form)
    const global = (callErrors(form)([]) ?? []).map((e) => e.message)
    expect(global).toEqual(['must differ'])
  })

  it("errors('') reads the literal '' field (empty here), never the global bucket", async () => {
    const form = makeForm()
    await form.handleSubmit(
      () => {},
      () => {}
    )()
    await flushValidations(form)
    const literal = (callErrors(form)('') ?? []).map((e) => e.message)
    expect(literal).toEqual([])
  })

  it("errors('from') still returns the field's subtree (unchanged)", async () => {
    const form = makeForm()
    await form.handleSubmit(
      () => {},
      () => {}
    )()
    await flushValidations(form)
    const field = (callErrors(form)('from') ?? []).map((e) => e.message)
    expect(field).toEqual(['Required'])
  })

  it("values('') is undefined when there's no literal '' field", () => {
    const form = makeForm()
    expect(callValues(form)('')).toBeUndefined()
  })

  it('values() and values([]) return the full tree', () => {
    const form = makeForm()
    const noArg = JSON.stringify(callValues(form)())
    const rootArr = JSON.stringify(callValues(form)([]))
    expect(noArg).toBe(rootArr)
    expect(noArg).toContain('"from"')
    expect(noArg).toContain('"to"')
  })
})

// -----------------------------------------------------------------------------
// v4 adapter
// -----------------------------------------------------------------------------

describe('empty-string path semantics — zod-v4 adapter', () => {
  const schema = zV4
    .object({
      from: zV4.string().min(1, 'Required'),
      to: zV4.string().min(1, 'Required'),
    })
    .refine((v) => v.from !== v.to, { message: 'must differ' })

  function makeForm() {
    return mountWithApp(() =>
      useFormV4({
        schema,
        key: `empty-path-v4-${Math.random()}`,
        strict: false,
        defaultValues: { from: '', to: '' },
      })
    )
  }

  it('errors() returns every error (full aggregate)', async () => {
    const form = makeForm()
    await form.handleSubmit(
      () => {},
      () => {}
    )()
    await flushValidations(form)
    const all = (callErrors(form)() ?? []).map((e) => e.message).sort()
    expect(all).toEqual(['Required', 'Required', 'must differ'].sort())
  })

  it('errors([]) returns ONLY the global (root .refine) bucket', async () => {
    const form = makeForm()
    await form.handleSubmit(
      () => {},
      () => {}
    )()
    await flushValidations(form)
    const global = (callErrors(form)([]) ?? []).map((e) => e.message)
    expect(global).toEqual(['must differ'])
  })

  it("errors('') reads the literal '' field (empty here), never the global bucket", async () => {
    const form = makeForm()
    await form.handleSubmit(
      () => {},
      () => {}
    )()
    await flushValidations(form)
    const literal = (callErrors(form)('') ?? []).map((e) => e.message)
    expect(literal).toEqual([])
  })

  it("errors('from') still returns the field's subtree (unchanged)", async () => {
    const form = makeForm()
    await form.handleSubmit(
      () => {},
      () => {}
    )()
    await flushValidations(form)
    const field = (callErrors(form)('from') ?? []).map((e) => e.message)
    expect(field).toEqual(['Required'])
  })

  it("values('') is undefined when there's no literal '' field", () => {
    const form = makeForm()
    expect(callValues(form)('')).toBeUndefined()
  })
})

// -----------------------------------------------------------------------------
// Literal root '' field — proves '' is free of form-level duty. errors('')
// reads THIS field; errors([]) still returns the global bucket alone.
// -----------------------------------------------------------------------------

describe("literal root '' field — zod-v3 adapter", () => {
  const schema = zV3
    .object({
      '': zV3.string().min(1, 'empty-key required'),
      name: zV3.string().min(1, 'name required'),
    })
    .refine((v) => v[''] !== v.name, { message: 'must differ' })

  function makeForm() {
    return mountWithApp(() =>
      useFormV3({
        schema: schema as unknown as zV3.ZodObject<{
          '': zV3.ZodString
          name: zV3.ZodString
        }>,
        key: `literal-empty-v3-${Math.random()}`,
        strict: false,
        defaultValues: { '': '', name: '' },
      })
    )
  }

  it("errors('') reads the '' field, errors([]) the global bucket, errors() both", async () => {
    const form = makeForm()
    await form.handleSubmit(
      () => {},
      () => {}
    )()
    await flushValidations(form)
    expect((callErrors(form)('') ?? []).map((e) => e.message)).toEqual(['empty-key required'])
    expect((callErrors(form)([]) ?? []).map((e) => e.message)).toEqual(['must differ'])
    expect((callErrors(form)() ?? []).map((e) => e.message).sort()).toEqual(
      ['empty-key required', 'name required', 'must differ'].sort()
    )
  })
})

describe("literal root '' field — zod-v4 adapter", () => {
  const schema = zV4
    .object({
      '': zV4.string().min(1, 'empty-key required'),
      name: zV4.string().min(1, 'name required'),
    })
    .refine((v) => v[''] !== v.name, { message: 'must differ' })

  function makeForm() {
    return mountWithApp(() =>
      useFormV4({
        schema,
        key: `literal-empty-v4-${Math.random()}`,
        strict: false,
        defaultValues: { '': '', name: '' },
      })
    )
  }

  it("errors('') reads the '' field, errors([]) the global bucket, errors() both", async () => {
    const form = makeForm()
    await form.handleSubmit(
      () => {},
      () => {}
    )()
    await flushValidations(form)
    expect((callErrors(form)('') ?? []).map((e) => e.message)).toEqual(['empty-key required'])
    expect((callErrors(form)([]) ?? []).map((e) => e.message)).toEqual(['must differ'])
    expect((callErrors(form)() ?? []).map((e) => e.message).sort()).toEqual(
      ['empty-key required', 'name required', 'must differ'].sort()
    )
  })
})
