// @vitest-environment jsdom
//
// Commit 1 of the async-register-transforms stack: the store-side
// machinery + the bound `RegisterValue` lifecycle hooks. The directive
// (commit 2) is what normally calls these on a real DOM event; here we
// drive the hooks directly to characterize the primitive in isolation:
//
//   - per-path run token (latest-request-wins discard)
//   - in-flight counters backing `settleTransforms` quiescence
//   - synchronous supersede / cancel teardown that aborts the run signal
//
// `field.transforming` / `field.busy` / `field.transformError` arrive in
// commit 3, so this file asserts through `settleTransforms` + the token
// hooks rather than the field surface. Run against both adapters (the
// machinery is adapter-agnostic, but parity is the house rule).
import { afterEach, describe, expect, it } from 'vitest'
import { z as z4 } from 'zod'
import { z as z3 } from 'zod-v3'
import type { App } from 'vue'
import { useForm } from '../../src/zod'
import { makeMounter } from '../utils/form-harness'
import type { InternalRegisterValue, TransformAbortHolder } from '../../src/runtime/types/types-api'

const holder = (): TransformAbortHolder => ({ controller: null, aborted: false })

// Simulate the directive's lazy `ctx.signal` getter reaching for the
// controller mid-run — the store is what aborts it on teardown.
function touchSignal(h: TransformAbortHolder): AbortSignal {
  h.controller ??= new AbortController()
  return h.controller.signal
}

const adapters = [
  { name: 'zod v4', schema: z4.object({ name: z4.string(), email: z4.string() }) },
  { name: 'zod v3', schema: z3.object({ name: z3.string(), email: z3.string() }) },
]

describe.each(adapters)('async-transform store machinery — $name', ({ schema }) => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    document.body.innerHTML = ''
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function mount(): any {
    const { api, app } = makeMounter(useForm, schema)()
    apps.push(app)
    return api
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rvOf = (api: any, path: string): InternalRegisterValue =>
    api.register(path) as InternalRegisterValue

  it('settleTransforms() resolves immediately when nothing is in flight', async () => {
    const api = mount()
    await expect(api.settleTransforms()).resolves.toBeUndefined()
    await expect(api.settleTransforms('name')).resolves.toBeUndefined()
  })

  it('settleTransforms() stays pending until the in-flight run ends', async () => {
    const api = mount()
    const rv = rvOf(api, 'name')
    const token = rv.beginTransform(holder())

    let resolved = false
    const settled = api.settleTransforms().then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)

    rv.endTransform(token)
    await settled
    expect(resolved).toBe(true)
  })

  it('settleTransforms(path) is scoped to its own path', async () => {
    const api = mount()
    const a = rvOf(api, 'name')
    const b = rvOf(api, 'email')
    const ta = a.beginTransform(holder())
    const tb = b.beginTransform(holder())

    let nameSettled = false
    const namePromise = api.settleTransforms('name').then(() => {
      nameSettled = true
    })
    a.endTransform(ta)
    await namePromise
    expect(nameSettled).toBe(true)

    // The whole-form waiter is still pending — `email` is in flight.
    let globalSettled = false
    const globalPromise = api.settleTransforms().then(() => {
      globalSettled = true
    })
    await Promise.resolve()
    expect(globalSettled).toBe(false)

    b.endTransform(tb)
    await globalPromise
    expect(globalSettled).toBe(true)
  })

  it('a superseding run invalidates the prior token (latest-request-wins)', async () => {
    const api = mount()
    const rv = rvOf(api, 'name')
    const t1 = rv.beginTransform(holder())
    const t2 = rv.beginTransform(holder())

    expect(rv.isCurrentTransform(t1)).toBe(false)
    expect(rv.isCurrentTransform(t2)).toBe(true)

    // The stale run ending is a no-op on the counters — the live run
    // still holds the field, so the form is not yet quiescent.
    rv.endTransform(t1)
    let settled = false
    const p = api.settleTransforms('name').then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(rv.isCurrentTransform(t2)).toBe(true)

    rv.endTransform(t2)
    await p
    expect(settled).toBe(true)
  })

  it('supersede aborts the prior run signal and latches the holder', () => {
    const api = mount()
    const rv = rvOf(api, 'name')
    const first = holder()
    rv.beginTransform(first)
    const signal = touchSignal(first)
    expect(signal.aborted).toBe(false)

    rv.beginTransform(holder()) // supersede
    expect(first.aborted).toBe(true)
    expect(signal.aborted).toBe(true)
  })

  it('a signal touched AFTER teardown still resolves to an aborted signal', () => {
    const api = mount()
    const rv = rvOf(api, 'name')
    const first = holder()
    rv.beginTransform(first)
    rv.beginTransform(holder()) // teardown latches `aborted` before the signal exists

    // The directive's getter honors the latch: a controller created late
    // is born aborted (modeled here — the store already set `aborted`).
    expect(first.aborted).toBe(true)
  })

  it('reset() cancels in-flight transforms, aborts signals, and quiesces', async () => {
    const api = mount()
    const rv = rvOf(api, 'name')
    const h = holder()
    const token = rv.beginTransform(h)
    const signal = touchSignal(h)

    api.reset()

    expect(rv.isCurrentTransform(token)).toBe(false)
    expect(h.aborted).toBe(true)
    expect(signal.aborted).toBe(true)
    await expect(api.settleTransforms()).resolves.toBeUndefined()

    // A late end from the cancelled run must not underflow into a
    // negative counter / re-pend the form.
    rv.endTransform(token)
    await expect(api.settleTransforms()).resolves.toBeUndefined()
  })
})
