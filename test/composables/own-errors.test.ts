// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { ValidationError } from '../../src'

/**
 * `ownErrors` / `firstOwnError` — exact-path error accessors.
 *
 * The exact-path counterpart to the subtree-scoped `errors` /
 * `firstError`. `ownErrors` is the errors at THIS path's own bucket
 * only (the raw schema, blank, user union at one key), excluding every
 * descendant that `errors` rolls up. `firstOwnError` is `ownErrors[0]`.
 *
 * - Leaf: `ownErrors === errors` (same array reference), so
 *   `firstOwnError === firstError`. A leaf has no descendants.
 * - Container: `ownErrors` holds only the container's own error (a
 *   cross-field `.refine()`, `setErrors` pinned here), never a child's.
 * - `form.meta.ownErrors` is the root `[]` bucket: form-level errors
 *   from a root `.refine()` or a path-less `setErrors`. The banner.
 *
 * Mirrored across both adapters (v3 + v4).
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

async function flushValidations(form: FormLike): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await nextTick()
    if (!form.meta.validating) break
  }
  await nextTick()
  await nextTick()
}

type FieldStateLike = {
  readonly errors: readonly ValidationError[]
  readonly ownErrors: readonly ValidationError[]
  readonly firstError: ValidationError | undefined
  readonly firstOwnError: ValidationError | undefined
}

type MetaLike = FieldStateLike & { readonly validating: boolean }

type PathLike = string | readonly (string | number)[]

type FormLike = {
  fields: (path?: PathLike) => FieldStateLike
  meta: MetaLike
  setErrors: (errors: readonly ValidationError[]) => void
  clearErrors: (path?: PathLike) => void
  setValue: (path: string, value: unknown) => void
  handleSubmit: (
    onValid: (values: unknown) => void,
    onInvalid?: (errors: unknown) => void
  ) => () => Promise<void>
  key: string
}

function asForm<F>(form: F): F & FormLike {
  return form as unknown as F & FormLike
}

const messages = (errs: readonly ValidationError[]): string[] => errs.map((e) => e.message)

function describeOwnErrors(label: string, makeForm: () => FormLike): void {
  describe(label, () => {
    // --- Leaf: own === subtree ---

    it('leaf ownErrors is empty and firstOwnError undefined with no error', () => {
      const form = makeForm()
      const field = form.fields('email')
      expect(field.ownErrors.length).toBe(0)
      expect(field.firstOwnError).toBeUndefined()
    })

    it('leaf ownErrors IS the same array reference as errors', () => {
      const form = makeForm()
      form.setErrors([{ path: ['email'], message: 'required', code: 'test' }])
      const field = form.fields('email')
      expect(field.ownErrors).toBe(field.errors)
      expect(field.firstOwnError).toBe(field.firstError)
      expect(field.firstOwnError).toBe(field.ownErrors[0])
    })

    it('leaf firstOwnError is a ValidationError (message, path, code)', () => {
      const form = makeForm()
      form.setErrors([{ path: ['email'], message: 'required', code: 'test' }])
      const first = form.fields('email').firstOwnError
      expect(first).toBeDefined()
      expect(typeof first?.message).toBe('string')
      expect(Array.isArray(first?.path)).toBe(true)
      expect(typeof first?.code).toBe('string')
    })

    // --- Container: own excludes descendants ---

    it('container ownErrors holds only the OWN-bucket error, errors rolls up children', () => {
      const form = makeForm()
      form.setErrors([
        { path: ['profile'], message: 'own-bucket', code: 'own' },
        { path: ['profile', 'handle'], message: 'child', code: 'child' },
      ])
      const profile = form.fields('profile')
      // Own bucket: the container's error alone, no descendant.
      expect(messages(profile.ownErrors)).toEqual(['own-bucket'])
      expect(profile.firstOwnError?.message).toBe('own-bucket')
      // Subtree rollup: the container's own error PLUS the child.
      expect(messages(profile.errors).sort()).toEqual(['child', 'own-bucket'])
      // The child leaf's own bucket is unaffected by the parent's.
      const handle = form.fields('profile.handle')
      expect(messages(handle.ownErrors)).toEqual(['child'])
      expect(handle.ownErrors).toBe(handle.errors)
    })

    it('container ownErrors surfaces a schema .refine() without its child errors', async () => {
      const form = makeForm()
      await form.handleSubmit(
        () => {},
        () => {}
      )()
      await flushValidations(form)
      const profile = form.fields('profile')
      // The profile-level refine is the container's OWN error.
      expect(messages(profile.ownErrors)).toEqual(['Bio must mention your handle'])
      expect(profile.firstOwnError?.message).toBe('Bio must mention your handle')
      // The subtree rollup ALSO carries the bio child error.
      expect(messages(profile.errors)).toContain('Bio must mention your handle')
      expect(messages(profile.errors)).toContain('Bio too short')
      expect(profile.errors.length).toBeGreaterThan(profile.ownErrors.length)
      // The bio leaf: own === subtree, its own message only.
      const bio = form.fields('profile.bio')
      expect(messages(bio.ownErrors)).toEqual(['Bio too short'])
      expect(bio.ownErrors).toBe(bio.errors)
    })

    // --- Form level: meta.ownErrors is the root bucket ---

    it('meta.ownErrors is the root [] bucket only, excluding field errors', () => {
      const form = makeForm()
      form.setErrors([
        { path: [], message: 'form-level', code: 'root' },
        { path: ['email'], message: 'email-error', code: 'field' },
      ])
      // Root bucket alone: the form-level error, not the field error.
      expect(messages(form.meta.ownErrors)).toEqual(['form-level'])
      expect(form.meta.firstOwnError?.message).toBe('form-level')
      // The whole-form aggregate carries both.
      expect(messages(form.meta.errors)).toContain('form-level')
      expect(messages(form.meta.errors)).toContain('email-error')
    })

    // --- Reactivity ---

    it('firstOwnError flips back to undefined when the own bucket clears', async () => {
      const form = makeForm()
      form.setErrors([{ path: ['email'], message: 'required', code: 'test' }])
      await nextTick()
      expect(form.fields('email').firstOwnError).toBeDefined()
      form.clearErrors('email')
      await nextTick()
      expect(form.fields('email').ownErrors.length).toBe(0)
      expect(form.fields('email').firstOwnError).toBeUndefined()
    })
  })
}

// -----------------------------------------------------------------------------
// v3 adapter
// -----------------------------------------------------------------------------

const v3Schema = zV3.object({
  email: zV3.string().min(1),
  profile: zV3
    .object({
      bio: zV3.string().min(5, 'Bio too short'),
      handle: zV3.string().min(1, 'Pick a handle'),
    })
    .refine((p) => p.bio.includes(p.handle), {
      message: 'Bio must mention your handle',
    }),
})
const defaults = { email: '', profile: { bio: 'no', handle: 'attaboy' } }

describeOwnErrors('ownErrors / firstOwnError — zod-v3 adapter', () =>
  asForm(
    mountWithApp(() =>
      useFormV3({
        schema: v3Schema,
        key: `own-errors-v3-${Math.random()}`,
        strict: false,
        defaultValues: defaults,
      })
    )
  )
)

// -----------------------------------------------------------------------------
// v4 adapter
// -----------------------------------------------------------------------------

const v4Schema = zV4.object({
  email: zV4.string().min(1),
  profile: zV4
    .object({
      bio: zV4.string().min(5, 'Bio too short'),
      handle: zV4.string().min(1, 'Pick a handle'),
    })
    .refine((p) => p.bio.includes(p.handle), {
      message: 'Bio must mention your handle',
    }),
})

describeOwnErrors('ownErrors / firstOwnError — zod-v4 adapter', () =>
  asForm(
    mountWithApp(() =>
      useFormV4({
        schema: v4Schema,
        key: `own-errors-v4-${Math.random()}`,
        strict: false,
        defaultValues: defaults,
      })
    )
  )
)
