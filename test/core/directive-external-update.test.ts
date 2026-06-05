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
 * the `<input>` stays stale — the multi-tab demo's exact failure, where a
 * patch received from another tab landed in the store yet never repainted
 * the input.
 *
 * These exercise the directive hooks directly (no Vue render cycle) so the
 * only thing under test is the reactive DOM sync. The mock RegisterValue
 * mirrors the one in directive-prop-reactivity.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, ref, type Ref } from 'vue'
import type { DirectiveBinding } from 'vue'
import { vRegister } from '../../src/runtime/core/directive'
import { createPersistOptInRegistry } from '../../src/runtime/core/persistence/opt-in-registry'
import type { PathKey } from '../../src/runtime/core/paths'
import type { InternalRegisterValue, RegisterValue } from '../../src/runtime/types/types-api'

type MutableMockRv<T> = {
  -readonly [K in keyof InternalRegisterValue<T>]: InternalRegisterValue<T>[K]
}

function makeRegisterValue<T>(initial: T): MutableMockRv<T> {
  const innerRef = ref(initial)
  return {
    innerRef: innerRef as InternalRegisterValue<T>['innerRef'],
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
    markConnectedOptimistically: () => undefined,
    path: 'mock' as PathKey,
    segments: Object.freeze(['mock']),
    formKey: 'mock-form',
    formInstanceId: 'mock-inst',
    persist: false,
    acknowledgeSensitive: false,
    persistOptIns: createPersistOptInRegistry(),
    isSensitivePath: () => false,
    multiTab: true,
    acceptsUndefined: false,
    acceptsString: true,
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
})
