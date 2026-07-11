import { baseCompile } from '@vue/compiler-core'
import { describe, expect, it } from 'vitest'
import { inputTextAreaNodeTransform } from '../../src/runtime/lib/core/transforms/input-text-area-transform'
import { componentBridgeTransform } from '../../src/runtime/lib/core/transforms/component-bridge-transform'
import { vRegisterHintTransform } from '../../src/runtime/lib/core/transforms/v-register-hint-transform'
import { vRegisterPreambleTransform } from '../../src/runtime/lib/core/transforms/v-register-preamble-transform'

/**
 * Compile-time behaviour of `v-register` on a Vue component vs. a native
 * element. PascalCase / kebab-case tags compile to
 * `tagType === ElementTypes.COMPONENT`; each transform decides
 * independently whether to fire on components.
 *
 * This test file is deliberately provocative: each `describe` pins the
 * actual contract at HEAD, including the surprises. The header comments
 * call out which behaviour is intentional vs. a footgun a future
 * refactor might want to address.
 *
 * Production pipeline order (`src/vite.ts`):
 *   1. componentBridgeTransform
 *   2. inputTextAreaNodeTransform
 *   3. vRegisterPreambleTransform
 *   4. vRegisterHintTransform
 */

type CompilerOptions = NonNullable<Parameters<typeof baseCompile>[1]>
type NodeTransformList = NonNullable<CompilerOptions['nodeTransforms']>

function compileFull(template: string): string {
  return baseCompile(template, {
    nodeTransforms: [
      componentBridgeTransform,
      inputTextAreaNodeTransform,
      vRegisterPreambleTransform,
      vRegisterHintTransform,
    ] as NodeTransformList,
    mode: 'module',
  }).code
}

function compileWith(template: string, transforms: NodeTransformList): string {
  return baseCompile(template, { nodeTransforms: transforms, mode: 'module' }).code
}

describe('v-register on Vue components — AST behaviour', () => {
  describe('vRegisterHintTransform — wraps component bindings (works ✓)', () => {
    it('wraps <MyInput v-register="form.register(\'email\')">', () => {
      const code = compileWith(`<MyInput v-register="form.register('email')" />`, [
        vRegisterHintTransform,
      ])
      // Same wrapper as native input — the transform doesn't filter by tag.
      expect(code).toContain('markConnectedOptimistically')
      expect(code).toMatch(/_ctx\.form\.register\(['"]email['"]\)/)
    })

    it('wraps a hoisted RegisterValue identifier on a component', () => {
      const code = compileWith(`<MyInput v-register="emailReg" />`, [vRegisterHintTransform])
      expect(code).toContain('markConnectedOptimistically')
      expect(code).toContain('emailReg')
    })

    it('wraps PascalCase AND kebab-case component tags identically', () => {
      const pascal = compileWith(`<MyInput v-register="x" />`, [vRegisterHintTransform])
      const kebab = compileWith(`<my-input v-register="x" />`, [vRegisterHintTransform])
      expect(pascal).toContain('markConnectedOptimistically')
      expect(kebab).toContain('markConnectedOptimistically')
    })
  })

  describe('vRegisterPreambleTransform — captures component bindings (works ✓)', () => {
    it('hoists a component binding into :data-atta-pre-mark on the first root element', () => {
      const code = compileWith(
        `<div>
           <pre>{{ form.fields.email }}</pre>
           <MyInput v-register="form.register('email')" />
         </div>`,
        [vRegisterPreambleTransform, vRegisterHintTransform]
      )
      expect(code).toContain('data-atta-pre-mark')
      // The hoisted expression is the original (un-wrapped) call;
      // identifier prefixing turns `form` into `_ctx.form`.
      expect(code).toMatch(/_ctx\.form\.register\(['"]email['"]\)/)
    })

    it('hoists the binding even when the component IS the first root element', () => {
      // Vue evaluates the component's own props before recursing into
      // its slots, so the optimistic mark fires before any descendant
      // template expression reads the field state.
      const code = compileWith(`<MyInput v-register="form.register('email')" />`, [
        vRegisterPreambleTransform,
        vRegisterHintTransform,
      ])
      expect(code).toContain('data-atta-pre-mark')
    })

    it('does NOT hoist a component binding inside v-for (loop-local path)', () => {
      const code = compileWith(
        `<div>
           <MyInput v-for="i in 10" v-register="form.register('item.' + i)" :key="i" />
         </div>`,
        [vRegisterPreambleTransform, vRegisterHintTransform]
      )
      // The path expression references `i`, which isn't in scope at
      // root level. Hoisting it would crash on render.
      expect(code).not.toContain('data-atta-pre-mark')
    })
  })

  describe('inputTextAreaNodeTransform — early-returns on components (works ✓)', () => {
    it('emits no synthetic :value binding when only this transform runs', () => {
      // The transform's tag check is `node.tag === 'input' || 'textarea'`
      // — component tags are NEITHER. Result: this transform contributes
      // nothing for a component. (componentBridgeTransform DOES fire on
      // components — see the next describe block.)
      const code = compileWith(`<MyInput v-register="form.register('email')" />`, [
        inputTextAreaNodeTransform,
      ])
      expect(code).not.toContain('innerRef')
    })

    it('still injects on a sibling <input v-register> when only this transform runs', () => {
      const code = compileWith(
        `<div>
           <MyInput v-register="form.register('email')" />
           <input v-register="form.register('name')" />
         </div>`,
        [inputTextAreaNodeTransform]
      )
      expect(code).toContain('innerRef')
    })
  })

  describe('componentBridgeTransform — fires on EVERY component with v-register (value channel: v-model for plain hosts, :value for select-like)', () => {
    it('injects the v-model pair (modelValue/hostModelValue + onUpdate:modelValue/setValueFromHost) + registerValue on a plain component host', () => {
      // The transform's branch `node.tagType === ElementTypes.COMPONENT`
      // makes ANY component with v-register a transform target — even
      // ones whose name has nothing to do with selecting (`<MyInput>`,
      // `<MyTextField>`, `<MyDatePicker>`). A plain input host (no projected
      // <option>s) speaks the standard Vue v-model contract: the transform
      // injects `modelValue` (reading hostModelValue — the typed model value,
      // undefined for a blank path) and `onUpdate:modelValue` (routing through
      // setValueFromHost, which writes the value and marks interacted), plus
      // the `registerValue` bridge a wrapper's useRegister reads. It does NOT
      // inject the select-style `:value`/displayValue bind — that's reserved
      // for select-like hosts (see the slotted-<option> test below).
      const code = compileWith(`<MyInput v-register="form.register('email')" />`, [
        componentBridgeTransform,
      ])
      expect(code).toContain('hostModelValue')
      expect(code).toContain('setValueFromHost')
      expect(code).toMatch(/modelValue:\s*\(.*\)\?\.hostModelValue\?\.value/)
      expect(code).toContain('"onUpdate:modelValue":')
      expect(code).toContain('registerValue:')
      // A plain host gets v-model, never the select-style displayValue bind.
      expect(code).not.toContain('displayValue')
    })

    it('recurses into slot children — option-tagged slot content gets :selected (#394)', () => {
      // #394: a `v-register` on a component wrapper projects its <option>s as
      // parent-authored slot content, which is still present in the host's
      // node.children at transform time. Those options now receive the same
      // `:selected` binding a native <select v-register>'s inline options do,
      // so wrapping a <select> in a styled component keeps the SSR-selected
      // option instead of dropping it (and flashing the first option until
      // hydration). The host still receives the value + registerValue pair.
      const code = compileWith(
        `<MyCustomSelect v-register="form.register('role')">
           <option value="admin">Admin</option>
           <option value="user">User</option>
         </MyCustomSelect>`,
        [componentBridgeTransform]
      )
      // The component itself gets the value + registerValue prop pair.
      expect(code).toContain('displayValue')
      expect(code).toContain('registerValue:')
      // And the slot-content options are now marked, same as the native
      // path. Vue codegen also uses the keyword "selected" in patch-flag
      // comments, so we search for the BINDING form `selected:` to be precise.
      expect(code).toContain('innerRef')
      expect(code).toMatch(/selected:\s*\(/)
    })

    it('still injects :selected on direct <option> children of a native <select v-register>', () => {
      // Regression guard: the select-native path is unchanged.
      const code = compileWith(
        `<select v-register="form.register('role')">
           <option value="admin">Admin</option>
         </select>`,
        [componentBridgeTransform]
      )
      expect(code).toContain('innerRef')
      expect(code).toMatch(/selected:\s*\(/)
    })

    it('does NOT fire on a component without v-register', () => {
      // Bound by the early-out `registerIndex < 0`.
      const code = compileWith(`<MyInput :value="x" />`, [componentBridgeTransform])
      expect(code).not.toContain('innerRef')
      expect(code).not.toContain('registerValue:')
    })

    it('PascalCase + self-closing PascalCase hit the component branch', () => {
      const pascal = compileWith(`<MyInput v-register="reg" />`, [componentBridgeTransform])
      const explicitClose = compileWith(`<MyInput v-register="reg"></MyInput>`, [
        componentBridgeTransform,
      ])
      for (const code of [pascal, explicitClose]) {
        expect(code).toContain('hostModelValue')
        expect(code).toContain('"onUpdate:modelValue":')
        expect(code).toContain('registerValue:')
      }
    })

    it('kebab-case `<my-input v-register>` DOES hit the component branch (custom-element extension)', () => {
      // The transform's component branch fires on
      //   (a) PascalCase / Component-typed tags, AND
      //   (b) kebab-case ELEMENT-typed tags that aren't recognised
      //       native form elements (NATIVE_FORM_TAGS).
      // The runtime resolves `<my-input>` against `app.component`
      // registrations OR the user's `compilerOptions.isCustomElement`
      // predicate; either way the v-model pair + `:registerValue` props
      // injected here are the bridge `useRegister()` reads. Web
      // Components without a Vue component definition see them as DOM
      // attributes — the documented assignKey escape hatch covers
      // that case.
      const code = compileWith(`<my-input v-register="reg" />`, [componentBridgeTransform])
      expect(code).toContain('hostModelValue')
      expect(code).toContain('"onUpdate:modelValue":')
      expect(code).toContain('registerValue:')
      expect(code).toContain('_directive_register')
    })

    it('`<form v-register>` does NOT hit the component branch (NATIVE_FORM_TAGS guard)', () => {
      // Native form-shell tags (form, fieldset, label, button, etc.)
      // are excluded from the kebab-case extension via the
      // NATIVE_FORM_TAGS allow-list. They have no hyphen anyway, so
      // the new gate's `hasHyphen` check would already short-circuit;
      // the explicit guard documents the conservative stance and
      // catches a hypothetical `<form-something v-register>` future
      // mistake.
      const code = compileWith(`<form v-register="reg" />`, [componentBridgeTransform])
      expect(code).not.toContain('displayValue')
      expect(code).not.toContain('registerValue:')
    })
  })

  describe('full pipeline — interaction across transforms', () => {
    it('compiles a component-bound v-register without throwing', () => {
      // Smoke test: the canonical pipeline order doesn't blow up on a
      // component-only template.
      expect(() =>
        compileFull(
          `<div>
             <pre>{{ form.fields.email }}</pre>
             <MyInput v-register="form.register('email')" />
           </div>`
        )
      ).not.toThrow()
    })

    it('combines component-bridge-transform component-prop injection + hint wrapper + preamble hoist', () => {
      const code = compileFull(
        `<div>
           <pre>{{ form.fields.email }}</pre>
           <MyInput v-register="form.register('email')" />
         </div>`
      )
      // componentBridgeTransform contributed the v-model pair + registerValue:
      expect(code).toContain('hostModelValue')
      expect(code).toContain('setValueFromHost')
      expect(code).toContain('registerValue:')
      // vRegisterHintTransform wrapped the directive expression.
      expect(code).toContain('markConnectedOptimistically')
      // vRegisterPreambleTransform hoisted into data-atta-pre-mark.
      expect(code).toContain('data-atta-pre-mark')
    })

    it('mixed template (component + native input): both branches contribute', () => {
      const code = compileFull(
        `<div>
           <MyInput v-register="form.register('email')" />
           <input v-register="form.register('name')" />
         </div>`
      )
      // The component host takes the v-model path: modelValue reads
      // hostModelValue and onUpdate:modelValue routes through setValueFromHost.
      // The native <input> takes inputTextAreaNodeTransform's path, which
      // still references innerRef (the value bind reads displayValue, and the
      // change-listener force-sync reads innerRef). So innerRef now shows only
      // on the native side, hostModelValue only on the component side.
      const innerRefHits = code.match(/innerRef/g)?.length ?? 0
      expect(innerRefHits).toBeGreaterThanOrEqual(1)
      expect(code).toContain('hostModelValue')
      const displayHits = code.match(/displayValue/g)?.length ?? 0
      expect(displayHits).toBeGreaterThanOrEqual(1)
      // The component's v-model update handler is unique to its branch.
      expect(code).toContain('setValueFromHost')
      // Both bindings hoist into the preamble.
      expect(code).toMatch(/_ctx\.form\.register\(['"]email['"]\)/)
      expect(code).toMatch(/_ctx\.form\.register\(['"]name['"]\)/)
      // Component gets a registerValue prop; native input does NOT
      // (only one `registerValue:` occurrence — the component's).
      const regValueHits = code.match(/registerValue:/g)?.length ?? 0
      expect(regValueHits).toBe(1)
    })

    it('dynamic-path register call on a component (template-literal) compiles cleanly', () => {
      // The path expression references a setup-scoped `prefix`. The
      // transform doesn't introspect the expression — it forwards as-is.
      const code = compileFull('<MyInput v-register="form.register(`${prefix}.email`)" />')
      expect(code).toContain('markConnectedOptimistically')
      expect(code).toContain('hostModelValue')
      expect(code).toContain('setValueFromHost')
      // The template literal survives through identifier prefixing.
      expect(code).toContain('${_ctx.prefix}')
    })
  })

  describe('idempotency under duplicate registration', () => {
    it('does not double-wrap a component binding when hint transform is registered twice', () => {
      const code = compileWith(`<MyInput v-register="form.register('email')" />`, [
        vRegisterHintTransform,
        vRegisterHintTransform,
      ])
      const hits = code.match(/markConnectedOptimistically/g)?.length ?? 0
      expect(hits).toBe(1)
    })

    it('does not double-capture a component binding when preamble transform is registered twice', () => {
      const code = compileWith(`<MyInput v-register="form.register('email')" />`, [
        vRegisterPreambleTransform,
        vRegisterPreambleTransform,
      ])
      const hits = code.match(/markConnectedOptimistically/g)?.length ?? 0
      expect(hits).toBe(1)
    })

    it('component-bridge-transform on a component IS idempotent under duplicate registration', () => {
      // The plain-host v-model pair injects via strip-then-reinject (the strip
      // drops a prior injection of our own modelValue / onUpdate:modelValue),
      // and the registerValue branch carries an already-applied marker. So a
      // doubly-registered pipeline injects each exactly once. setValueFromHost
      // is the sharp check: a non-idempotent re-run would array-wrap the
      // onUpdate handler (two setValueFromHost references) while the
      // `"onUpdate:modelValue":` key itself still reads as one occurrence.
      const code = compileWith(`<MyInput v-register="reg" />`, [
        componentBridgeTransform,
        componentBridgeTransform,
      ])
      const modelValueHits =
        code.match(/modelValue:\s*\(.*\)\?\.hostModelValue\?\.value/g)?.length ?? 0
      const setterHits = code.match(/setValueFromHost/g)?.length ?? 0
      const regValueHits = code.match(/registerValue:/g)?.length ?? 0
      expect(modelValueHits).toBe(1)
      expect(setterHits).toBe(1)
      expect(regValueHits).toBe(1)
    })
  })
})
