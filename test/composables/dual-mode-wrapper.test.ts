// @vitest-environment jsdom
/**
 * One component, used both `v-register`-bound and plain-bound (#620).
 *
 * A wrapper that calls `useRegister()` so it CAN take a form binding
 * rendered a blank control when used without one. The caller's own
 * `:value` was silently discarded, so a `<select>` showed no option, a
 * text input showed nothing, and the caller's model never reached the
 * DOM.
 *
 * The directive was never the cause: it stands down on a non-register
 * value and touches no element. What clobbered was compile-time. The
 * value transforms strip the author's `:value` / `:checked` and inject
 * `(rv)?.displayValue?.value` in its place, and for a nullish register
 * that resolves to `undefined` — a control with no value binding at all.
 * The author's expression is now kept as the UNBOUND leg of the injected
 * one, so a single element serves both modes and no wrapper has to
 * duplicate itself into `v-if` / `v-else` branches carrying two copies
 * of every option and attribute.
 *
 * The bound mode is untouched: `displayValue` always resolves to a
 * string for a real register, `''` included, so the fallback leg is
 * reachable only when the register expression itself is nullish, never
 * when a bound field merely holds an empty value. Every pin below runs
 * in both modes for exactly that reason.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, nextTick, ref, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useRegister } from '../../src'
import { installVRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import { compileToRender } from '../utils/ssr-cross-path'
import { waitUntil } from '../utils/form-harness'

const WRAPPER_TEMPLATE = `<div>
  <select data-testid="sel" v-register="rv" :value="model" @change="onPick">
    <option value="alpha">A</option>
    <option value="beta">B</option>
  </select>
  <input data-testid="txt" v-register="rv" :value="model" />
  <textarea data-testid="ta" v-register="rv" :value="model"></textarea>
  <input data-testid="box" type="checkbox" v-register="rv" value="beta" :checked="model === 'beta'" />
</div>`

/** What the wrapper reported about its own binding, per mount. */
let observedIsBound: unknown

function makeWrapper(model: ReturnType<typeof ref<string>>, optional = true) {
  return defineComponent({
    setup() {
      const rv = optional ? useRegister({ optional: true }) : useRegister()
      observedIsBound = rv?.isBound
      return {
        rv,
        model,
        onPick: (e: Event) => {
          model.value = (e.target as HTMLSelectElement).value
        },
      }
    },
    render: compileToRender(WRAPPER_TEMPLATE),
  })
}

type Mounted = { root: HTMLElement; warns: string[]; restore: () => void }

function mount(
  Comp: ReturnType<typeof defineComponent>,
  appOut: { app: App | undefined }
): Mounted {
  const warns: string[] = []
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(args.map((a) => String(a)).join(' '))
  })
  const app = createApp(Comp).use(createAttaform())
  installVRegister(app)
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  appOut.app = app
  return { root, warns, restore: () => spy.mockRestore() }
}

/**
 * Nothing is redundant beside a directive that stands down: the
 * caller's `:value` is the only writer there is.
 *
 * Asserted by EVERY unbound mount rather than once, because the warn
 * dedupes per signature for the life of the process and this suite runs
 * shuffled — a single pin would pass vacuously whenever another mount
 * happened to run first and consume the signature.
 */
function expectNoRedundantWarn(m: Mounted): void {
  expect(m.warns.filter((w) => w.includes('redundant beside v-register'))).toEqual([])
}

function el<T extends HTMLElement>(root: HTMLElement, id: string): T {
  const found = root.querySelector<T>(`[data-testid="${id}"]`)
  if (found === null) throw new Error(`no [data-testid="${id}"]`)
  return found
}

describe('a dual-mode wrapper used WITHOUT a form', () => {
  const appOut: { app: App | undefined } = { app: undefined }
  afterEach(() => {
    appOut.app?.unmount()
    appOut.app = undefined
    document.body.innerHTML = ''
  })

  it("paints the caller's value on every control", async () => {
    const model = ref('beta')
    const m = mount(makeWrapper(model), appOut)
    await waitUntil(() => m.root.querySelector('select'))
    await nextTick()
    try {
      const sel = el<HTMLSelectElement>(m.root, 'sel')
      expect(sel.value).toBe('beta')
      expect(sel.selectedIndex).toBe(1)
      expect(el<HTMLInputElement>(m.root, 'txt').value).toBe('beta')
      expect(el<HTMLTextAreaElement>(m.root, 'ta').value).toBe('beta')
      expect(el<HTMLInputElement>(m.root, 'box').checked).toBe(true)
      expectNoRedundantWarn(m)
    } finally {
      m.restore()
    }
  })

  it("round-trips a user pick back through the caller's own handler", async () => {
    const model = ref('beta')
    const m = mount(makeWrapper(model), appOut)
    await waitUntil(() => m.root.querySelector('select'))
    try {
      const sel = el<HTMLSelectElement>(m.root, 'sel')
      sel.selectedIndex = 0
      sel.dispatchEvent(new Event('change'))
      await nextTick()
      expect(model.value).toBe('alpha')
      expect(sel.value).toBe('alpha')
      expect(el<HTMLInputElement>(m.root, 'txt').value).toBe('alpha')
      expectNoRedundantWarn(m)
    } finally {
      m.restore()
    }
  })

  it('follows the caller when the value changes from outside', async () => {
    const model = ref('alpha')
    const m = mount(makeWrapper(model), appOut)
    await waitUntil(() => m.root.querySelector('select'))
    try {
      expect(el<HTMLSelectElement>(m.root, 'sel').selectedIndex).toBe(0)
      model.value = 'beta'
      await nextTick()
      expect(el<HTMLSelectElement>(m.root, 'sel').selectedIndex).toBe(1)
      expect(el<HTMLInputElement>(m.root, 'txt').value).toBe('beta')
      expectNoRedundantWarn(m)
    } finally {
      m.restore()
    }
  })

  it('says nothing when the wrapper declared itself optional', async () => {
    const m = mount(makeWrapper(ref('beta')), appOut)
    await waitUntil(() => m.root.querySelector('select'))
    try {
      expect(m.warns.filter((w) => w.includes('no parent registerValue'))).toEqual([])
    } finally {
      m.restore()
    }
  })

  it('still flags a wrapper that did NOT declare itself optional', async () => {
    // The diagnostic keeps earning its keep for the single-mode wrapper
    // whose parent forgot `v-register`: that renders a field which looks
    // fine and stores nothing. Only the author knows which case it is,
    // which is why `optional` is theirs to declare.
    const m = mount(makeWrapper(ref('beta'), false), appOut)
    await waitUntil(() => m.root.querySelector('select'))
    try {
      expect(m.warns.filter((w) => w.includes('no parent registerValue'))).toHaveLength(1)
    } finally {
      m.restore()
    }
  })

  it('reports itself unbound', async () => {
    const m = mount(makeWrapper(ref('beta')), appOut)
    await waitUntil(() => m.root.querySelector('select'))
    try {
      expect(observedIsBound).toBe(false)
      expectNoRedundantWarn(m)
    } finally {
      m.restore()
    }
  })
})

describe('the same wrapper used WITH a form', () => {
  const appOut: { app: App | undefined } = { app: undefined }
  afterEach(() => {
    appOut.app?.unmount()
    appOut.app = undefined
    document.body.innerHTML = ''
  })

  function makeParent(model: ReturnType<typeof ref<string>>, defaultValue: string) {
    return defineComponent({
      setup() {
        const form = useForm({
          schema: z.object({ choice: z.string() }),
          key: `dual-mode-${Math.random().toString(36).slice(2)}`,
          strict: false,
          defaultValues: { choice: defaultValue },
        })
        return { form }
      },
      render: compileToRender(`<div><Wrapper v-register="form.register('choice')" /></div>`),
      components: { Wrapper: makeWrapper(model) },
    })
  }

  it("shows the FIELD's value, not the caller's", async () => {
    // The caller's `:value` is `beta`; the field holds `alpha`. The bound
    // leg wins, which is the property that keeps every existing consumer
    // byte-identical.
    const m = mount(makeParent(ref('beta'), 'alpha'), appOut)
    await waitUntil(() => m.root.querySelector('select'))
    await nextTick()
    try {
      expect(el<HTMLSelectElement>(m.root, 'sel').value).toBe('alpha')
      expect(el<HTMLInputElement>(m.root, 'txt').value).toBe('alpha')
      expect(el<HTMLTextAreaElement>(m.root, 'ta').value).toBe('alpha')
      expect(el<HTMLInputElement>(m.root, 'box').checked).toBe(false)
    } finally {
      m.restore()
    }
  })

  it('shows an empty field as empty, not as the caller value', async () => {
    // The sharp edge of a `??` fallback: a bound field holding `''` must
    // NOT fall through to the caller's expression. `displayValue` returns
    // a string for every real register, so the fallback is unreachable
    // whenever a field resolved at all.
    const m = mount(makeParent(ref('beta'), ''), appOut)
    await waitUntil(() => m.root.querySelector('select'))
    await nextTick()
    try {
      expect(el<HTMLInputElement>(m.root, 'txt').value).toBe('')
      expect(el<HTMLTextAreaElement>(m.root, 'ta').value).toBe('')
    } finally {
      m.restore()
    }
  })

  it('reports itself bound', async () => {
    const m = mount(makeParent(ref('beta'), 'alpha'), appOut)
    await waitUntil(() => m.root.querySelector('select'))
    try {
      expect(observedIsBound).toBe(true)
    } finally {
      m.restore()
    }
  })
})

describe('a parent that binds after the first render', () => {
  const appOut: { app: App | undefined } = { app: undefined }
  afterEach(() => {
    appOut.app?.unmount()
    appOut.app = undefined
    document.body.innerHTML = ''
  })

  it('switches the wrapper from the caller value to the field value', async () => {
    // Why `useRegister()` cannot simply return `undefined` when unbound:
    // it does not yet know. A parent is free to bind on a later render,
    // and the hybrid Proxy is what keeps serving that. `isBound` is the
    // reactive answer instead.
    const ready = ref(false)
    const model = ref('beta')
    const Parent = defineComponent({
      setup() {
        const form = useForm({
          schema: z.object({ choice: z.string() }),
          key: 'dual-mode-late',
          strict: false,
          defaultValues: { choice: 'alpha' },
        })
        return { form, ready }
      },
      render: compileToRender(
        `<div><Wrapper v-register="ready ? form.register('choice') : undefined" /></div>`
      ),
      components: { Wrapper: makeWrapper(model) },
    })
    const m = mount(Parent, appOut)
    await waitUntil(() => m.root.querySelector('select'))
    await nextTick()
    try {
      expect(el<HTMLSelectElement>(m.root, 'sel').value).toBe('beta')
      expect(observedIsBound).toBe(false)

      ready.value = true
      await nextTick()
      await nextTick()

      expect(el<HTMLSelectElement>(m.root, 'sel').value).toBe('alpha')
      expect(el<HTMLInputElement>(m.root, 'txt').value).toBe('alpha')
    } finally {
      m.restore()
    }
  })
})
