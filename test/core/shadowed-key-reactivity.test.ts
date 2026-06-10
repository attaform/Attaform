// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, watch, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Reactivity of prototype-shadowed-key FIELDS (T5 investigation side-probe).
 *
 * `test/core/shadowed-keys-safety.test.ts` proves value-FLOW: after a write,
 * a FRESH read of a shadowed leaf returns the new value. This suite proves
 * reactivity-FLOW: a reactive read PRIMED before the write must update AFTER
 * it (and a watcher must fire) — the property of a primed computed that the
 * round-trip test cannot see (its reads are all first-access, so they compute
 * fresh regardless of whether any dependency fired).
 *
 * Why this is in question: a shadowed-key read goes through `safeOwnRead`
 * (`Object.getOwnPropertyDescriptor`), which BYPASSES Vue's reactive get-trap
 * and so establishes no per-property dependency. Pre-Bust-2 every write
 * re-referenced the root, so the coarse whole-`form`-ref dependency woke every
 * reader regardless of per-key tracking. Post-Bust-2 a leaf write mutates in
 * place and preserves root identity, so only fine-grained property deps fire —
 * which a shadowed leaf never registered.
 *
 * Both adapters: the write/read path is shared core, adapter-independent.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Adapter = { tag: string; z: any; useForm: any }
const ADAPTERS: Adapter[] = [
  { tag: 'v4', z: zV4, useForm: useFormV4 },
  { tag: 'v3', z: zV3 as any, useForm: useFormV3 },
]

const apps: App[] = []
afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
  document.body.innerHTML = ''
})

function mount(a: Adapter): any {
  const schema = a.z.object({
    email: a.z.string(),
    hasOwnProperty: a.z.string(),
    wrap: a.z.object({ toString: a.z.string(), city: a.z.string() }),
  })
  const defaultValues = {
    email: 'a@b.com',
    hasOwnProperty: 'h0',
    wrap: { toString: 't0', city: 'NYC' },
  }
  let captured: any
  const App = defineComponent({
    setup() {
      captured = a.useForm({
        schema,
        key: `shadowed-reactivity-${a.tag}-${Math.random().toString(36).slice(2)}`,
        defaultValues,
      })
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.config.warnHandler = () => {}
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  apps.push(app)
  if (captured === undefined) throw new Error('useForm did not return')
  return captured
}

describe.each(ADAPTERS)('shadowed-key reactivity [$tag]', (a) => {
  it('a primed reactive read of a NORMAL leaf updates after setValue (positive control)', async () => {
    const form = mount(a)
    const r = form.toRef('email')
    let fires = 0
    watch(r, () => (fires += 1))
    expect(r.value).toBe('a@b.com') // prime
    form.setValue('email', 'changed@x.com')
    await nextTick()
    expect(r.value).toBe('changed@x.com')
    expect(fires).toBeGreaterThan(0)
  })

  it('a primed reactive read of a normal NESTED leaf updates after setValue (positive control)', async () => {
    const form = mount(a)
    const r = form.toRef('wrap.city')
    let fires = 0
    watch(r, () => (fires += 1))
    expect(r.value).toBe('NYC')
    form.setValue('wrap.city', 'LA')
    await nextTick()
    expect(r.value).toBe('LA')
    expect(fires).toBeGreaterThan(0)
  })

  it('a primed reactive read of a FLAT shadowed leaf updates after setValue', async () => {
    const form = mount(a)
    const r = form.toRef('hasOwnProperty')
    let fires = 0
    watch(r, () => (fires += 1))
    expect(r.value).toBe('h0') // prime
    form.setValue('hasOwnProperty', 'h1')
    await nextTick()
    expect(r.value).toBe('h1')
    expect(fires).toBeGreaterThan(0)
  })

  it('a primed reactive read of a NESTED shadowed leaf updates after setValue', async () => {
    const form = mount(a)
    const r = form.toRef('wrap.toString')
    let fires = 0
    watch(r, () => (fires += 1))
    expect(r.value).toBe('t0') // prime
    form.setValue('wrap.toString', 't1')
    await nextTick()
    expect(r.value).toBe('t1')
    expect(fires).toBeGreaterThan(0)
  })

  it('does not deadlock when a watcher on a shadowed field writes back to a normal field', async () => {
    const form = mount(a)
    const hop = form.toRef('hasOwnProperty')
    const stop = watch(hop, (next) => {
      // Write-back on every shadowed-field change — the mirror pattern that
      // the coarse `triggerRef` must not turn into an infinite re-fire.
      form.setValue('email', `mirror:${String(next)}`)
    })
    form.setValue('hasOwnProperty', 'h1')
    await nextTick()
    await nextTick()
    expect(hop.value).toBe('h1')
    expect(form.toRef('email').value).toBe('mirror:h1')
    stop()
  })

  it('a shadowed-field write does not spuriously fire watchers on unrelated normal fields', async () => {
    const form = mount(a)
    const email = form.toRef('email')
    let emailFires = 0
    const stop = watch(email, () => (emailFires += 1))
    expect(email.value).toBe('a@b.com') // prime
    form.setValue('hasOwnProperty', 'h1')
    await nextTick()
    // `triggerRef(form)` re-evaluates every field computed, but a computed
    // that recomputes to the same value notifies no downstream watcher — the
    // unrelated normal field must stay quiet.
    expect(emailFires).toBe(0)
    stop()
  })
})
