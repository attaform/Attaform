// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, withDirectives, type App } from 'vue'
import { z } from 'zod'
import { vRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import { useRegister } from '../../src/runtime/composables/use-register'
import { useForm } from '../../src/zod'
import { awaitSettle, waitUntil } from '../utils/form-harness'

/**
 * Regression coverage for the two autoAria `aria-required` scoping
 * defects, #381 and #404. Both trace back to `resolveAriaValue`
 * deciding `aria-required` purely from `rv.isRequired` (the schema's
 * path-level required flag), applied uniformly to whatever element
 * `v-register` resolves to:
 *
 *   - #381: every `<input type="checkbox">` aggregating into an array
 *           model carries `aria-required`, though no member checkbox is
 *           individually required and an empty selection (`[]`) is valid.
 *   - #404: a component host's root element (a presentational wrapper
 *           such as a `<div>`) carries `aria-required` — invalid ARIA on
 *           a role-less element — instead of only the bound inner control.
 *
 * These specs assert the FIXED behaviour and are expected to fail on the
 * unfixed tree (proving the bugs reproduce).
 */

describe('#381 — aria-required is not stamped on array-member checkboxes', () => {
  let app: App | undefined
  afterEach(() => {
    app?.unmount()
    app = undefined
    document.body.innerHTML = ''
  })

  it('omits aria-required on every checkbox bound to a required array path', async () => {
    const schema = z.object({ permissions: z.array(z.string()) })
    const Parent = defineComponent({
      setup() {
        const form = useForm({
          schema,
          key: 'aria-381-array',
          defaultValues: { permissions: ['role_create'] },
          strict: false,
        })
        return () =>
          h(
            'fieldset',
            ['role_create', 'role_update', 'member_invite'].map((v) =>
              withDirectives(h('input', { type: 'checkbox', value: v, class: `cb-${v}` }), [
                [vRegister, form.register('permissions')],
              ])
            )
          )
      },
    })
    app = createApp(Parent).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    await waitUntil(() => (root.querySelector('input.cb-role_create') !== null ? true : null))
    await awaitSettle()

    const boxes = Array.from(root.querySelectorAll('input[type=checkbox]')) as HTMLInputElement[]
    expect(boxes.length).toBe(3)
    for (const box of boxes) {
      expect(box.hasAttribute('aria-required')).toBe(false)
    }
  })

  it('still stamps aria-required on a required single boolean checkbox (no over-correction)', async () => {
    const schema = z.object({ agree: z.boolean() })
    const Parent = defineComponent({
      setup() {
        const form = useForm({ schema, key: 'aria-381-bool', strict: false })
        return () =>
          withDirectives(h('input', { type: 'checkbox', class: 'agree' }), [
            [vRegister, form.register('agree')],
          ])
      },
    })
    app = createApp(Parent).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    await waitUntil(() => (root.querySelector('input.agree') !== null ? true : null))
    await awaitSettle()

    const box = root.querySelector('input.agree') as HTMLInputElement
    expect(box.getAttribute('aria-required')).toBe('true')
  })
})

describe('#404 — aria-required lands on the bound control, not the component host root', () => {
  let app: App | undefined
  afterEach(() => {
    app?.unmount()
    app = undefined
    document.body.innerHTML = ''
  })

  const schema = z.object({ email: z.string() })

  // A presentational wrapper whose root is a non-control <div>, with the
  // real <input> re-bound via useRegister — the recommended styled-field
  // pattern from the #404 report.
  const FieldWrapper = defineComponent({
    name: 'FieldWrapper',
    inheritAttrs: false,
    setup() {
      const register = useRegister()
      return { register }
    },
    render() {
      return h('div', { class: 'field-wrapper' }, [
        withDirectives(h('input', { type: 'text', class: 'inner' }), [[vRegister, this.register]]),
      ])
    },
  })

  function mountWrapper(): { root: HTMLElement } {
    const Parent = defineComponent({
      setup() {
        const form = useForm({ schema, key: 'aria-404', defaultValues: { email: '' } })
        const rv = form.register('email')
        return () =>
          withDirectives(h(FieldWrapper, { registerValue: rv, value: rv.innerRef.value }), [
            [vRegister, rv],
          ])
      },
    })
    app = createApp(Parent).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    return { root }
  }

  it('does NOT stamp aria-required on the component host root (the wrapper <div>)', async () => {
    const { root } = mountWrapper()
    await waitUntil(() => (root.querySelector('input.inner') !== null ? true : null))
    await awaitSettle()

    const wrapper = root.querySelector('div.field-wrapper') as HTMLElement
    // aria-required on a role-less <div> is invalid ARIA (axe
    // aria-allowed-attr, WCAG 4.1.2). The host must stay clean.
    expect(wrapper.hasAttribute('aria-required')).toBe(false)
  })

  it('keeps aria-required on the inner bound <input> (no over-correction)', async () => {
    const { root } = mountWrapper()
    await waitUntil(() => (root.querySelector('input.inner') !== null ? true : null))
    await awaitSettle()

    const inner = root.querySelector('input.inner') as HTMLInputElement
    expect(inner.getAttribute('aria-required')).toBe('true')
  })
})
