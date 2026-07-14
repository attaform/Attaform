// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, withDirectives, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { vRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import { awaitSettle, makeMounter, waitUntil } from '../utils/form-harness'

/**
 * `useForm({ disabled })` — the per-form data freeze.
 *
 * A disabled form no-ops every value write at the store chokepoint
 * (programmatic, directive, and host-model origins alike), forces every
 * field's `displayState` to `'idle'`, and surfaces `disabled` on the
 * field + form meta. `defaultValues` hydration and `reset()` bypass the
 * freeze so a frozen form can still be seeded or restored. Exercised
 * against both Zod adapters — the freeze lives below the adapter layer,
 * so parity is the contract.
 */

const schemaV4 = zV4.object({ email: zV4.string().min(3) })
const schemaV3 = zV3.object({ email: zV3.string().min(3) })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUseForm = (opts: any) => any

const adapters: ReadonlyArray<{ name: string; useForm: AnyUseForm; schema: unknown }> = [
  { name: 'v4', useForm: useFormV4, schema: schemaV4 },
  { name: 'v3', useForm: useFormV3, schema: schemaV3 },
]

describe.each(adapters)('useForm({ disabled }) — $name', ({ useForm, schema }) => {
  let warnings: string[]
  let warnSpy: ReturnType<typeof vi.spyOn>
  const mounted: App[] = []

  beforeEach(() => {
    warnings = []
    warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
  })

  afterEach(() => {
    for (const app of mounted.splice(0)) app.unmount()
    document.body.innerHTML = ''
    warnSpy.mockRestore()
  })

  it('no-ops programmatic writes while still applying defaultValues', async () => {
    const { api, app } = makeMounter(useForm, schema, {
      disabled: true,
      defaultValues: { email: 'seed@x.com' },
    })()
    mounted.push(app)
    // defaultValues hydration bypasses the freeze — a frozen form still seeds.
    expect(api.values.email).toBe('seed@x.com')
    api.setValue('email', 'changed@x.com')
    await awaitSettle()
    expect(api.values.email).toBe('seed@x.com')
  })

  it('no-ops the directive + host write origins', async () => {
    const { api, app } = makeMounter(useForm, schema, {
      disabled: true,
      defaultValues: { email: 'seed@x.com' },
    })()
    mounted.push(app)
    const rv = api.register('email')
    expect(rv.setValueWithInternalPath('viaDirective')).toBe(false)
    expect(rv.setValueFromHost('viaHost')).toBe(false)
    await awaitSettle()
    expect(api.values.email).toBe('seed@x.com')
  })

  it('reset restores defaults while frozen; a reactive getter toggles the freeze', async () => {
    const frozen = ref(false)
    const { api, app } = makeMounter(useForm, schema, {
      disabled: frozen,
      defaultValues: { email: 'seed@x.com' },
    })()
    mounted.push(app)
    // Not frozen — the write lands.
    api.setValue('email', 'typed@x.com')
    await awaitSettle()
    expect(api.values.email).toBe('typed@x.com')
    // Freeze — the write no-ops.
    frozen.value = true
    await nextTick()
    api.setValue('email', 'blocked@x.com')
    await awaitSettle()
    expect(api.values.email).toBe('typed@x.com')
    // reset bypasses the freeze.
    api.reset()
    await awaitSettle()
    expect(api.values.email).toBe('seed@x.com')
    // Unfreeze — writes land again.
    frozen.value = false
    await nextTick()
    api.setValue('email', 'again@x.com')
    await awaitSettle()
    expect(api.values.email).toBe('again@x.com')
  })

  it('surfaces disabled on the field + form meta and tracks it reactively', async () => {
    const frozen = ref(true)
    const { api, app } = makeMounter(useForm, schema, {
      disabled: frozen,
      defaultValues: { email: 'seed@x.com' },
    })()
    mounted.push(app)
    expect(api.fields.email.disabled).toBe(true)
    expect(api.meta.disabled).toBe(true)
    frozen.value = false
    await nextTick()
    expect(api.fields.email.disabled).toBe(false)
    expect(api.meta.disabled).toBe(false)
  })

  it('forces field.displayState to idle while frozen, even with a revealed error', async () => {
    // Baseline: an un-frozen form reveals the error after a submit attempt.
    const live = makeMounter(useForm, schema, { defaultValues: { email: 'x' } })()
    mounted.push(live.app)
    await live.api.handleSubmit(
      () => {},
      () => {}
    )()
    await waitUntil(() => (live.api.fields.email.displayState === 'error' ? true : null))
    expect(live.api.fields.email.displayState).toBe('error')

    // Frozen: the same setup keeps the error in the store but stands its
    // display signal down to idle.
    const frozen = makeMounter(useForm, schema, {
      disabled: true,
      defaultValues: { email: 'x' },
    })()
    mounted.push(frozen.app)
    await frozen.api.handleSubmit(
      () => {},
      () => {}
    )()
    await awaitSettle()
    expect(frozen.api.fields.email.errors.length).toBeGreaterThan(0)
    expect(frozen.api.fields.email.displayState).toBe('idle')
    expect(frozen.api.fields.email.showErrors).toBe(false)
  })

  it('warns once on the first blocked write, then stays silent', async () => {
    const { api, app } = makeMounter(useForm, schema, {
      disabled: true,
      defaultValues: { email: 'seed@x.com' },
    })()
    mounted.push(app)
    api.setValue('email', 'a')
    api.setValue('email', 'b')
    api.setValue('email', 'c')
    await awaitSettle()
    const disabledWarnings = warnings.filter((w) => w.includes('disabled form'))
    expect(disabledWarnings.length).toBe(1)
  })

  it('disables a mounted native input reactively (render-function client path)', async () => {
    const frozen = ref(false)
    const Parent = defineComponent({
      setup() {
        const form = useForm({
          schema,
          key: `disabled-dom-${Math.random().toString(36).slice(2)}`,
          disabled: frozen,
          strict: false,
          defaultValues: { email: 'seed@x.com' },
        })
        return () =>
          withDirectives(h('input', { class: 'email' }), [[vRegister, form.register('email')]])
      },
    })
    const app = createApp(Parent).use(createAttaform())
    mounted.push(app)
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    await awaitSettle()
    const input = root.querySelector('input.email') as HTMLInputElement
    // No compiled `:disabled` bind on a render-function field; the directive's
    // setupDisabledSync owns el.disabled and tracks the freeze live.
    expect(input.disabled).toBe(false)
    frozen.value = true
    await awaitSettle()
    expect(input.disabled).toBe(true)
    frozen.value = false
    await awaitSettle()
    expect(input.disabled).toBe(false)
  })
})
