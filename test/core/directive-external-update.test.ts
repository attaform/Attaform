/**
 * @vitest-environment jsdom
 *
 * Regression: a `v-register` text input must reflect form changes that
 * originate OUTSIDE the host component — cross-tab sync
 * (`applyFormReplacement`), a sibling component's `setValue` / `reset` /
 * `clear`, or any imperative store write while the bound component's
 * template reads no field state (a display-only form never re-renders).
 *
 * The directive's `beforeUpdate` hook only re-syncs `el.value` on a host
 * re-render. The value-sync watch (`setupValueSync`, run from `mounted`)
 * is what catches the no-re-render case. Without it the store updates but
 * the `<input>` stays stale: an imperative store write (a sibling
 * component's `setValue`) lands in the store yet never repaints an input
 * bound in a display-only component that triggers no re-render.
 *
 * These exercise the directive hooks directly (no Vue render cycle) so the
 * only thing under test is the reactive DOM sync. The mock RegisterValue
 * mirrors the one in directive-prop-reactivity.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, ref, type Ref } from 'vue'
import type { DirectiveBinding } from 'vue'
import { vRegister } from '../../src/runtime/core/directive'
import type { PathKey } from '../../src/runtime/core/paths'
import type { InternalRegisterValue, RegisterValue } from '../../src/runtime/types/types-api'

type MutableMockRv<T> = {
  -readonly [K in keyof InternalRegisterValue<T>]: InternalRegisterValue<T>[K]
}

function makeRegisterValue<T>(initial: T): MutableMockRv<T> {
  const innerRef = ref(initial)
  return {
    innerRef: innerRef as InternalRegisterValue<T>['innerRef'],
    hostModelValue: innerRef as InternalRegisterValue<T>['hostModelValue'],
    disabled: ref(false) as InternalRegisterValue<T>['disabled'],
    displayValue: computed(() => {
      const v = innerRef.value
      return v == null ? '' : String(v)
    }) as Readonly<Ref<string>>,
    markBlank: () => true,
    markInteracted: () => undefined,
    lastTypedForm: ref<string | null>(null),
    registerElement: vi.fn(),
    deregisterElement: vi.fn(),
    setValueWithInternalPath: vi.fn(() => true),
    setValueFromHost: vi.fn(() => true),
    markConnectedOptimistically: () => undefined,
    markHostConnected: () => undefined,
    markFocused: () => undefined,
    hasRegisteredDescendant: () => false,
    path: 'mock' as PathKey,
    segments: Object.freeze(['mock']),
    formKey: 'mock-form',
    formInstanceId: 'mock-inst',
    acceptsUndefined: false,
    acceptsString: true,
    beginTransform: () => 0,
    isCurrentTransform: () => false,
    endTransform: () => undefined,
    setTransformError: () => undefined,
    transforming: false,
  }
}

function makeBinding<T>(rv: RegisterValue<T>): DirectiveBinding {
  return {
    value: rv,
    oldValue: null,
    modifiers: {},
    arg: undefined,
    dir: {},
    instance: null,
  } as unknown as DirectiveBinding
}

type FakeVNode = { props: Record<string, unknown> }
type DirectiveHook = (el: Element, binding: DirectiveBinding, vnode: FakeVNode, prev: null) => void
const hooks = vRegister as unknown as {
  created?: DirectiveHook
  mounted?: DirectiveHook
  beforeUnmount?: DirectiveHook
}

// Set the store-side value the way an external writer would — straight
// onto `innerRef`, with no directive hook and no component render.
function writeExternally<T>(rv: MutableMockRv<T>, next: T): void {
  ;(rv.innerRef as { value: T }).value = next
}

async function mountInput(
  initial: string
): Promise<{ input: HTMLInputElement; rv: MutableMockRv<unknown> }> {
  const input = document.createElement('input')
  input.type = 'text'
  document.body.appendChild(input)
  const rv = makeRegisterValue<unknown>(initial)
  const vnode: FakeVNode = { props: { type: 'text' } }
  hooks.created?.(input, makeBinding(rv), vnode, null)
  hooks.mounted?.(input, makeBinding(rv), vnode, null)
  await nextTick()
  return { input, rv }
}

async function mountTextarea(
  initial: string
): Promise<{ el: HTMLTextAreaElement; rv: MutableMockRv<unknown> }> {
  const el = document.createElement('textarea')
  document.body.appendChild(el)
  const rv = makeRegisterValue<unknown>(initial)
  const vnode: FakeVNode = { props: {} }
  hooks.created?.(el, makeBinding(rv), vnode, null)
  hooks.mounted?.(el, makeBinding(rv), vnode, null)
  await nextTick()
  return { el, rv }
}

async function mountCheckbox(
  initial: unknown
): Promise<{ el: HTMLInputElement; rv: MutableMockRv<unknown> }> {
  const el = document.createElement('input')
  el.type = 'checkbox'
  document.body.appendChild(el)
  const rv = makeRegisterValue<unknown>(initial)
  const vnode: FakeVNode = { props: { type: 'checkbox' } }
  hooks.created?.(el, makeBinding(rv), vnode, null)
  hooks.mounted?.(el, makeBinding(rv), vnode, null)
  await nextTick()
  return { el, rv }
}

async function mountRadio(
  optionValue: string,
  initial: unknown
): Promise<{ el: HTMLInputElement; rv: MutableMockRv<unknown> }> {
  const el = document.createElement('input')
  el.type = 'radio'
  el.value = optionValue
  document.body.appendChild(el)
  const rv = makeRegisterValue<unknown>(initial)
  const vnode: FakeVNode = { props: { type: 'radio' } }
  hooks.created?.(el, makeBinding(rv), vnode, null)
  hooks.mounted?.(el, makeBinding(rv), vnode, null)
  await nextTick()
  return { el, rv }
}

function makeSelect(options: string[], multiple: boolean): HTMLSelectElement {
  const select = document.createElement('select')
  if (multiple) select.multiple = true
  for (const v of options) {
    const opt = document.createElement('option')
    opt.value = v
    opt.text = v
    select.appendChild(opt)
  }
  return select
}

async function mountSelect(
  options: string[],
  initial: unknown,
  multiple = false
): Promise<{ select: HTMLSelectElement; rv: MutableMockRv<unknown> }> {
  const select = makeSelect(options, multiple)
  document.body.appendChild(select)
  const rv = makeRegisterValue<unknown>(initial)
  const vnode: FakeVNode = { props: {} }
  hooks.created?.(select, makeBinding(rv), vnode, null)
  hooks.mounted?.(select, makeBinding(rv), vnode, null)
  await nextTick()
  return { select, rv }
}

function selectedValues(select: HTMLSelectElement): string[] {
  return Array.prototype.filter
    .call(select.options, (o: HTMLOptionElement) => o.selected)
    .map((o: HTMLOptionElement) => o.value)
}

describe('v-register — external store updates reach the DOM without a re-render', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('repaints the input when the value changes outside the component', async () => {
    const { input, rv } = await mountInput('')
    expect(input.value).toBe('')

    writeExternally(rv, 'from-another-tab')
    await nextTick()

    expect(input.value).toBe('from-another-tab')
  })

  it('leaves the input alone while it is focused (caret safety)', async () => {
    const { input, rv } = await mountInput('')
    input.focus()
    expect(document.activeElement).toBe(input)

    writeExternally(rv, 'remote-edit')
    await nextTick()

    // The keystroke path + beforeUpdate own the focused case; the watch
    // must not yank the user's caret mid-edit.
    expect(input.value).toBe('')
  })

  it('stops mirroring after beforeUnmount', async () => {
    const { input, rv } = await mountInput('')
    hooks.beforeUnmount?.(input, makeBinding(rv), { props: { type: 'text' } }, null)

    writeExternally(rv, 'after-unmount')
    await nextTick()

    expect(input.value).toBe('')
  })

  it('repaints a textarea on an external change', async () => {
    const { el, rv } = await mountTextarea('')
    expect(el.value).toBe('')

    writeExternally(rv, 'multi\nline')
    await nextTick()

    expect(el.value).toBe('multi\nline')
  })
})

describe('v-register checkbox — external updates without a re-render', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('reflects an external boolean change', async () => {
    const { el, rv } = await mountCheckbox(false)
    expect(el.checked).toBe(false)

    writeExternally(rv, true)
    await nextTick()

    expect(el.checked).toBe(true)
  })

  it('reflects even while focused (checkboxes are not focus-gated, unlike text)', async () => {
    const { el, rv } = await mountCheckbox(false)
    el.focus()
    expect(document.activeElement).toBe(el)

    writeExternally(rv, true)
    await nextTick()

    expect(el.checked).toBe(true)
  })

  it('stops mirroring after beforeUnmount', async () => {
    const { el, rv } = await mountCheckbox(false)
    hooks.beforeUnmount?.(el, makeBinding(rv), { props: { type: 'checkbox' } }, null)

    writeExternally(rv, true)
    await nextTick()

    expect(el.checked).toBe(false)
  })
})

describe('v-register radio — external updates without a re-render', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('checks and unchecks as the external model moves on / off its value', async () => {
    const { el, rv } = await mountRadio('a', '')
    expect(el.checked).toBe(false)

    writeExternally(rv, 'a')
    await nextTick()
    expect(el.checked).toBe(true)

    writeExternally(rv, 'b')
    await nextTick()
    expect(el.checked).toBe(false)
  })

  it('stops mirroring after beforeUnmount', async () => {
    const { el, rv } = await mountRadio('a', '')
    hooks.beforeUnmount?.(el, makeBinding(rv), { props: { type: 'radio' } }, null)

    writeExternally(rv, 'a')
    await nextTick()

    expect(el.checked).toBe(false)
  })
})

describe('v-register select — external updates without a re-render', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('reflects an external change on a single select', async () => {
    const { select, rv } = await mountSelect(['a', 'b', 'c'], 'a')
    expect(select.value).toBe('a')

    writeExternally(rv, 'b')
    await nextTick()

    expect(select.value).toBe('b')
  })

  it('reflects an external change on a multi-select', async () => {
    const { select, rv } = await mountSelect(['a', 'b', 'c'], ['a'], true)
    expect(selectedValues(select)).toEqual(['a'])

    writeExternally(rv, ['a', 'c'])
    await nextTick()

    expect(selectedValues(select).sort()).toEqual(['a', 'c'])
  })

  it('stops mirroring after beforeUnmount', async () => {
    const { select, rv } = await mountSelect(['a', 'b', 'c'], 'a')
    hooks.beforeUnmount?.(select, makeBinding(rv), { props: {} }, null)

    writeExternally(rv, 'b')
    await nextTick()

    expect(select.value).toBe('a')
  })
})
