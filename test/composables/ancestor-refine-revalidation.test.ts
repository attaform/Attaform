// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod-v4'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Ancestor container refines must re-evaluate when a descendant leaf
 * changes. A refine attached to `z.object({...}).refine(...)` produces
 * a `ValidationError` at the container's own path; per-leaf
 * revalidation that only consults the leaf sub-schema leaves the
 * ancestor refine's verdict frozen at its construction-or-submit-time
 * value, so the UI shows a "fix this" message for a check that's no
 * longer failing (or hides one that's now failing).
 *
 * Surfaced after the `''`-sentinel materialiser fix (`d414816`): the
 * stale refine becomes visible at `form.errors.profile['']` because
 * the dot-form tree no longer clobbers it with descendant sub-trees.
 *
 * Distinct from `ancestor-revalidation.test.ts`:
 *   - Bug 1 there: array `.min(1)` re-runs on `append`/`remove`.
 *   - Bug 2 there: leaf `.min(1)` re-runs after parent `.refine()`.
 *   - This file: the refine ITSELF clears / re-fires on descendant
 *     change.
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

type ErrorAtPath = (p: string) => Array<{ message: string }> | undefined
function errorsAt(form: { errors: unknown }): ErrorAtPath {
  return form.errors as unknown as ErrorAtPath
}

describe('Ancestor container refine — clears/re-fires on descendant change', () => {
  it('container refine clears when a descendant change makes it pass', async () => {
    const schema = z.object({
      profile: z
        .object({
          bio: z.string(),
          handle: z.string().min(1, 'Pick a handle'),
        })
        .refine((p) => p.bio.includes(p.handle), {
          message: 'Bio must mention your handle',
        }),
    })

    const form = mountWithApp(() =>
      useForm({
        schema,
        key: `arr-clear-${Math.random()}`,
        strict: false,
        defaultValues: { profile: { bio: 'no mention here', handle: 'attaboy' } },
      })
    )

    await form.handleSubmit(
      () => {},
      () => {}
    )()
    expect(errorsAt(form)('profile')?.map((e) => e.message)).toContain(
      'Bio must mention your handle'
    )

    // Descendant change that satisfies the refine — refine MUST clear.
    form.setValue('profile.bio', 'attaboy is great')
    await flushValidations(form)

    expect(errorsAt(form)('profile.bio')).toEqual([])
    const refineAtContainer = (errorsAt(form)('profile') ?? []).filter(
      (e) => e.message === 'Bio must mention your handle'
    )
    expect(refineAtContainer).toEqual([])
  })

  it('container refine re-fires when a descendant change makes it fail', async () => {
    const schema = z.object({
      profile: z
        .object({
          bio: z.string(),
          handle: z.string().min(1, 'Pick a handle'),
        })
        .refine((p) => p.bio.includes(p.handle), {
          message: 'Bio must mention your handle',
        }),
    })

    const form = mountWithApp(() =>
      useForm({
        schema,
        key: `arr-fire-${Math.random()}`,
        strict: false,
        defaultValues: { profile: { bio: 'attaboy is great', handle: 'attaboy' } },
      })
    )

    // Mount-time state PASSES the refine — no error.
    await flushValidations(form)
    expect(
      (errorsAt(form)('profile') ?? []).filter((e) => e.message === 'Bio must mention your handle')
    ).toEqual([])

    // Descendant change that breaks the refine — refine MUST surface.
    form.setValue('profile.bio', 'no mention here')
    await flushValidations(form)

    expect(errorsAt(form)('profile')?.map((e) => e.message)).toContain(
      'Bio must mention your handle'
    )
  })

  it('root refine re-fires on descendant change', async () => {
    const schema = z
      .object({
        password: z.string().min(1, 'Required'),
        confirmPassword: z.string().min(1, 'Required'),
      })
      .refine((v) => v.password === v.confirmPassword, {
        message: 'Passwords must match',
      })

    const form = mountWithApp(() =>
      useForm({
        schema: schema as unknown as z.ZodObject<{
          password: z.ZodString
          confirmPassword: z.ZodString
        }>,
        key: `arr-root-${Math.random()}`,
        strict: false,
        defaultValues: { password: 'one', confirmPassword: 'two' },
      })
    )

    await form.handleSubmit(
      () => {},
      () => {}
    )()
    expect(errorsAt(form)('')?.map((e) => e.message)).toContain('Passwords must match')

    // Match the descendant — root refine MUST clear.
    form.setValue('confirmPassword', 'one')
    await flushValidations(form)
    expect((errorsAt(form)('') ?? []).filter((e) => e.message === 'Passwords must match')).toEqual(
      []
    )

    // Mismatch again — root refine MUST come back.
    form.setValue('confirmPassword', 'three')
    await flushValidations(form)
    expect(errorsAt(form)('')?.map((e) => e.message)).toContain('Passwords must match')
  })
})
