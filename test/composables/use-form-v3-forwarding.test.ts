// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod-v3'
import type { UseFormReturnType } from '../../src/runtime/types/types-api'
import { createAttaform } from '../../src/runtime/core/plugin'
import { useForm } from '../../src/zod-v3'
import { waitUntil } from '../utils/form-harness'

/**
 * Regression pin: the zod v3 `useForm` wrapper used to hand-pick the
 * options it forwarded to `useAbstractForm`, silently dropping the
 * opt-in ones (`onInvalidSubmit`, `validateOn`, `debounceMs`,
 * `history`). These tests prove each option now reaches the runtime.
 */

type Form = { email: string; password: string }
type ApiReturn = UseFormReturnType<Form, Form>

// Mount helper that accepts any v3 useForm options bag. Using `never`
// here side-steps TS picking the wrong `useForm` overload at the
// outer-level type inference; at the call site below, `useForm`
// internally narrows based on whether `options.schema` is a Zod type.
type AnyUseFormOptions = Parameters<typeof useForm>[0]

function mount(options: AnyUseFormOptions): { app: App; api: ApiReturn } {
  const handle: { api?: ApiReturn } = {}
  const App = defineComponent({
    setup() {
      handle.api = useForm(options as never) as ApiReturn
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  return { app, api: handle.api as ApiReturn }
}

describe('v3 useForm forwards opt-in options to useAbstractForm', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('forwards validateOn / debounceMs — live field errors populate without submit', async () => {
    const strictSchema = z.object({
      email: z.string().email('bad email'),
      password: z.string().min(8, 'min 8 chars'),
    })
    const { app, api } = mount({
      schema: strictSchema,
      key: 'v3-fieldvalidation',
      validateOn: 'change',
      debounceMs: 20,
    })
    apps.push(app)

    // A non-email string triggers the schema's leaf rule. The
    // field-validation scheduler — only active if the option
    // reached useAbstractForm — populates fieldErrors within the
    // debounce window.
    api.setValue('email', 'nope')
    await waitUntil(() => (api.errors.email?.[0]?.message === 'bad email' ? true : null))

    expect(api.errors.email?.[0]?.message).toBe('bad email')
  })
})
