// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, ref, withDirectives, type App, type Ref } from 'vue'
import { z } from 'zod'
import { vRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { DisplayState, RegisterValue } from '../../src/runtime/types/types-api'
import { useForm } from '../../src/zod'
import type { UseFormReturn } from '../../src/zod'
import { waitUntil } from '../utils/form-harness'

// `email` is required (drives aria-required); `note` is optional.
const schema = z.object({ email: z.string().min(1), note: z.string().optional() })
type Api = UseFormReturn<typeof schema>

type Mounted = { app: App; api: Api; input: HTMLInputElement; forced: Ref<DisplayState> }

function uniqueKey(): string {
  return `aria-${Math.random().toString(36).slice(2)}`
}

/**
 * Bind a register value whose `ariaDisplayState` is a ref the test
 * drives directly. The display heuristic decides WHEN a verdict lands
 * (`display-state.test.ts` owns that); these cases are about what the
 * directive writes to the DOM once a verdict exists, so forcing the
 * verdict keeps them isolated from the timing gate and the clock.
 */
function withForcedVerdict(rv: RegisterValue, forced: Ref<DisplayState>): RegisterValue {
  return { ...rv, ariaDisplayState: forced }
}

async function mountField(opts?: {
  display?: DisplayState
  authored?: Record<string, unknown>
  path?: 'email' | 'note'
}): Promise<Mounted> {
  const handle: { api?: Api } = {}
  const forced = ref<DisplayState>(opts?.display ?? 'idle')
  const Parent = defineComponent({
    setup() {
      const api = useForm({ schema, key: uniqueKey() })
      handle.api = api
      const real = api.register(opts?.path ?? 'email')
      const rv = opts?.display !== undefined ? withForcedVerdict(real, forced) : real
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
  return { app, api: handle.api, input: root.firstElementChild as HTMLInputElement, forced }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('auto-aria attribute mapping', () => {
  let mounted: Mounted | undefined
  afterEach(() => {
    mounted?.app.unmount()
    mounted = undefined
  })

  it('maps error to aria-invalid + aria-describedby (and not aria-busy)', async () => {
    mounted = await mountField({ display: 'error' })
    expect(mounted.input.getAttribute('aria-invalid')).toBe('true')
    expect(mounted.input.getAttribute('aria-describedby')).toBe(
      mounted.api.fields.email.aria.errorId
    )
    expect(mounted.input.hasAttribute('aria-busy')).toBe(false)
  })

  it('maps pending to aria-busy (and not aria-invalid / describedby)', async () => {
    mounted = await mountField({ display: 'pending' })
    expect(mounted.input.getAttribute('aria-busy')).toBe('true')
    expect(mounted.input.hasAttribute('aria-invalid')).toBe(false)
    expect(mounted.input.hasAttribute('aria-describedby')).toBe(false)
  })

  it('sets no status attribute for success or idle', async () => {
    for (const state of ['success', 'idle'] as const) {
      const m = await mountField({ display: state })
      expect(m.input.hasAttribute('aria-invalid')).toBe(false)
      expect(m.input.hasAttribute('aria-busy')).toBe(false)
      expect(m.input.hasAttribute('aria-describedby')).toBe(false)
      m.app.unmount()
    }
  })

  it('reflects the schema required flag independent of display state', async () => {
    mounted = await mountField({ display: 'idle' })
    expect(mounted.input.getAttribute('aria-required')).toBe('true')
    // The optional `note` field is not required.
    const optional = await mountField({ path: 'note', display: 'idle' })
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
      display: 'error',
      authored: { 'aria-invalid': 'false', 'aria-describedby': 'my-help' },
    })
    // Authored values survive; the directive manages neither.
    expect(mounted.input.getAttribute('aria-invalid')).toBe('false')
    expect(mounted.input.getAttribute('aria-describedby')).toBe('my-help')
    // Unauthored managed attrs still flow (email is required).
    expect(mounted.input.getAttribute('aria-required')).toBe('true')
  })
})

describe('auto-aria needs a display-state channel', () => {
  let mounted: Mounted | undefined
  afterEach(() => {
    mounted?.app.unmount()
    mounted = undefined
  })

  it('manages nothing for a binding carrying no ariaDisplayState', async () => {
    // A hand-rolled register factory has no field-state accessor to
    // close over, so `buildRegister` omits `ariaDisplayState`. That is
    // the one remaining "aria off" path: there is no opt-out flag.
    const handle: { api?: Api } = {}
    const Parent = defineComponent({
      setup() {
        const api = useForm({ schema, key: uniqueKey() })
        handle.api = api
        const { ariaDisplayState: _dropped, ...withoutChannel } = api.register('email')
        const rv = withoutChannel as RegisterValue
        return () => withDirectives(h('input', { type: 'text' }), [[vRegister, rv]])
      },
    })
    const app = createApp(Parent).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    await waitUntil(() => (root.firstElementChild !== null ? true : null))
    const input = root.firstElementChild as HTMLInputElement
    await handle.api?.handleSubmit(() => undefined)()
    expect(input.hasAttribute('aria-invalid')).toBe(false)
    expect(input.hasAttribute('aria-required')).toBe(false)
    app.unmount()
  })
})

describe('auto-aria re-derives on a path swap', () => {
  it('rebinds aria to the new path when a dynamic register path changes', async () => {
    const handle: { api?: Api } = {}
    const path = ref<'email' | 'note'>('email')
    const Parent = defineComponent({
      setup() {
        const api = useForm({ schema, key: uniqueKey() })
        handle.api = api
        const forced = ref<DisplayState>('error')
        return () =>
          withDirectives(h('input', { type: 'text' }), [
            [vRegister, withForcedVerdict(api.register(path.value), forced)],
          ])
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
    const mounted = await mountField({ display: 'error' })
    const { input } = mounted
    expect(input.getAttribute('aria-invalid')).toBe('true')
    mounted.app.unmount()
    // The directive's beforeUnmount strips the attrs it owned.
    expect(input.hasAttribute('aria-invalid')).toBe(false)
    expect(input.hasAttribute('aria-required')).toBe(false)
    expect(input.hasAttribute('aria-describedby')).toBe(false)
  })
})
