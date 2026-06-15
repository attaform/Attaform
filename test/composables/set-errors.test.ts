// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { ErrorInput, ValidationError } from '../../src/runtime/types/types-api'

/**
 * `form.setErrors` / `form.clearErrors` — the single surface for the
 * manual error layer (server responses, optimistic UI, form banners).
 * Lenient input (`ErrorInput`): an `Error`, a partial object, or an
 * array of either; firm output (`ValidationError`, formKey always
 * stamped). Three call forms mirror `setValue`: whole-layer replace,
 * functional updater, and path-scoped. A missing message coerces to
 * "Unknown error"; a missing code defaults to `atta:user-error`. The
 * contract is pinned on both zod adapters.
 */

type ErrorsRead = (
  path?: string | readonly (string | number)[]
) => readonly ValidationError[] | undefined

interface TestForm {
  readonly key: string
  readonly errors: ErrorsRead & Record<string, readonly ValidationError[] | undefined>
  readonly meta: { readonly errors: readonly ValidationError[] }
  setErrors: {
    (update: (prev: ValidationError[]) => ErrorInput | ErrorInput[]): void
    (errors: ErrorInput | ErrorInput[]): void
    (
      path: string | (string | number)[],
      errors: ErrorInput | ErrorInput[] | ((prev: ValidationError[]) => ErrorInput | ErrorInput[])
    ): void
  }
  clearErrors: (path?: string | (string | number)[]) => void
}

const apps: App[] = []
afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
  document.body.innerHTML = ''
})

function mountWithApp(setup: () => TestForm): TestForm {
  const handle: { captured?: TestForm } = {}
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

const globals = (form: TestForm): readonly ValidationError[] => form.errors([]) ?? []
const field = (form: TestForm, name: string): readonly ValidationError[] => form.errors[name] ?? []
const msgs = (errors: readonly ValidationError[]): string[] => errors.map((e) => e.message)

function setErrorsContract(make: () => TestForm): void {
  it('whole-layer replace places each entry at its own path; a path-less entry is global', () => {
    const form = make()
    form.setErrors([
      { path: ['email'], message: 'taken', code: 'api:dup' },
      { message: 'service down' },
    ])

    expect(msgs(field(form, 'email'))).toEqual(['taken'])
    expect(msgs(globals(form))).toEqual(['service down'])
    expect(form.meta.errors).toHaveLength(2)
  })

  it('accepts a single ErrorInput (not just an array)', () => {
    const form = make()
    form.setErrors({ message: 'service down' })
    expect(msgs(globals(form))).toEqual(['service down'])
  })

  it('coerces an Error instance: its message, default code, global path', () => {
    const form = make()
    form.setErrors(new Error('boom'))

    const [entry] = globals(form)
    expect(entry).toMatchObject({
      message: 'boom',
      path: [],
      code: 'atta:user-error',
      formKey: form.key,
    })
  })

  it('coerces a missing or empty message to "Unknown error"', () => {
    const form = make()
    form.setErrors([{ code: 'api:x' }, new Error('')])

    expect(msgs(globals(form))).toEqual(['Unknown error', 'Unknown error'])
  })

  it('defaults a missing code to atta:user-error and respects an explicit one', () => {
    const form = make()
    form.setErrors([{ message: 'defaulted' }, { message: 'explicit', code: 'capacity:exceeded' }])

    const entries = globals(form)
    expect(entries[0]?.code).toBe('atta:user-error')
    expect(entries[1]?.code).toBe('capacity:exceeded')
  })

  it('forwards the opaque data payload verbatim', () => {
    const form = make()
    const data = { unlocksAt: '2026-01-01T00:00:00Z', attempts: 3 }
    form.setErrors([{ message: 'locked out', data }])

    expect(globals(form)[0]?.data).toEqual(data)
  })

  it('always restamps formKey with this form, ignoring any provided', () => {
    const form = make()
    form.setErrors([{ path: ['email'], message: 'taken', formKey: 'someone-else' }])

    expect(field(form, 'email')[0]?.formKey).toBe(form.key)
  })

  it('whole-layer replace clobbers the prior layer (global included)', () => {
    const form = make()
    form.setErrors([{ path: ['email'], message: 'taken' }, { message: 'global' }])
    form.setErrors([{ message: 'replaced' }])

    expect(field(form, 'email')).toEqual([])
    expect(msgs(globals(form))).toEqual(['replaced'])
  })

  it('functional updater receives the current manual layer as prev', () => {
    const form = make()
    form.setErrors([{ message: 'first' }])
    form.setErrors((prev) => [...prev, { message: 'second' }])

    expect(msgs(globals(form))).toEqual(['first', 'second'])
  })

  it('path-scoped form stamps the path and ignores any entry path', () => {
    const form = make()
    form.setErrors('email', [{ message: 'taken', path: ['ignored'] }])

    const [entry] = field(form, 'email')
    expect(entry).toMatchObject({ message: 'taken', path: ['email'], formKey: form.key })
    expect(form.errors('ignored')).toEqual([])
  })

  it('path-scoped form accepts an array path', () => {
    const form = make()
    form.setErrors(['email'], { message: 'taken' })
    expect(msgs(field(form, 'email'))).toEqual(['taken'])
  })

  it('path-scoped replaces only that bucket, leaving others intact', () => {
    const form = make()
    form.setErrors('email', [{ message: 'e1' }])
    form.setErrors('name', [{ message: 'n1' }])
    form.setErrors('email', [{ message: 'e2' }])

    expect(msgs(field(form, 'email'))).toEqual(['e2'])
    expect(msgs(field(form, 'name'))).toEqual(['n1'])
  })

  it('path-scoped updater receives that path errors as prev', () => {
    const form = make()
    form.setErrors('email', [{ message: 'first' }, { message: 'second' }])
    form.setErrors('email', (prev) => prev.slice(0, 1))

    expect(msgs(field(form, 'email'))).toEqual(['first'])
  })

  it('clearErrors(path) clears one bucket; clearErrors([]) clears global; clearErrors() clears all', () => {
    const form = make()
    const seed = (): void => {
      form.setErrors('email', [{ message: 'e' }])
      form.setErrors('name', [{ message: 'n' }])
      form.setErrors([], [{ message: 'g' }])
    }

    seed()
    form.clearErrors('email')
    expect(field(form, 'email')).toEqual([])
    expect(msgs(field(form, 'name'))).toEqual(['n'])
    expect(msgs(globals(form))).toEqual(['g'])

    seed()
    form.clearErrors([])
    expect(msgs(globals(form))).toEqual([])
    expect(msgs(field(form, 'name'))).toEqual(['n'])

    seed()
    form.clearErrors()
    expect(form.meta.errors).toEqual([])
  })

  it('setErrors([]) clears the whole manual layer without throwing', () => {
    const form = make()
    form.setErrors([{ path: ['email'], message: 'taken' }, { message: 'global' }])
    expect(() => form.setErrors([])).not.toThrow()
    expect(form.meta.errors).toEqual([])
  })
}

// -----------------------------------------------------------------------------
// zod-v3 adapter
// -----------------------------------------------------------------------------

describe('setErrors / clearErrors — zod-v3 adapter', () => {
  const schema = zV3.object({ email: zV3.string(), name: zV3.string() })
  const make = (): TestForm =>
    mountWithApp(
      () =>
        useFormV3({
          schema,
          key: `set-errors-v3-${Math.random()}`,
          strict: false,
          defaultValues: { email: 'a@b.co', name: 'Ada' },
        }) as unknown as TestForm
    )
  setErrorsContract(make)
})

// -----------------------------------------------------------------------------
// zod-v4 adapter
// -----------------------------------------------------------------------------

describe('setErrors / clearErrors — zod-v4 adapter', () => {
  const schema = zV4.object({ email: zV4.string(), name: zV4.string() })
  const make = (): TestForm =>
    mountWithApp(
      () =>
        useFormV4({
          schema,
          key: `set-errors-v4-${Math.random()}`,
          strict: false,
          defaultValues: { email: 'a@b.co', name: 'Ada' },
        }) as unknown as TestForm
    )
  setErrorsContract(make)
})
