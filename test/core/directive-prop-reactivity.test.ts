/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirectiveBinding } from 'vue'
import { computed, ref, type Ref } from 'vue'
import { vRegister } from '../../src/runtime/core/directive'
import type { PathKey } from '../../src/runtime/core/paths'
import type {
  CustomDirectiveRegisterAssignerFn,
  InternalRegisterValue,
  RegisterValue,
} from '../../src/runtime/types/types-api'

/**
 * Three sites where a listener must re-read at fire time rather than
 * close over its `created`-hook capture. Vue patches the DOM and the
 * vnode props on every render, so a value frozen at `created` lets a
 * consumer's dynamic `:type`, dynamic `@update:registerValue` or
 * path-level container-type swap sail past invisibly.
 *
 *   A. `setAssignFunction`: an early return once an
 *      `onUpdate:registerValue` handler is installed would stop later
 *      renders re-reading the prop.
 *   B. `vRegisterText`'s `castToNumber`, read from `vnode.props.type`.
 *   C. `vRegisterSelect`'s `isSetModel`, read from
 *      `value.innerRef.value`; an Array-to-Set swap on the path would
 *      otherwise route writes to the stale container shape.
 *
 * All three drive the directive's hooks directly, so the assertions pin
 * behaviour at the listener body: no render cycle, no schema gate, no
 * slim-primitive interference.
 */

type Spy = ReturnType<typeof vi.fn>

type MutableMockRv<T> = {
  -readonly [K in keyof InternalRegisterValue<T>]: InternalRegisterValue<T>[K]
}

function makeRegisterValue<T>(initial: T): {
  value: MutableMockRv<T>
  setValue: Spy
} {
  const innerRef = ref(initial)
  const setValue = vi.fn((v: unknown) => {
    innerRef.value = v as T
    return true
  })
  const value: MutableMockRv<T> = {
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
    setValueWithInternalPath: setValue,
    setValueFromHost: setValue,
    markConnectedOptimistically: () => undefined,
    markHostConnected: () => undefined,
    markFocused: () => undefined,
    hasRegisteredDescendant: () => false,
    beginTransform: () => 0,
    isCurrentTransform: () => false,
    endTransform: () => undefined,
    setTransformError: () => undefined,
    transforming: false,
    path: 'mock' as PathKey,
    segments: Object.freeze(['mock']),
    formKey: 'mock-form',
    formInstanceId: 'mock-inst',
    acceptsUndefined: false,
    acceptsString: true,
  }
  return { value, setValue }
}

function makeBinding<T>(
  rv: RegisterValue<T> | undefined,
  modifiers: Record<string, true> = {}
): DirectiveBinding {
  return {
    value: rv,
    oldValue: null,
    modifiers,
    arg: undefined,
    dir: {},
    instance: null,
  } as unknown as DirectiveBinding
}

type FakeVNode = { props: Record<string, unknown> }
function makeVNode(props: Record<string, unknown> = {}): FakeVNode {
  return { props }
}

type DirectiveHook = (
  el: Element,
  binding: DirectiveBinding,
  vnode: FakeVNode,
  prevNode: null
) => void

const hooks = vRegister as unknown as {
  created?: DirectiveHook
  mounted?: DirectiveHook
  beforeUpdate?: DirectiveHook
  updated?: DirectiveHook
  beforeUnmount?: DirectiveHook
}

// A, `setAssignFunction` re-derives on every render

describe('setAssignFunction — @update:registerValue prop reactivity', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('a fresh handler in onUpdate:registerValue fires on the next input event', () => {
    const input = document.createElement('input')
    input.type = 'text'
    document.body.appendChild(input)
    const { value } = makeRegisterValue('')

    const handlerA = vi.fn<CustomDirectiveRegisterAssignerFn>((_v, _rv) => undefined)
    const handlerB = vi.fn<CustomDirectiveRegisterAssignerFn>((_v, _rv) => undefined)

    // Created with handler A in the vnode prop.
    hooks.created?.(
      input,
      makeBinding(value, {}),
      makeVNode({ 'onUpdate:registerValue': handlerA }),
      null
    )

    input.value = 'first'
    input.dispatchEvent(new Event('input'))
    expect(handlerA).toHaveBeenCalledTimes(1)
    expect(handlerB).toHaveBeenCalledTimes(0)

    // The parent re-renders with handler B in the vnode prop, and
    // `beforeUpdate` re-derives. An early return in `setAssignFunction`
    // once any non-default assigner is installed would drop the swap
    // silently.
    hooks.beforeUpdate?.(
      input,
      makeBinding(value, {}),
      makeVNode({ 'onUpdate:registerValue': handlerB }),
      null
    )

    input.value = 'second'
    input.dispatchEvent(new Event('input'))
    expect(handlerA).toHaveBeenCalledTimes(1)
    expect(handlerB).toHaveBeenCalledTimes(1)
  })
})

// B, `vRegisterText` derives `castToNumber` per fire

describe('vRegisterText — :type swap reactivity', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('mutating el.type from text to number activates .number-style casting on the next input', () => {
    const input = document.createElement('input')
    input.type = 'text'
    document.body.appendChild(input)
    const { value, setValue } = makeRegisterValue<unknown>('')

    hooks.created?.(input, makeBinding(value, {}), makeVNode({ type: 'text' }), null)

    // Pre-swap: the listener writes the raw string.
    input.value = '42'
    input.dispatchEvent(new Event('input'))
    expect(setValue).toHaveBeenLastCalledWith('42')

    // Vue patches the DOM attribute when `:type="..."` swaps, mirrored
    // here. A listener holding its created-time `castToNumber === false`
    // would keep writing strings.
    input.type = 'number'

    input.value = '100'
    input.dispatchEvent(new Event('input'))
    expect(setValue).toHaveBeenLastCalledWith(100)
  })
})

// C, `vRegisterSelect` derives `isSetModel` per fire

describe('vRegisterSelect — Array ↔ Set model swap reactivity', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  function makeSelect(options: string[]): HTMLSelectElement {
    const select = document.createElement('select')
    select.multiple = true
    for (const v of options) {
      const opt = document.createElement('option')
      opt.value = v
      opt.text = v
      select.appendChild(opt)
    }
    return select
  }

  it('swapping innerRef.value from Array to Set routes the next change write to a Set', () => {
    const select = makeSelect(['a', 'b', 'c'])
    document.body.appendChild(select)
    const { value, setValue } = makeRegisterValue<string[] | Set<string>>([])

    hooks.created?.(select, makeBinding(value, {}), makeVNode({}), null)

    // Pre-swap: Array model, change writes an Array.
    const opt0 = select.options[0]
    if (opt0 === undefined) throw new Error('unreachable')
    opt0.selected = true
    select.dispatchEvent(new Event('change'))
    const arrayWrite = setValue.mock.calls[0]?.[0]
    expect(Array.isArray(arrayWrite)).toBe(true)
    expect(arrayWrite).toEqual(['a'])

    // The path's container type swaps, as a
    // `form.setValue('picks', new Set([...]))` against a union schema
    // would do in production. A listener holding its created-time
    // `isSetModel === false` writes an Array on every later change.
    ;(value.innerRef as { value: string[] | Set<string> }).value = new Set(['a'])

    opt0.selected = true
    const opt1 = select.options[1]
    if (opt1 === undefined) throw new Error('unreachable')
    opt1.selected = true
    select.dispatchEvent(new Event('change'))
    const setWrite = setValue.mock.calls[1]?.[0]
    expect(setWrite).toBeInstanceOf(Set)
    expect([...(setWrite as Set<string>)].sort()).toEqual(['a', 'b'])
  })
})
