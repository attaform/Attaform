/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirectiveBinding } from 'vue'
import { computed, ref, type Ref } from 'vue'
import { vRegister } from '../../src/runtime/core/directive'
import { createPersistOptInRegistry } from '../../src/runtime/core/persistence/opt-in-registry'
import type { PathKey } from '../../src/runtime/core/paths'
import type {
  CustomDirectiveRegisterAssignerFn,
  InternalRegisterValue,
  RegisterValue,
} from '../../src/runtime/types/types-api'

/**
 * Three stale-closure sites that diverge between `created` capture and
 * fire-time read. Each pre-fix listener reads a value frozen at the
 * directive's `created` hook, even though Vue patches the DOM (or the
 * vnode props) on every render — so a consumer's dynamic `:type`,
 * dynamic `@update:registerValue`, or path-level container-type swap
 * sails past the listener invisibly.
 *
 *   A. `setAssignFunction` early-return — once an `onUpdate:registerValue`
 *      handler is installed, subsequent renders never re-read the prop.
 *   B. `vRegisterText` `castToNumber` — captured from `vnode.props.type`
 *      at `created`-time; `:type="..."` swaps are invisible.
 *   C. `vRegisterSelect` `isSetModel` — captured from
 *      `value.innerRef.value` at `created`-time; an Array ↔ Set swap on
 *      the path routes writes to the stale container shape.
 *
 * All three exercise the directive's hooks directly so the assertions
 * pin behavior at the listener body — no Vue render cycle, no schema
 * gate, no slim-primitive interference.
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
    markConnectedOptimistically: () => undefined,
    beginTransform: () => 0,
    isCurrentTransform: () => false,
    endTransform: () => undefined,
    setTransformError: () => undefined,
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

// ─────────────────────────────────────────────────────────────────
// A — `setAssignFunction` re-derives on every render
// ─────────────────────────────────────────────────────────────────

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

    // Parent re-renders with handler B in the vnode prop. The
    // directive's beforeUpdate must re-derive — pre-fix, the early
    // return in `setAssignFunction` bailed once any non-default
    // assigner was installed, so the handler swap was silently dropped.
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

// ─────────────────────────────────────────────────────────────────
// B — `vRegisterText` derives `castToNumber` per fire
// ─────────────────────────────────────────────────────────────────

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

    // Vue patches the DOM attribute when `:type="..."` swaps; mirror
    // that here. Pre-fix the listener stayed on the created-time
    // `castToNumber === false` decision and continued writing strings.
    input.type = 'number'

    input.value = '100'
    input.dispatchEvent(new Event('input'))
    expect(setValue).toHaveBeenLastCalledWith(100)
  })
})

// ─────────────────────────────────────────────────────────────────
// C — `vRegisterSelect` derives `isSetModel` per fire
// ─────────────────────────────────────────────────────────────────

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

    // The path's container type swaps — production trigger would be
    // a `form.setValue('picks', new Set([...]))` against a union
    // schema. Pre-fix the listener kept the created-time
    // `isSetModel === false` and wrote an Array on every subsequent
    // change.
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
