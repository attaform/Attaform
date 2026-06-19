// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * HARD BOUNDARY: the literal `''` field key and the root `[]` global
 * bucket never conflate.
 *
 * `''` is a plain field key. It carries the literal `['']` field's
 * errors and nothing else, ever. Root / global form context (a root
 * `.refine()`, `setErrors`, hydration failures) lives at the root
 * `[]` and only there. They are separate storage, separate reads, and
 * separate slots in the materialised `JSON.stringify(form.errors)` dump:
 *
 *   - a literal `''` field error  ->  `tree['']`   +  `errors('')`
 *   - a global / root-level error ->  `tree['[]']`  +  `errors([])`
 *
 * Neither ever leaks into the other's channel, in either direction.
 * These tests pin that boundary on both zod adapters, for both
 * schema-produced and imperatively-set errors.
 */

interface ConflationForm {
  readonly key: string
  readonly errors: unknown
  readonly meta: { readonly validating: boolean }
  handleSubmit: (onValid: () => void, onInvalid: () => void) => (event?: Event) => Promise<unknown>
  setErrors: (
    errors: ReadonlyArray<{
      path?: readonly (string | number)[]
      message: string
      formKey?: string
      code?: string
    }>
  ) => void
}

const apps: App[] = []
afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
  document.body.innerHTML = ''
})

function mountWithApp(setup: () => ConflationForm): ConflationForm {
  const handle: { captured?: ConflationForm } = {}
  const App = defineComponent({
    setup() {
      handle.captured = setup()
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.config.warnHandler = () => {}
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  apps.push(app)
  if (handle.captured === undefined) throw new Error('mountWithApp: setup never returned')
  return handle.captured
}

async function flush(form: ConflationForm): Promise<void> {
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

function dump(form: ConflationForm): Record<string, { message: string }[] | undefined> {
  return JSON.parse(JSON.stringify(form.errors)) as Record<
    string,
    { message: string }[] | undefined
  >
}
function slot(form: ConflationForm, key: string): string[] {
  return (dump(form)[key] ?? []).map((e) => e.message)
}
function treeKeys(form: ConflationForm): string[] {
  return Object.keys(dump(form))
}
function read(form: ConflationForm, path?: string | readonly (string | number)[]): string[] {
  const fn = form.errors as ErrorsCallForm
  const result = path === undefined ? fn() : fn(path)
  return (result ?? []).map((e) => e.message)
}

function schemaConflationTests(makeInvalidForm: () => ConflationForm): void {
  it('schema errors: literal "" field and root [] refine sit in distinct slots, no bleed', async () => {
    const form = makeInvalidForm()
    await form.handleSubmit(
      () => {},
      () => {}
    )()
    await flush(form)

    // Distinct materialised slots.
    expect(slot(form, '')).toEqual(['empty-key required'])
    expect(slot(form, '[]')).toEqual(['must differ'])
    expect(slot(form, 'name')).toEqual(['name required'])

    // The hard boundary, both directions: neither slot carries the
    // other's error.
    expect(slot(form, '')).not.toContain('must differ')
    expect(slot(form, '[]')).not.toContain('empty-key required')

    // Reads agree with the slots.
    expect(read(form, '')).toEqual(['empty-key required'])
    expect(read(form, [])).toEqual(['must differ'])
    expect(read(form, '')).not.toContain('must differ')
    expect(read(form, [])).not.toContain('empty-key required')

    // The whole-form dump still carries everything the flat aggregate
    // does — global included, just under '[]' rather than ''.
    expect(read(form).sort()).toEqual(['empty-key required', 'must differ', 'name required'].sort())
  })
}

function imperativeConflationTests(makeValidForm: () => ConflationForm): void {
  it('imperative errors: a "" field entry and a global entry sit in distinct slots, no bleed', async () => {
    const form = makeValidForm()
    await flush(form)

    // One whole-layer write carrying both: the `['']` entry lands in the
    // literal-field slot, the path-less entry in the global `[]` bucket.
    form.setErrors([
      { path: [''], message: 'field boom', formKey: form.key, code: 'api:test' },
      { message: 'global boom' },
    ])
    await flush(form)

    expect(slot(form, '')).toEqual(['field boom'])
    expect(slot(form, '[]')).toEqual(['global boom'])

    expect(slot(form, '')).not.toContain('global boom')
    expect(slot(form, '[]')).not.toContain('field boom')

    expect(read(form, '')).toEqual(['field boom'])
    expect(read(form, [])).toEqual(['global boom'])
  })

  it('a global error alone never conjures a "" field slot', async () => {
    const form = makeValidForm()
    await flush(form)

    form.setErrors([{ message: 'lonely global' }])
    await flush(form)

    expect(slot(form, '[]')).toEqual(['lonely global'])
    expect(treeKeys(form)).not.toContain('')
    expect(read(form, '')).toEqual([])
  })
}

// -----------------------------------------------------------------------------
// zod-v3 adapter
// -----------------------------------------------------------------------------

describe('root [] vs literal "" conflation — zod-v3 adapter', () => {
  const schema = zV3
    .object({
      '': zV3.string().min(1, 'empty-key required'),
      name: zV3.string().min(1, 'name required'),
    })
    .refine((v) => v[''] !== v.name, { message: 'must differ' })
  type Cast = zV3.ZodObject<{ '': zV3.ZodString; name: zV3.ZodString }>

  const make = (defaults: { '': string; name: string }) =>
    mountWithApp(
      () =>
        useFormV3({
          schema: schema as unknown as Cast,
          key: `conflate-v3-${Math.random()}`,
          strict: false,
          defaultValues: defaults,
        }) as unknown as ConflationForm
    )

  schemaConflationTests(() => make({ '': '', name: '' }))
  imperativeConflationTests(() => make({ '': 'ok', name: 'fine' }))
})

// -----------------------------------------------------------------------------
// zod-v4 adapter
// -----------------------------------------------------------------------------

describe('root [] vs literal "" conflation — zod-v4 adapter', () => {
  const schema = zV4
    .object({
      '': zV4.string().min(1, 'empty-key required'),
      name: zV4.string().min(1, 'name required'),
    })
    .refine((v) => v[''] !== v.name, { message: 'must differ' })

  const make = (defaults: { '': string; name: string }) =>
    mountWithApp(
      () =>
        useFormV4({
          schema,
          key: `conflate-v4-${Math.random()}`,
          strict: false,
          defaultValues: defaults,
        }) as unknown as ConflationForm
    )

  schemaConflationTests(() => make({ '': '', name: '' }))
  imperativeConflationTests(() => make({ '': 'ok', name: 'fine' }))
})
