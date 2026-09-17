import {
  getCurrentInstance,
  onBeforeMount,
  onBeforeUpdate,
  onMounted,
  shallowRef,
  type Ref,
} from 'vue'
import { __DEV__ } from '../core/dev'
import { captureUserCallSite } from '../core/dev-stack-trace'
import { armDomBinding } from '../core/dom-binding'
import { REGISTER_OWNER_MARKER, V_REGISTER_MARKER } from '../core/register-protocol'
import { ensureAttaformInstalled } from '../core/plugin'
import type { RegisterValue } from '../types/types-api'

/**
 * Return type of `useRegister()`. Hybrid of `RegisterValue<V>` (so
 * `rv.path` / `rv.segments` / `rv.formKey` etc. work directly in
 * script setup) and `Ref<RegisterValue<V> | undefined>` (so Vue's
 * template auto-unwrap surfaces the underlying RV to `v-register`
 * and the directive's path-migration diff sees the real RV across
 * renders).
 *
 * The two surfaces don't clash at the type level: `RegisterValue`
 * doesn't carry a `value` field, and `Ref<T>`'s `value: T` becomes
 * the hybrid's only `.value`. Older code that read `rv.value?.path`
 * keeps working; new code can write `rv.path` directly.
 */
export type UseRegisterReturn<V = unknown> = RegisterValue<V> &
  Ref<RegisterValue<V> | undefined> & {
    /**
     * Whether a parent has actually bound this wrapper. `false` until a
     * `RegisterValue` lands, `true` once one has, and reactive in both
     * directions: a parent that binds on a later render flips it, and
     * so does one that stops binding.
     *
     * This is the test a dual-mode wrapper reaches for, and the reason
     * it exists as a field rather than a truthiness check on the
     * return: the composable cannot answer "is this bound" at setup
     * time. A parent is free to bind on a later render
     * (`v-register="ready ? form.register('x') : undefined"`), and
     * `useRegister` has to keep serving that, so it can never return a
     * plain `undefined` for "unbound right now". Script-setup code
     * reading `rv` directly sees the hybrid Proxy, which is an object
     * and therefore always truthy; a template sees the unwrapped ref,
     * which IS `undefined` when unbound. `rv?.isBound` reads the same
     * on both sides (#620).
     */
    readonly isBound: boolean
  }

const warnedNoParentRV: WeakSet<object> | null = __DEV__ ? new WeakSet<object>() : null
let warnedOutsideSetup = false

/**
 * Build the hybrid Proxy. `__v_isRef` makes Vue's `unref` and template
 * auto-unwrap treat it as a `Ref<RegisterValue | undefined>` and read
 * `value`, which is the path `v-register="rv"` takes to reach the
 * directive's `binding.value`. Every other read pierces to
 * `capturedRegisterValue.value`, so `rv.path` works in script setup.
 *
 * Methods need no `this` rebinding: every `RegisterValue` method is an
 * arrow closure built in `core/register-api.ts` over `state` and
 * `segments`. The `has` and `ownKeys` traps keep `'innerRef' in rv`,
 * `Object.keys(rv)` and the directive's `isRegisterValue` guard
 * working.
 *
 * Every read pays the `get` trap, which is the price of returning one
 * value that is both a ref (for `v-register="rv"`) and a
 * `RegisterValue`-shaped object (for `rv.path`). Per-property getters
 * would cost the same.
 */
function makeRegisterValueProxy<V>(
  capturedRegisterValue: Ref<RegisterValue<V> | undefined>
): UseRegisterReturn<V> {
  return new Proxy({} as object, {
    get(_target, prop) {
      if (prop === '__v_isRef') return true
      if (prop === 'value') return capturedRegisterValue.value
      // Answered by the proxy rather than pierced, so it reports a real
      // boolean in the unbound state instead of the `undefined` every
      // other piercing read returns. The ref read keeps it reactive, so
      // a `computed` / template branching on it re-runs when a parent
      // binds or unbinds (#620).
      if (prop === 'isBound') return capturedRegisterValue.value !== undefined
      const v = capturedRegisterValue.value
      if (v === undefined) return undefined
      return Reflect.get(v as object, prop)
    },
    has(_target, prop) {
      if (prop === '__v_isRef' || prop === 'value' || prop === 'isBound') return true
      const v = capturedRegisterValue.value
      if (v === undefined) return false
      return Reflect.has(v as object, prop)
    },
    ownKeys(_target) {
      const v = capturedRegisterValue.value
      if (v === undefined) return []
      return Reflect.ownKeys(v as object)
    },
    getOwnPropertyDescriptor(_target, prop) {
      const v = capturedRegisterValue.value
      if (v === undefined) return undefined
      const desc = Reflect.getOwnPropertyDescriptor(v as object, prop)
      if (desc !== undefined) {
        // Proxy invariant: any property reported via ownKeys must be
        // configurable on the target OR match a non-configurable
        // descriptor on the target. Empty target has no own props,
        // so we MUST return descriptors with `configurable: true`.
        desc.configurable = true
      }
      return desc
    },
  }) as unknown as UseRegisterReturn<V>
}

/**
 * Options for `useRegister`.
 */
export type UseRegisterOptions = {
  /**
   * Declares that this wrapper is used both with and without a form, so
   * a render with no parent binding is intended rather than a mistake.
   * Silences the unbound diagnostic; nothing else changes.
   *
   * The diagnostic exists because a single-mode wrapper whose parent
   * forgot `v-register` renders a field that looks fine and stores
   * nothing, which is an expensive afternoon. Once a wrapper is
   * deliberately dual-mode, the same signal fires on correct code and
   * tells the author to do something wrong, so this is the one fact
   * that separates the two cases and only the author has it (#620).
   *
   * Pair it with `rv?.isBound` to branch on what actually happened.
   */
  readonly optional?: boolean
}

/**
 * Re-bind a parent's `v-register` onto an inner native element. Use it
 * inside a component that wraps a single form field whose root is NOT
 * the input itself, such as a labelled row that renders `<label>`
 * around the input.
 *
 * ```vue
 * <!-- Parent -->
 * <MyInput v-register="form.register('email')" />
 *
 * <!-- MyInput.vue -->
 * <script setup lang="ts">
 *   import { useRegister } from 'attaform'
 *   const rv = useRegister()
 * </script>
 *
 * <template>
 *   <label class="field">
 *     <span>Email</span>
 *     <input v-register="rv" />
 *   </label>
 * </template>
 * ```
 *
 * The return is a hybrid: `v-register="rv"` hands the directive the
 * parent's own `RegisterValue`, and `rv.path` / `rv.segments` /
 * `rv.formKey` / `rv.innerRef` read directly in script setup with no
 * `.value` unwrap. Reads inside a `computed` or `watchEffect` re-run
 * when the parent rebinds to a different path.
 *
 * When no parent bound, every field reads `undefined`, so reach for
 * `rv?.path`. `v-register="rv"` is still safe. A wrapper that is meant
 * to render both with and without a form declares it with
 * `useRegister({ optional: true })` and branches on `rv?.isBound`.
 *
 * When the wrapper's root IS the input, Vue's attribute fallthrough
 * already binds it and `useRegister` is unnecessary. For a wrapper
 * that binds several fields, use `injectForm<Form>(key?)` and call
 * `ctx.register(...)` directly.
 */
export function useRegister<V = unknown>(
  options?: UseRegisterOptions
): UseRegisterReturn<V> | undefined {
  const instance = getCurrentInstance()
  if (instance === null) {
    warnOutsideSetup()
    return makeRegisterValueProxy<V>(shallowRef<RegisterValue<V> | undefined>(undefined))
  }

  // Lazy-install the registry, because a wrapper used in isolation (no
  // `useForm` ancestor, no `createAttaform()`) should still find one
  // attached. Idempotent, and an explicit install that ran first wins.
  // The `v-register` inside the wrapper's own template is delivered
  // separately: the Vite / Nuxt plugin binds it at compile time, and a
  // no-build setup calls `installVRegister(app)` once.
  ensureAttaformInstalled(instance.appContext.app)

  // Holds the bridge `registerValue` captured out of `instance.attrs`,
  // which `refreshAndStripBridgeAttrs` below then deletes from attrs so
  // it cannot fall through to the rendered root as
  // `<label registerValue="[object Object]">`. Only the bridge keys are
  // stripped, so class / style / aria / data still fall through and the
  // consumer keeps the default `inheritAttrs`.
  //
  // `shallowRef`, never `ref`: `ref` would call `reactive()` on the RV
  // and break the referential equality the directive hooks depend on.
  const capturedRegisterValue = shallowRef<RegisterValue<V> | undefined>(undefined)

  const refreshAndStripBridgeAttrs = (): void => {
    const rawAttrs = instance.attrs as Record<string, unknown>
    // Primary path: `componentBridgeTransform` injected a
    // `:registerValue` bridge prop, which `initProps` lands in
    // `instance.attrs`. Capture only when the key is PRESENT. The strip
    // below removes it, so a second run of this function would
    // otherwise overwrite the captured rv with `undefined`.
    if ('registerValue' in rawAttrs) {
      capturedRegisterValue.value = rawAttrs['registerValue'] as RegisterValue<V> | undefined
      delete rawAttrs['registerValue']
      // The wrapper author may call `rv.registerElement(el)` through the
      // proxy instead of using an inner v-register, and that delegate
      // needs the binding already live. No-op for a hand-rolled RV.
      if (capturedRegisterValue.value !== undefined) armDomBinding(capturedRegisterValue.value)
    } else {
      // Fallback path: no compile-time transform ran, so the bridge attr
      // never appeared. Vue fills `vnode.dirs` whenever the parent's
      // render meets `v-register` on this component, plugin or no
      // plugin. Match on `V_REGISTER_MARKER` rather than on shape, so
      // an unrelated user directive cannot false-match and so two
      // copies of Attaform still recognise each other.
      const dirs = instance.vnode.dirs
      if (dirs !== null && dirs !== undefined) {
        for (const dir of dirs) {
          const marked = (dir.dir as { [k: symbol]: unknown } | null | undefined)?.[
            V_REGISTER_MARKER
          ]
          if (marked === true) {
            capturedRegisterValue.value = dir.value as RegisterValue<V> | undefined
            // Same arming as the bridge-attr path above.
            if (capturedRegisterValue.value !== undefined)
              armDomBinding(capturedRegisterValue.value)
            break
          }
        }
      }
    }
    if ('value' in rawAttrs) delete rawAttrs['value']
    // `componentBridgeTransform`'s v-model desugar puts `modelValue` and
    // `onUpdate:modelValue` on a plain component host. Here the inner
    // control already owns the value through its own v-register, so both
    // are inert: strip them or `modelValue` lands on the inner DOM as a
    // junk attribute and `onUpdate:modelValue` binds a dead listener.
    if ('modelValue' in rawAttrs) delete rawAttrs['modelValue']
    if ('onUpdate:modelValue' in rawAttrs) delete rawAttrs['onUpdate:modelValue']
  }
  // Three times, and all three earn it. The synchronous call is the SSR
  // one: `renderToString` skips lifecycle hooks, so without it the
  // capture stays `undefined` and the first server-side read
  // misrenders. `setupComponent` runs `initProps` before `setup()`, so
  // the sync read already sees the bridge key. `onBeforeMount` is
  // defence in depth against a re-population after setup, and
  // `onBeforeUpdate` catches parent re-renders, where `setFullProps`
  // puts the bridge keys back. All three are idempotent.
  refreshAndStripBridgeAttrs()
  onBeforeMount(refreshAndStripBridgeAttrs)
  onBeforeUpdate(refreshAndStripBridgeAttrs)

  // Two jobs in one hook. It marks the rendered root with
  // `REGISTER_OWNER_MARKER`, which is how the parent directive's
  // deferred check knows to skip its "is a no-op" warn for a component
  // that binds through an inner v-register. And it emits the
  // no-parent-RV diagnostic once per instance, at mount because by then
  // the parent has had a full lifecycle to bind, so a still-undefined
  // capture is conclusive. Keeping it here also keeps the proxy pure:
  // reading a field never warns. SSR is silent by construction, since
  // `onMounted` does not run there, and the CSR hydration pass raises
  // the same diagnostic on the surface a developer can act on.
  onMounted(() => {
    const el = instance.vnode.el
    if (el !== null && el !== undefined && typeof el === 'object') {
      ;(el as unknown as { [k: symbol]: unknown })[REGISTER_OWNER_MARKER] = true
    }
    if (capturedRegisterValue.value === undefined && options?.optional !== true) {
      warnNoParentRV(instance as unknown as object)
    }
  })

  return makeRegisterValueProxy(capturedRegisterValue)
}

function warnOutsideSetup(): void {
  if (!__DEV__) return
  if (warnedOutsideSetup) return
  warnedOutsideSetup = true
  const frame = captureUserCallSite()
  console.warn(
    `[attaform] useRegister() called outside a component setup; returning an unbound RegisterValue proxy. ` +
      `Fix: call it inside <script setup> or a setup() function — not from an event handler ` +
      `or async callback.` +
      (frame !== undefined ? ` ${frame}` : '')
  )
}

function warnNoParentRV(instance: object): void {
  if (!__DEV__ || warnedNoParentRV === null) return
  if (warnedNoParentRV.has(instance)) return
  warnedNoParentRV.add(instance)
  const frame = captureUserCallSite()
  console.warn(
    `[attaform] useRegister: no parent registerValue prop; RegisterValue fields will read as undefined. ` +
      `Pass v-register on the parent: \`<YourComponent v-register="form.register('field')" />\`. ` +
      `If this component is meant to work without a form too, say so with ` +
      `\`useRegister({ optional: true })\` and branch on \`rv?.isBound\`.` +
      (frame !== undefined ? ` ${frame}` : '')
  )
}
