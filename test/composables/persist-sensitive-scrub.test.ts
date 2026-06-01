// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, withDirectives, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import type { UseFormReturn } from '../../src/zod'
import { vRegister } from '../../src/runtime/core/directive'
import { stripUnacknowledgedSensitiveLeaves } from '../../src/runtime/core/persistence/payload'
import { isSensitivePath } from '../../src/runtime/core/persistence/sensitive-names'
import { canonicalizePath } from '../../src/runtime/core/paths'
import { createAttaform } from '../../src/runtime/core/plugin'
import { waitForPersistence, waitUntil } from '../utils/form-harness'

/**
 * SEC-1: a CONTAINER persist opt-in (`register('payment', { persist:
 * true })`) pulls the whole subtree into the persisted payload via
 * `pluckPaths`, which copies by reference — so nested sensitive leaves
 * (cvv, cardNumber) reached client-side storage in cleartext even
 * though they were never individually acknowledged. The writer now
 * scrubs sensitive leaves that aren't covered by an acknowledged opt-in
 * before writing.
 */

const schema = z.object({
  payment: z.object({
    cvv: z.string(),
    cardNumber: z.string(),
    last4: z.string(),
  }),
})

type StoredEnvelope = { data: { form: { payment: Record<string, unknown> } } }

function readPersisted(base: string): StoredEnvelope | null {
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i)
    if (k === null) continue
    if (k === base || k.startsWith(`${base}:`)) {
      const raw = localStorage.getItem(k)
      return raw === null ? null : (JSON.parse(raw) as StoredEnvelope)
    }
  }
  return null
}

const apps: App[] = []
beforeEach(() => localStorage.clear())
afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
  localStorage.clear()
})

describe('SEC-1 — persisted payload sheds unacknowledged nested secrets', () => {
  it('a container opt-in does not write nested cvv / cardNumber to disk', async () => {
    const storageKey = 'test-sec1-scrub'
    let last4El: HTMLInputElement | undefined
    const handle: { api?: UseFormReturn<typeof schema> } = {}
    const App = defineComponent({
      setup() {
        const api = useForm({
          schema,
          key: 'sec1-scrub',
          persist: { storage: 'local', key: storageKey, debounceMs: 10 },
          defaultValues: { payment: { cvv: '', cardNumber: '', last4: '' } },
        })
        handle.api = api
        return () =>
          h('div', [
            // Container opt-in: pulls the whole `payment` subtree into the
            // payload. `register` only types LEAF paths, so a container
            // opt-in is reachable from untyped (JS) consumers or a
            // type-bypass — cast the path to simulate that.
            withDirectives(h('input', { type: 'text' }), [
              [vRegister, api.register('payment' as 'payment.last4', { persist: true })],
            ]),
            // Leaf binding that drives the persist write.
            withDirectives(
              h('input', {
                type: 'text',
                ref: (el): void => {
                  if (el !== null) last4El = el as HTMLInputElement
                },
              }),
              [[vRegister, api.register('payment.last4', { persist: true })]]
            ),
          ])
      },
    })
    const app = createApp(App).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    apps.push(app)

    const api = handle.api
    if (api === undefined) throw new Error('setup did not capture api')
    // Populate the secrets (they only need to exist in form.value).
    api.setValue('payment.cvv', '123')
    api.setValue('payment.cardNumber', '4111111111111111')

    // Drive a persist write from the opted-in last4 binding.
    if (last4El === undefined) throw new Error('last4 input not mounted')
    await waitForPersistence(app)
    last4El.value = '1111'
    last4El.dispatchEvent(new Event('input', { bubbles: true }))

    await waitUntil(() => (readPersisted(storageKey) !== null ? true : null))
    const payment = readPersisted(storageKey)?.data.form.payment ?? {}
    expect(payment['last4']).toBe('1111') // non-sensitive sibling persists
    expect(payment['cvv']).toBeUndefined() // sensitive, unacknowledged → stripped
    expect(payment['cardNumber']).toBeUndefined()
  })
})

describe('stripUnacknowledgedSensitiveLeaves (unit)', () => {
  const key = (p: string): ReturnType<typeof canonicalizePath>['key'] => canonicalizePath(p).key

  it('strips sensitive leaves dragged in by a non-sensitive container opt-in', () => {
    const form = { payment: { cvv: '123', cardNumber: '4111', last4: '1111' } }
    const optedIn = new Set([key('payment')])
    expect(stripUnacknowledgedSensitiveLeaves(form, optedIn, isSensitivePath)).toEqual({
      payment: { last4: '1111' },
    })
  })

  it('keeps a directly-acknowledged sensitive leaf (its exact path is opted in)', () => {
    const form = { payment: { cvv: '123' } }
    const optedIn = new Set([key('payment.cvv')])
    expect(stripUnacknowledgedSensitiveLeaves(form, optedIn, isSensitivePath)).toEqual({
      payment: { cvv: '123' },
    })
  })

  it('keeps the whole subtree of an acknowledged sensitive container', () => {
    const form = { secret: { token: 'x', note: 'y' } }
    const optedIn = new Set([key('secret')])
    expect(stripUnacknowledgedSensitiveLeaves(form, optedIn, isSensitivePath)).toEqual({
      secret: { token: 'x', note: 'y' },
    })
  })
})
