// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Read-half parity: `validateAsync` and `handleSubmit` must await async
 * `.refine` predicates identically on the v3 and v4 adapters.
 *
 * This is the validation half of the onChange / autosave story. The
 * write half (`form.onChange`) persists a value; the read half decides
 * whether that value is allowed; the autosave gate composes them through
 * `await form.validateAsync(path)`. That gate only holds if the per-field
 * `validateAsync(path)` awaits the field's async refine on both adapters,
 * so this file pins it on both, row for row.
 *
 * `async-validation.test.ts` exercises the same surface through the
 * unified v4 entry; mirroring the canonical scenarios across both
 * adapters here is the deliberate parity proof (cf. the adapter-level
 * `async-contract-parity` suites).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUseForm = (opts: any) => any

const adapters = [
  { name: 'zod v3', useForm: useFormV3 as AnyUseForm, z: zV3 as unknown as typeof zV4 },
  { name: 'zod v4', useForm: useFormV4 as AnyUseForm, z: zV4 },
] as const

let keySeq = 0

describe.each(adapters)('async .refine parity — $name', ({ useForm, z }) => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    document.body.innerHTML = ''
  })

  // `username` carries an async uniqueness refine; `password` a sync
  // min length. Lax mode keeps the mount clean so every test drives the
  // async path explicitly through validateAsync / handleSubmit rather
  // than the construction-time strict seed.
  const schema = z.object({
    username: z.string().refine(async (value: string) => {
      await Promise.resolve()
      return value !== 'taken'
    }, 'That username is taken'),
    password: z.string().min(8, 'At least 8 characters'),
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function mountForm(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle: { api?: any } = {}
    const Host = defineComponent({
      setup() {
        handle.api = useForm({ schema, key: `refine-parity-${keySeq++}`, strict: false })
        return () => h('div')
      },
    })
    const app = createApp(Host).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    apps.push(app)
    if (handle.api === undefined) throw new Error('mountForm: api never set')
    return handle.api
  }

  describe('validateAsync() — whole form', () => {
    it('resolves success when the async refine passes', async () => {
      const api = mountForm()
      api.setValue('username', 'free')
      api.setValue('password', 'very-secret')
      const result = await api.validateAsync()
      expect(result.success).toBe(true)
      expect(result.errors).toBeUndefined()
    })

    it('resolves failure with the refine message when it rejects', async () => {
      const api = mountForm()
      api.setValue('username', 'taken')
      api.setValue('password', 'very-secret')
      const result = await api.validateAsync()
      expect(result.success).toBe(false)
      const message = result.errors?.find(
        (e: { path: PropertyKey[]; message: string }) => e.path[0] === 'username'
      )?.message
      expect(message).toBe('That username is taken')
    })
  })

  describe('validateAsync(path) — per-field subtree (the autosave gate)', () => {
    it('resolves success for a valid field even when a sibling is invalid', async () => {
      const api = mountForm()
      api.setValue('username', 'free')
      // Sibling fails `min(8)`; per-field scoping must ignore it.
      api.setValue('password', '')
      const result = await api.validateAsync('username')
      expect(result.success).toBe(true)
    })

    it('resolves failure when the field-scoped async refine rejects', async () => {
      const api = mountForm()
      api.setValue('username', 'taken')
      const result = await api.validateAsync('username')
      expect(result.success).toBe(false)
      // A path-scoped call surfaces the message on the reactive
      // `errors.<path>` bucket (the consumer-facing read); `result.errors`
      // is relative to the validated subtree.
      expect(api.errors.username?.[0]?.message).toBe('That username is taken')
    })
  })

  describe('handleSubmit — awaits the async refine before dispatch', () => {
    it('dispatches to onSubmit when the async refine passes', async () => {
      const api = mountForm()
      api.setValue('username', 'free')
      api.setValue('password', 'very-secret')
      let submittedWith: unknown = null
      await api.handleSubmit((values: unknown) => {
        submittedWith = values
      })()
      expect(submittedWith).toEqual({ username: 'free', password: 'very-secret' })
    })

    it('routes to onError and surfaces the error when the async refine rejects', async () => {
      const api = mountForm()
      api.setValue('username', 'taken')
      api.setValue('password', 'very-secret')
      let onErrorFired = false
      await api.handleSubmit(
        () => {
          throw new Error('onSubmit must not fire when the async refine rejects')
        },
        () => {
          onErrorFired = true
        }
      )()
      expect(onErrorFired).toBe(true)
      expect(api.errors.username?.[0]?.message).toBe('That username is taken')
    })
  })
})
