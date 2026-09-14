// @vitest-environment jsdom
/**
 * An observing listener beside `v-register` reads COMMITTED state (#570).
 *
 * A surface that persists each decision as it is made (a row of selects
 * classified one at a time, a checklist saved per tick) wants two things
 * at once: the directive's binding and SSR value injection, and a
 * reaction per interaction. Those are compatible, and the guidance that
 * said otherwise sent at least one reporter to redesign their screen
 * around a batch submit to keep the rendering guarantee.
 *
 * The compatibility rests on ORDER, and the order is not incidental.
 * `vRegister` attaches its listeners in the `created` hook, which Vue
 * runs before it applies the element's props — so the directive's
 * listener is registered first, fires first, and has written the field
 * by the time the author's handler is invoked. An author reading
 * `form.values.<path>` from `@change` therefore sees the new value, not
 * the previous one.
 *
 * Nothing pinned that. It is a property of hook ordering in two
 * codebases (where the directive attaches, and when Vue patches props),
 * so either side could move it without a single existing test noticing,
 * and the symptom would be a save that persists the value before last:
 * silent, off by one interaction, and invisible in any render assertion.
 * The reporter's instinct was exactly right ("I did not want to find out
 * whether it works by accident"), so this makes it a gate rather than a
 * promise.
 *
 * Every variant that carries its own listener is covered, because they
 * attach in four different `created` hooks: the text/lazy pair, the
 * select, the checkbox, and the radio.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, nextTick, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { installVRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import { compileToRender } from '../utils/ssr-cross-path'
import { waitUntil } from '../utils/form-harness'

// The v3 and v4 `useForm` overload sets don't unify into one callable
// signature, so an adapter-agnostic caller types the function the way
// `makeMounter` in `test/utils/form-harness.ts` does.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUseForm = (options: any) => any

type Adapter = {
  readonly name: string
  readonly useFormFn: AnyUseForm
  readonly text: unknown
  readonly bool: unknown
}

const adapters: readonly Adapter[] = [
  {
    name: 'v4',
    useFormFn: useFormV4,
    text: zV4.object({ choice: zV4.string() }),
    bool: zV4.object({ choice: zV4.boolean() }),
  },
  {
    name: 'v3',
    useFormFn: useFormV3,
    text: zV3.object({ choice: zV3.string() }),
    bool: zV3.object({ choice: zV3.boolean() }),
  },
]

type Case = {
  readonly label: string
  readonly template: string
  /** `text` unless the leaf is a boolean (the checkbox). */
  readonly leaf?: 'bool'
  readonly defaultValue: string | boolean
  /** Drive the DOM the way a user would. */
  readonly interact: (el: HTMLElement) => void
  /** What the field must hold by the time the author's handler runs. */
  readonly committed: string | boolean
}

const CASES: readonly Case[] = [
  {
    label: 'select, @change',
    template: `<select data-testid="c" v-register="form.register('choice')" @change="observe">
      <option value="alpha">A</option><option value="beta">B</option>
    </select>`,
    defaultValue: 'alpha',
    interact: (el) => {
      const select = el as HTMLSelectElement
      select.selectedIndex = 1
      select.dispatchEvent(new Event('change'))
    },
    committed: 'beta',
  },
  {
    label: 'text input, @input',
    template: `<input data-testid="c" v-register="form.register('choice')" @input="observe" />`,
    defaultValue: '',
    interact: (el) => {
      const input = el as HTMLInputElement
      input.value = 'typed'
      input.dispatchEvent(new Event('input'))
    },
    committed: 'typed',
  },
  {
    label: 'text input, @change',
    template: `<input data-testid="c" v-register="form.register('choice')" @change="observe" />`,
    defaultValue: '',
    interact: (el) => {
      const input = el as HTMLInputElement
      input.value = 'typed'
      input.dispatchEvent(new Event('input'))
      input.dispatchEvent(new Event('change'))
    },
    committed: 'typed',
  },
  {
    label: 'lazy text input, @change',
    // `.lazy` moves the directive's own listener onto `change`, so here
    // both listeners sit on the same event and only registration order
    // separates them.
    template: `<input data-testid="c" v-register.lazy="form.register('choice')" @change="observe" />`,
    defaultValue: '',
    interact: (el) => {
      const input = el as HTMLInputElement
      input.value = 'lazily'
      input.dispatchEvent(new Event('change'))
    },
    committed: 'lazily',
  },
  {
    label: 'checkbox, @change',
    template: `<input data-testid="c" type="checkbox" v-register="form.register('choice')" @change="observe" />`,
    leaf: 'bool',
    defaultValue: false,
    interact: (el) => {
      const input = el as HTMLInputElement
      input.checked = true
      input.dispatchEvent(new Event('change'))
    },
    committed: true,
  },
  {
    label: 'radio, @change',
    template: `<input data-testid="c" type="radio" value="beta" v-register="form.register('choice')" @change="observe" />`,
    defaultValue: 'alpha',
    interact: (el) => {
      const input = el as HTMLInputElement
      input.checked = true
      input.dispatchEvent(new Event('change'))
    },
    committed: 'beta',
  },
]

describe.each(adapters)('$name: a listener beside v-register', ({ useFormFn, text, bool }) => {
  const appOut: { app: App | undefined } = { app: undefined }
  afterEach(() => {
    appOut.app?.unmount()
    appOut.app = undefined
    document.body.innerHTML = ''
  })

  it.each(CASES.map((c) => [c.label, c] as const))(
    '%s sees the committed value',
    async (_label, testCase) => {
      const observed: unknown[] = []
      const Comp = defineComponent({
        setup() {
          const form = useFormFn({
            schema: testCase.leaf === 'bool' ? bool : text,
            key: `obs-570-${_label}-${Math.random().toString(36).slice(2)}`,
            strict: false,
            defaultValues: { choice: testCase.defaultValue },
          })
          return {
            form,
            // The author's handler: it READS the field and never writes
            // it, which is what keeps it from being a second binding.
            observe: () => {
              observed.push(form.values.choice)
            },
          }
        },
        render: compileToRender(`<div>${testCase.template}</div>`),
      })

      const app = createApp(Comp).use(createAttaform())
      installVRegister(app)
      const root = document.createElement('div')
      document.body.appendChild(root)
      app.mount(root)
      appOut.app = app
      await waitUntil(() => root.querySelector('[data-testid="c"]'))
      await nextTick()

      const control = root.querySelector<HTMLElement>('[data-testid="c"]')
      expect(control).not.toBeNull()
      if (control === null) return
      testCase.interact(control)
      await nextTick()

      // Fired at all: without this an unattached handler would satisfy
      // the value assertion vacuously by never running.
      expect(observed).toHaveLength(1)
      // Committed, not stale. This is the whole pin: `defaultValue` is
      // what a listener that ran FIRST would have seen.
      expect(observed[0]).toBe(testCase.committed)
      expect(observed[0]).not.toBe(testCase.defaultValue)
    }
  )
})
