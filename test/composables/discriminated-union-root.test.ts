// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, watchEffect, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'
import { waitUntil } from '../utils/form-harness'

/**
 * Discriminated-union ROOT (variant form): the whole schema is a
 * `z.discriminatedUnion`, not a DU nested under a key. The engine's
 * variant machinery must fire at the root path `[]` exactly as it does
 * for an interior DU:
 *
 *   - default derivation seeds the FIRST variant,
 *   - writing the root discriminator reshapes storage (old variant keys
 *     purged, new variant keys seeded),
 *   - the active-path error filter hides the inactive variant's errors,
 *   - the reshape does not flash an empty `{}` frame between two
 *     meaningful error states (the du-variant-error-flicker contract).
 *
 * Pinned on both adapters per the v3/v4 parity contract.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUseForm = (opts: any) => any

const adapters = [
  { name: 'zod v3', useForm: useFormV3 as AnyUseForm, z: zV3 as unknown as typeof zV4 },
  { name: 'zod v4', useForm: useFormV4 as AnyUseForm, z: zV4 },
] as const

let keySeq = 0

describe.each(adapters)('discriminated-union root — $name', ({ useForm, z }) => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    document.body.innerHTML = ''
  })

  const schema = z.discriminatedUnion('method', [
    z.object({ method: z.literal('card'), cardNumber: z.string().min(1, 'Card number required') }),
    z.object({ method: z.literal('bank'), iban: z.string().min(7, 'IBAN too short') }),
  ])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function mount(defaultValues?: any): { api: any; snapshots: string[] } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle: { api?: any } = {}
    const snapshots: string[] = []
    const Host = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `du-root-${keySeq++}`,
          ...(defaultValues ? { defaultValues } : {}),
          validateOn: 'change',
          debounceMs: 0,
        })
        watchEffect(() => {
          snapshots.push(JSON.stringify(handle.api?.errors))
        })
        return () => h('div')
      },
    })
    const app = createApp(Host).use(createAttaform())
    app.config.warnHandler = () => {}
    app.config.errorHandler = () => {}
    app.mount(document.createElement('div'))
    apps.push(app)
    return { api: handle.api, snapshots }
  }

  it('defaults to the first variant', () => {
    const { api } = mount()
    expect(api.values.method).toBe('card')
    expect(api.values.cardNumber).toBe('')
    // The bank-only key is absent while the card variant is active.
    expect(api.values.iban).toBeUndefined()
  })

  it('writing the root discriminator reshapes storage to the new variant', async () => {
    const { api } = mount({ method: 'card', cardNumber: '4242' })
    expect(api.values.cardNumber).toBe('4242')

    api.setValue('method', 'bank')
    await waitUntil(() => (api.values.method === 'bank' ? true : null))

    // New variant seeded, old variant key purged.
    expect(api.values.iban).toBe('')
    expect(api.values.cardNumber).toBeUndefined()
  })

  it('filters the inactive variant errors after a root switch, with no {} flicker', async () => {
    const { api, snapshots } = mount({ method: 'card', cardNumber: '' })

    // Card variant: cardNumber '' fails min(1).
    await waitUntil(() => (snapshots.some((s) => /cardNumber/.test(s)) ? true : null))
    const initialIdx = snapshots.findIndex((s) => /cardNumber/.test(s))
    expect(initialIdx).toBeGreaterThanOrEqual(0)

    // Switch to bank: iban '' fails min(7); the cardNumber error must clear.
    api.setValue('method', 'bank')
    await waitUntil(() => (/iban/.test(snapshots[snapshots.length - 1] ?? '') ? true : null))

    const finalSnapshot = snapshots[snapshots.length - 1] ?? ''
    expect(finalSnapshot).toMatch(/iban/)
    expect(finalSnapshot).not.toMatch(/cardNumber/)

    // No empty frame between the last card-error snapshot and the bank one.
    const transition = snapshots.slice(initialIdx)
    let lastNonEmpty = -1
    for (let i = transition.length - 1; i >= 0; i--) {
      if (transition[i] !== '{}') {
        lastNonEmpty = i
        break
      }
    }
    const blanks = transition.slice(0, lastNonEmpty).filter((s) => s === '{}')
    expect(blanks).toEqual([])
  })
})
