// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, ref, withDirectives, type App } from 'vue'
import { z } from 'zod'
import { vRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { GetDisplayState } from '../../src/runtime/types/types-api'
import { useForm } from '../../src/zod'
import type { UseFormReturn } from '../../src/zod'
import { waitUntil } from '../utils/form-harness'

// `email` is required (drives aria-required); `note` is optional.
const schema = z.object({ email: z.string().min(1), note: z.string().optional() })
type Api = UseFormReturn<typeof schema>

type Mounted = { app: App; api: Api; input: HTMLInputElement }

function uniqueKey(): string {
  return `aria-${Math.random().toString(36).slice(2)}`
}

async function mountField(opts?: {
  autoAria?: boolean
  registerAutoAria?: boolean
  getDisplayState?: GetDisplayState
  authored?: Record<string, unknown>
  path?: 'email' | 'note'
}): Promise<Mounted> {
  const handle: { api?: Api } = {}
  const Parent = defineComponent({
    setup() {
      const api = useForm({
        schema,
        key: uniqueKey(),
        ...(opts?.autoAria === false ? { autoAria: false } : {}),
        ...(opts?.getDisplayState ? { getDisplayState: opts.getDisplayState } : {}),
      })
      handle.api = api
      const rv = api.register(
        opts?.path ?? 'email',
        opts?.registerAutoAria === false ? { autoAria: false } : undefined
      )
      return () =>
        withDirectives(h('input', { type: 'text', ...(opts?.authored ?? {}) }), [[vRegister, rv]])
    },
  })
  const app = createApp(Parent).use(createAttaform())
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  await waitUntil(() => (handle.api !== undefined && root.firstElementChild !== null ? true : null))
  if (handle.api === undefined) throw new Error('mountField: api never set')
  return { app, api: handle.api, input: root.firstElementChild as HTMLInputElement }
}

afterEach(() => {
  document.body.innerHTML = ''
})

const forceState =
  (state: 'idle' | 'pending' | 'error' | 'success'): GetDisplayState =>
  () => ({ display: state })

describe('auto-aria attribute mapping', () => {
  let mounted: Mounted | undefined
  afterEach(() => {
    mounted?.app.unmount()
    mounted = undefined
  })

  it('maps error to aria-invalid + aria-describedby (and not aria-busy)', async () => {
    mounted = await mountField({ getDisplayState: forceState('error') })
    expect(mounted.input.getAttribute('aria-invalid')).toBe('true')
    expect(mounted.input.getAttribute('aria-describedby')).toBe(
      mounted.api.fields.email.aria.errorId
    )
    expect(mounted.input.hasAttribute('aria-busy')).toBe(false)
  })

  it('maps pending to aria-busy (and not aria-invalid / describedby)', async () => {
    mounted = await mountField({ getDisplayState: forceState('pending') })
    expect(mounted.input.getAttribute('aria-busy')).toBe('true')
    expect(mounted.input.hasAttribute('aria-invalid')).toBe(false)
    expect(mounted.input.hasAttribute('aria-describedby')).toBe(false)
  })

  it('sets no status attribute for success or idle', async () => {
    for (const state of ['success', 'idle'] as const) {
      const m = await mountField({ getDisplayState: forceState(state) })
      expect(m.input.hasAttribute('aria-invalid')).toBe(false)
      expect(m.input.hasAttribute('aria-busy')).toBe(false)
      expect(m.input.hasAttribute('aria-describedby')).toBe(false)
      m.app.unmount()
    }
  })

  it('reflects the schema required flag independent of display state', async () => {
    mounted = await mountField({ getDisplayState: forceState('idle') })
    expect(mounted.input.getAttribute('aria-required')).toBe('true')
    // The optional `note` field is not required.
    const optional = await mountField({ path: 'note', getDisplayState: forceState('idle') })
    expect(optional.input.hasAttribute('aria-required')).toBe(false)
    optional.app.unmount()
  })
})

describe('auto-aria real lifecycle', () => {
  let mounted: Mounted | undefined
  afterEach(() => {
    mounted?.app.unmount()
    mounted = undefined
  })

  it('stays quiet until a submit reveals the error, then clears on recovery', async () => {
    mounted = await mountField()
    // Pre-interaction: gate closed, nothing surfaced.
    expect(mounted.input.hasAttribute('aria-invalid')).toBe(false)

    // A failed submit opens the gate; the watch flips aria-invalid
    // without a parent re-render reading display state.
    await mounted.api.handleSubmit(() => undefined)()
    await waitUntil(() => (mounted?.input.getAttribute('aria-invalid') === 'true' ? true : null))
    expect(mounted.input.getAttribute('aria-describedby')).toBe(
      mounted.api.fields.email.aria.errorId
    )

    // Fix the value and submit again: success clears the error attrs.
    mounted.api.setValue('email', 'ada@example.com')
    await mounted.api.handleSubmit(() => undefined)()
    await waitUntil(() => (mounted?.input.hasAttribute('aria-invalid') === false ? true : null))
    expect(mounted.input.hasAttribute('aria-describedby')).toBe(false)
  })
})

describe('auto-aria respects authored markup', () => {
  let mounted: Mounted | undefined
  afterEach(() => {
    mounted?.app.unmount()
    mounted = undefined
  })

  it('never overwrites an authored aria attribute, even when state would change it', async () => {
    mounted = await mountField({
      getDisplayState: forceState('error'),
      authored: { 'aria-invalid': 'false', 'aria-describedby': 'my-help' },
    })
    // Authored values survive; the directive manages neither.
    expect(mounted.input.getAttribute('aria-invalid')).toBe('false')
    expect(mounted.input.getAttribute('aria-describedby')).toBe('my-help')
    // Unauthored managed attrs still flow (email is required).
    expect(mounted.input.getAttribute('aria-required')).toBe('true')
  })
})

describe('auto-aria opt-out tiers', () => {
  let mounted: Mounted | undefined
  afterEach(() => {
    mounted?.app.unmount()
    mounted = undefined
  })

  it('manages nothing when the form disables autoAria', async () => {
    mounted = await mountField({ autoAria: false, getDisplayState: forceState('error') })
    expect(mounted.input.hasAttribute('aria-invalid')).toBe(false)
    expect(mounted.input.hasAttribute('aria-required')).toBe(false)
  })

  it('manages nothing when the binding passes autoAria: false', async () => {
    mounted = await mountField({ registerAutoAria: false, getDisplayState: forceState('error') })
    expect(mounted.input.hasAttribute('aria-invalid')).toBe(false)
    expect(mounted.input.hasAttribute('aria-required')).toBe(false)
  })
})

describe('auto-aria re-derives on a path swap', () => {
  it('rebinds aria to the new path when a dynamic register path changes', async () => {
    const handle: { api?: Api } = {}
    const path = ref<'email' | 'note'>('email')
    const Parent = defineComponent({
      setup() {
        const api = useForm({ schema, key: uniqueKey(), getDisplayState: forceState('error') })
        handle.api = api
        return () =>
          withDirectives(h('input', { type: 'text' }), [[vRegister, api.register(path.value)]])
      },
    })
    const app = createApp(Parent).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    await waitUntil(() => (handle.api !== undefined ? true : null))
    const input = root.firstElementChild as HTMLInputElement
    // email is required → aria-required present.
    expect(input.getAttribute('aria-required')).toBe('true')

    // Swap to the optional `note` path; aria-required must drop.
    path.value = 'note'
    await waitUntil(() => (input.hasAttribute('aria-required') === false ? true : null))
    expect(input.hasAttribute('aria-required')).toBe(false)
    // Error state still tracks the new path.
    expect(input.getAttribute('aria-invalid')).toBe('true')
    app.unmount()
  })
})

describe('auto-aria teardown on unmount', () => {
  it('clears the attributes it set when the binding unmounts', async () => {
    const mounted = await mountField({ getDisplayState: forceState('error') })
    const { input } = mounted
    expect(input.getAttribute('aria-invalid')).toBe('true')
    mounted.app.unmount()
    // The directive's beforeUnmount strips the attrs it owned.
    expect(input.hasAttribute('aria-invalid')).toBe(false)
    expect(input.hasAttribute('aria-required')).toBe(false)
    expect(input.hasAttribute('aria-describedby')).toBe(false)
  })
})
