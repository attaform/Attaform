// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'
import { OutOfFormsListError } from '../../src/runtime/core/normalize-next'
import type { AnyForm } from '../../src/runtime/types/types-wizard'

/**
 * `useForm({ next })` declares a form's downstream neighbor(s) in a
 * wizard graph. Phase 2 lands the option as METADATA only — no runtime
 * behavior changes; `useWizard` consumes the normalized shape in
 * Phase 3.
 *
 * Two shapes are accepted:
 *
 *   - `next: someForm` — identity reference; the form's runtime
 *     successor is always the named form (linear flow).
 *   - `next: { pick, forms }` — declared list of possible successors
 *     with a `pick(parsed)` selector that runs against the form's
 *     `z.output` shape.
 *
 * Identity refs are normalized into a single-element `{ pick, forms }`
 * tuple at construction so the wizard graph walker reads one uniform
 * contract. Out-of-list `pick` returns throw at runtime via
 * `OutOfFormsListError`.
 */

function mountWithSetup<T>(setupFn: () => T): { app: App; result: T } {
  const handle: { result?: T } = {}
  const App = defineComponent({
    setup() {
      handle.result = setupFn()
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.config.warnHandler = () => {}
  app.config.errorHandler = () => {}
  app.mount(document.createElement('div'))
  return { app, result: handle.result as T }
}

describe('useForm({ next })', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  const reviewSchema = z.object({ tos: z.boolean() })
  const profileSchema = z.object({ city: z.string() })
  const accountSchema = z.object({ role: z.enum(['admin', 'user']) })

  it('is undefined when `next` is omitted (terminal form)', () => {
    const { app, result } = mountWithSetup(() =>
      useForm({ schema: reviewSchema, key: 'review-terminal' })
    )
    apps.push(app)
    expect(result.next).toBeUndefined()
  })

  it('normalizes an identity ref to `{ pick: () => target, forms: [target] }`', () => {
    const { app, result } = mountWithSetup(() => {
      const review = useForm({ schema: reviewSchema, key: 'review-id' })
      const profile = useForm({ schema: profileSchema, key: 'profile-id', next: review })
      return { review, profile }
    })
    apps.push(app)

    const normalized = result.profile.next
    expect(normalized).toBeDefined()
    expect(normalized?.forms).toHaveLength(1)
    expect(normalized?.forms[0]?.key).toBe('review-id')
    expect(normalized?.pick({})).toBe(result.review)
  })

  it('passes a branching `{ pick, forms }` shape through verbatim', () => {
    const { app, result } = mountWithSetup(() => {
      const admin = useForm({ schema: profileSchema, key: 'admin-branch' })
      const user = useForm({ schema: profileSchema, key: 'user-branch' })
      const account = useForm({
        schema: accountSchema,
        key: 'account-branch',
        next: {
          pick: (parsed) => (parsed.role === 'admin' ? admin : user),
          forms: [admin, user] as const,
        },
      })
      return { admin, user, account }
    })
    apps.push(app)

    const normalized = result.account.next
    expect(normalized).toBeDefined()
    expect(normalized?.forms.map((f) => f.key)).toEqual(['admin-branch', 'user-branch'])
    expect(normalized?.pick({ role: 'admin' })).toBe(result.admin)
    expect(normalized?.pick({ role: 'user' })).toBe(result.user)
  })

  it('lets `pick` return `undefined` to signal a dynamic terminal', () => {
    const { app, result } = mountWithSetup(() => {
      const optionalNext = useForm({ schema: profileSchema, key: 'optional-next' })
      const account = useForm({
        schema: accountSchema,
        key: 'account-dynamic-terminal',
        next: {
          pick: () => undefined,
          forms: [optionalNext] as const,
        },
      })
      return { account }
    })
    apps.push(app)

    expect(result.account.next?.pick({ role: 'admin' })).toBeUndefined()
  })

  it('throws `OutOfFormsListError` when `pick` returns a form outside `forms`', () => {
    const { app, result } = mountWithSetup(() => {
      const declared = useForm({ schema: profileSchema, key: 'declared-form' })
      const undeclared = useForm({ schema: profileSchema, key: 'undeclared-form' })
      const account = useForm({
        schema: accountSchema,
        key: 'account-out-of-list',
        next: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pick: ((): AnyForm => undeclared) as any,
          forms: [declared] as const,
        },
      })
      return { account }
    })
    apps.push(app)

    expect(() => result.account.next?.pick({ role: 'admin' })).toThrow(OutOfFormsListError)
    expect(() => result.account.next?.pick({ role: 'admin' })).toThrow(/'undeclared-form'/)
  })

  it('`next` is captured at construction and survives `reset()`', () => {
    const { app, result } = mountWithSetup(() => {
      const review = useForm({ schema: reviewSchema, key: 'review-reset' })
      const profile = useForm({ schema: profileSchema, key: 'profile-reset', next: review })
      return { review, profile }
    })
    apps.push(app)

    const beforeReset = result.profile.next
    result.profile.reset()
    expect(result.profile.next).toBe(beforeReset)
  })
})
