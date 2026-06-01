// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, onMounted, ref, withDirectives, type App } from 'vue'
import { z } from 'zod'
import { useForm, type UseFormReturn } from '../../src/zod'
import { assignKey, vRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import type {
  CustomDirectiveRegisterAssignerFn,
  RegisterValue,
} from '../../src/runtime/types/types-api'
import { waitForPersistence, waitUntil } from '../utils/form-harness'

/**
 * Fire-time contract for consumer-supplied assigners.
 *
 * The library exposes two install paths for an assigner override:
 *   1. `@update:registerValue` vnode-prop listener — wrapped at
 *      `created`-time by `getModelAssigner`.
 *   2. `el[assignKey] = fn` symbol assignment — installed pre- (a
 *      companion directive ordered first) or post- (`onMounted` /
 *      ref-callback).
 *
 * Both paths must hand the consumer's function the SAME fire-time
 * arg shape: `(post-transform-post-coerce value, registerValue)`. The
 * second arg is what `/demos/custom-assigners` relies on to commit
 * `rv.setValueWithInternalPath(el.dataset.color)`.
 *
 * Pre-fix, the directive bodies invoked the symbol-installed fn with
 * one argument and without running the field's transform pipeline or
 * coerce closure. The two paths diverged silently.
 */
describe('fire-time contract: consumer-installed assigner sees (value, rv) consistently', () => {
  let app: App | undefined
  let root: HTMLElement | undefined

  afterEach(() => {
    app?.unmount()
    app = undefined
    if (root?.parentNode) {
      root.parentNode.removeChild(root)
    }
    root = undefined
    document.body.innerHTML = ''
  })

  it('mirrors the custom-assigners demo: dataset write + input dispatch commits via rv.setValueWithInternalPath', async () => {
    const demoSchema = z.object({ color: z.string() })
    let capturedApi: UseFormReturn<typeof demoSchema> | undefined
    let widgetEl: HTMLDivElement | undefined

    const Parent = defineComponent({
      setup() {
        const api = useForm({
          schema: demoSchema,
          defaultValues: { color: '#2563eb' },
          key: `assigner-demo-${Math.random().toString(36).slice(2)}`,
        })
        capturedApi = api
        const widget = ref<HTMLDivElement | null>(null)

        const colorAssigner: CustomDirectiveRegisterAssignerFn = (_value, rv) => {
          const el = widget.value
          if (!el || !rv) return false
          rv.setValueWithInternalPath(el.dataset['color'] ?? '')
          return true
        }

        onMounted(() => {
          const el = widget.value
          if (el === null) return
          widgetEl = el
          ;(el as HTMLDivElement & { [k: symbol]: CustomDirectiveRegisterAssignerFn })[assignKey] =
            colorAssigner
        })

        return () =>
          withDirectives(h('div', { ref: widget, 'data-color': api.values['color'] }), [
            [vRegister, api.register('color')],
          ])
      },
    })

    app = createApp(Parent).use(createAttaform())
    root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    await waitUntil(() => (widgetEl !== undefined ? true : null))

    if (widgetEl === undefined) throw new Error('widget element never resolved')
    if (capturedApi === undefined) throw new Error('api never captured')

    widgetEl.dataset['color'] = '#16a34a'
    widgetEl.dispatchEvent(new Event('input', { bubbles: true }))

    await waitUntil(() => (capturedApi?.values['color'] === '#16a34a' ? true : null), 200)
    expect(capturedApi.values['color']).toBe('#16a34a')
  })

  it('the assigner receives the bound RegisterValue at the second argument', async () => {
    const schema = z.object({ name: z.string() })
    const calls: { value: unknown; rv: unknown }[] = []
    let widgetEl: HTMLDivElement | undefined

    const Parent = defineComponent({
      setup() {
        const api = useForm({
          schema,
          key: `assigner-rv-${Math.random().toString(36).slice(2)}`,
        })
        const widget = ref<HTMLDivElement | null>(null)

        const recordingAssigner: CustomDirectiveRegisterAssignerFn = (value, rv) => {
          calls.push({ value, rv })
          return true
        }

        onMounted(() => {
          const el = widget.value
          if (el === null) return
          widgetEl = el
          ;(el as HTMLDivElement & { [k: symbol]: CustomDirectiveRegisterAssignerFn })[assignKey] =
            recordingAssigner
        })

        return () => withDirectives(h('div', { ref: widget }), [[vRegister, api.register('name')]])
      },
    })

    app = createApp(Parent).use(createAttaform())
    root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    await waitUntil(() => (widgetEl !== undefined ? true : null))

    if (widgetEl === undefined) throw new Error('widget element never resolved')

    widgetEl.dispatchEvent(new Event('input', { bubbles: true }))
    await waitUntil(() => (calls.length >= 1 ? true : null), 200)

    expect(calls.length).toBeGreaterThanOrEqual(1)
    const rv = calls[0]?.rv as Partial<RegisterValue> | undefined
    expect(typeof rv?.setValueWithInternalPath).toBe('function')
    expect(rv?.path).toBeDefined()
    expect(rv?.innerRef).toBeDefined()
  })

  it('field transforms run before a consumer-installed assigner sees the value', async () => {
    const schema = z.object({ name: z.string() })
    const calls: unknown[] = []
    let inputEl: HTMLInputElement | undefined

    const Parent = defineComponent({
      setup() {
        const api = useForm({
          schema,
          key: `assigner-transforms-${Math.random().toString(36).slice(2)}`,
        })
        const input = ref<HTMLInputElement | null>(null)

        const recordingAssigner: CustomDirectiveRegisterAssignerFn = (value) => {
          calls.push(value)
          return true
        }

        onMounted(() => {
          const el = input.value
          if (el === null) return
          inputEl = el
          ;(el as HTMLInputElement & { [k: symbol]: CustomDirectiveRegisterAssignerFn })[
            assignKey
          ] = recordingAssigner
        })

        return () =>
          withDirectives(h('input', { type: 'text', ref: input }), [
            [vRegister, api.register('name', { transforms: [(v) => String(v).toUpperCase()] })],
          ])
      },
    })

    app = createApp(Parent).use(createAttaform())
    root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    await waitUntil(() => (inputEl !== undefined ? true : null))

    if (inputEl === undefined) throw new Error('input element never resolved')

    inputEl.value = 'hi'
    inputEl.dispatchEvent(new Event('input', { bubbles: true }))
    await waitUntil(() => (calls.length >= 1 ? true : null), 200)

    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0]).toBe('HI')
  })

  /**
   * Persistence-meta auto-attach: the demo pattern is
   * `rv.setValueWithInternalPath(value)` with no explicit `meta`. The
   * RV's `registerElement` (called by the directive at bind time) stores
   * the el; `setValueWithInternalPath` consults the per-element opt-in
   * registry on writes that don't carry their own meta. So a consumer
   * assigner installed against an element registered with
   * `register('path', { persist: true })` participates in the same
   * persistence channel the directive's default assigner uses.
   *
   * Pre-fix: meta home lived in the directive's default assigner only;
   * consumer-installed assigners silently dropped the persist flag,
   * `form.values` updated, storage stayed empty, the next mount
   * rehydrated to schema default.
   */
  it('a consumer-installed assigner participates in per-element persistence opt-in', async () => {
    const schema = z.object({ color: z.string() })
    const writes: { key: string; value: unknown }[] = []
    const memoryAdapter = {
      getItem(): Promise<unknown> {
        return Promise.resolve(null)
      },
      setItem(key: string, value: unknown): Promise<void> {
        writes.push({ key, value })
        return Promise.resolve()
      },
      removeItem(): Promise<void> {
        return Promise.resolve()
      },
      listKeys(): Promise<string[]> {
        return Promise.resolve([])
      },
    }

    let widgetEl: HTMLDivElement | undefined
    const Parent = defineComponent({
      setup() {
        const api = useForm({
          schema,
          defaultValues: { color: '#000' },
          key: `assigner-persist-${Math.random().toString(36).slice(2)}`,
          persist: { storage: memoryAdapter, debounceMs: 0 },
        })
        const widget = ref<HTMLDivElement | null>(null)

        // The demo's exact shape: read picked color off dataset and
        // forward via `rv.setValueWithInternalPath(value)` with no meta.
        // The RV auto-attaches the per-element persist meta from its
        // bound element's opt-in.
        const colorAssigner: CustomDirectiveRegisterAssignerFn = (_value, rv) => {
          const el = widget.value
          if (!el || !rv) return false
          rv.setValueWithInternalPath(el.dataset['color'] ?? '')
          return true
        }

        onMounted(() => {
          const el = widget.value
          if (el === null) return
          widgetEl = el
          ;(el as HTMLDivElement & { [k: symbol]: CustomDirectiveRegisterAssignerFn })[assignKey] =
            colorAssigner
        })

        return () =>
          withDirectives(h('div', { ref: widget, 'data-color': api.values['color'] }), [
            [vRegister, api.register('color', { persist: true })],
          ])
      },
    })

    app = createApp(Parent).use(createAttaform())
    root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    await waitUntil(() => (widgetEl !== undefined ? true : null))

    if (widgetEl === undefined) throw new Error('widget element never resolved')

    await waitForPersistence(app)
    widgetEl.dataset['color'] = '#16a34a'
    widgetEl.dispatchEvent(new Event('input', { bubbles: true }))

    await waitUntil(() => (writes.length >= 1 ? true : null), 200)
    expect(writes.length).toBeGreaterThanOrEqual(1)
    const envelope = writes[writes.length - 1]?.value as {
      data: { form: { color: string } }
    }
    expect(envelope.data.form.color).toBe('#16a34a')
  })
})
