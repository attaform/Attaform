// @vitest-environment jsdom
//
// Cross-render-path SSR parity matrix (#378).
//
// Attaform emits SSR form-state through two disjoint code paths: the COMPILED
// node transforms and the RUNTIME getSSRProps. They must produce equivalent
// output for the same form state, but the suite otherwise tests each path
// independently against the spec -- the exact blind spot that produced #370 /
// #374 (one symptom, two unrelated fixes in two paths) and #394. This matrix
// renders one shared fixture set through BOTH paths and locks them in step:
// add a new input variant and it becomes one fixture row, automatically
// checked on both paths, so the next divergence is a red test here rather
// than a downstream bug report.
//
// Three layers per row (see test/utils/ssr-cross-path.ts):
//   1+2. ground-truth + no-flash -- each path's emitted signal equals a single
//        declared expectation, read from the parsed pre-hydration DOM.
//   3.   clean hydration -- mounts over the SSR markup with no mismatch and no
//        false `v-register` no-op / no-parent-RV warn (folds #370 in).
//
// WHAT THIS GUARD DOES NOT CATCH: a cross-path equality check catches the two
// paths DIVERGING. It is blind to a shared-core semantic bug where both paths
// read the same helper and agree on the same WRONG answer -- e.g. the autoAria
// aria-required class (#381 / #404) through shared resolveAriaValue, which
// reproduces identically on both paths. Those need per-feature correctness
// tests. This matrix guards path divergence and first-paint correctness only.
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import {
  Suspense,
  createSSRApp,
  defineComponent,
  h,
  ref,
  withDirectives,
  type Component,
} from 'vue'
import { useRegister } from '../../src'
import { vRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import {
  ADAPTERS,
  assertCrossPathParity,
  compileToRender,
  settle,
  withWarnCapture,
  type Fixture,
} from '../utils/ssr-cross-path'

// The curated fixture set: meaningful combinations of variant x value-shape x
// type-binding, not a blind cartesian product. Schemas are built per adapter
// so v3 and v4 both run. `typeBinding: 'dynamic'` only changes how the
// COMPILED template authors the type (`:type="t"`, the #374 wrapper shape) --
// the runtime path always sees the resolved `resolvedType`.
const FIXTURES: Fixture[] = [
  // --- Text family (value attribute) ---
  {
    label: 'text/seeded/static',
    variant: 'text',
    resolvedType: 'text',
    typeBinding: 'static',
    makeSchema: (z) => z.object({ orgName: z.string() }),
    path: 'orgName',
    defaultValues: { orgName: 'Acme PHA' },
    expected: 'Acme PHA',
  },
  {
    label: 'text/seeded/dynamic-type', // the #374 Fix A shape
    variant: 'text',
    resolvedType: 'text',
    typeBinding: 'dynamic',
    makeSchema: (z) => z.object({ orgName: z.string() }),
    path: 'orgName',
    defaultValues: { orgName: 'Acme PHA' },
    expected: 'Acme PHA',
  },
  {
    label: 'text/empty', // no stale value to flash; both paths show empty
    variant: 'text',
    resolvedType: 'text',
    typeBinding: 'static',
    makeSchema: (z) => z.object({ orgName: z.string() }),
    path: 'orgName',
    defaultValues: { orgName: '' },
    expected: '',
  },
  {
    label: 'email/seeded',
    variant: 'email',
    resolvedType: 'email',
    typeBinding: 'static',
    makeSchema: (z) => z.object({ contact: z.string() }),
    path: 'contact',
    defaultValues: { contact: 'ada@example.com' },
    expected: 'ada@example.com',
  },
  {
    label: 'number/seeded',
    variant: 'number',
    resolvedType: 'number',
    typeBinding: 'static',
    makeSchema: (z) => z.object({ age: z.number() }),
    path: 'age',
    defaultValues: { age: 42 },
    expected: '42',
  },

  // --- Textarea (value rides as text content) ---
  {
    label: 'textarea/seeded',
    variant: 'textarea',
    makeSchema: (z) => z.object({ bio: z.string() }),
    path: 'bio',
    defaultValues: { bio: 'hello world' },
    expected: 'hello world',
  },
  {
    label: 'textarea/empty',
    variant: 'textarea',
    makeSchema: (z) => z.object({ bio: z.string() }),
    path: 'bio',
    defaultValues: { bio: '' },
    expected: '',
  },

  // --- Checkbox / radio (checked) ---
  {
    label: 'checkbox-bool/true',
    variant: 'checkbox',
    resolvedType: 'checkbox',
    typeBinding: 'static',
    makeSchema: (z) => z.object({ agree: z.boolean() }),
    path: 'agree',
    defaultValues: { agree: true },
    expected: true,
  },
  {
    label: 'checkbox-bool/false',
    variant: 'checkbox',
    resolvedType: 'checkbox',
    typeBinding: 'static',
    makeSchema: (z) => z.object({ agree: z.boolean() }),
    path: 'agree',
    defaultValues: { agree: false },
    expected: false,
  },
  {
    label: 'checkbox-array/member',
    variant: 'checkbox',
    resolvedType: 'checkbox',
    typeBinding: 'static',
    matchValue: 'apple',
    makeSchema: (z) => z.object({ picks: z.array(z.string()) }),
    path: 'picks',
    defaultValues: { picks: ['apple'] },
    expected: true,
  },
  {
    label: 'checkbox-array/dynamic-type', // Fix A coverage for a non-text variant
    variant: 'checkbox',
    resolvedType: 'checkbox',
    typeBinding: 'dynamic',
    matchValue: 'apple',
    makeSchema: (z) => z.object({ picks: z.array(z.string()) }),
    path: 'picks',
    defaultValues: { picks: ['apple'] },
    expected: true,
  },
  {
    label: 'radio/match',
    variant: 'radio',
    resolvedType: 'radio',
    typeBinding: 'static',
    matchValue: 'b',
    makeSchema: (z) => z.object({ size: z.string() }),
    path: 'size',
    defaultValues: { size: 'b' },
    expected: true,
  },
  {
    label: 'radio/non-match',
    variant: 'radio',
    resolvedType: 'radio',
    typeBinding: 'static',
    matchValue: 'b',
    makeSchema: (z) => z.object({ size: z.string() }),
    path: 'size',
    defaultValues: { size: 'a' },
    expected: false,
  },

  // --- Select: the one DELIBERATE asymmetry. The compiled transform emits
  // per-option `selected`; the runtime getSSRProps cannot express option-level
  // state from the <select> element and returns undefined (a documented
  // first-paint flash). Encoded as an explicit per-path override so the matrix
  // asserts the gap rather than false-failing on it. (The component-wrapper
  // slotted-options case is owned by component-wrapper-select-ssr.test.ts.)
  {
    label: 'select/seeded',
    variant: 'select',
    optionValues: ['us', 'uk'],
    matchValue: 'uk',
    makeSchema: (z) => z.object({ country: z.string() }),
    path: 'country',
    defaultValues: { country: 'uk' },
    expected: { us: false, uk: true },
    asymmetry: { runtime: { us: false, uk: false } },
  },

  // --- File: symmetric non-emitter. Browsers reject a value on file inputs,
  // so both paths emit none -- and the model string must never leak.
  {
    label: 'file/static',
    variant: 'file',
    resolvedType: 'file',
    typeBinding: 'static',
    makeSchema: (z) => z.object({ doc: z.string() }),
    path: 'doc',
    defaultValues: { doc: 'should-not-leak' },
    expected: null,
    leakString: 'should-not-leak',
  },
  {
    label: 'file/dynamic-type',
    variant: 'file',
    resolvedType: 'file',
    typeBinding: 'dynamic',
    makeSchema: (z) => z.object({ doc: z.string() }),
    path: 'doc',
    defaultValues: { doc: 'should-not-leak' },
    expected: null,
    leakString: 'should-not-leak',
  },
]

// Intentionally NOT in the table: dynamic `:type` for textarea/select (those
// tags have no `type`), and the async-restored value shape -- async
// defaultValues resolve to byte-identical markup to sync seeding once awaited,
// so the distinct async risk is the hydration-timing race, covered as a
// dedicated row below rather than multiplying the whole table.

describe.each(ADAPTERS)('SSR cross-path parity ($name)', (adapter) => {
  it.each(FIXTURES)('$label emits equivalent SSR state on both paths', async (fixture) => {
    await assertCrossPathParity(fixture, adapter)
  })

  // Integration row: the realistic consumer wrapper (useRegister() + an inner
  // `<input v-register :type>`, the UiTextField shape). Anchors the matrix to
  // how apps actually consume the directive, and proves the wrapper emits the
  // value identically through both render paths.
  it('integration: a useRegister() wrapper emits the value on both paths', async () => {
    const { z, useForm } = adapter

    const UiTextFieldCompiled = defineComponent({
      name: 'UiTextField',
      inheritAttrs: false,
      setup() {
        const register = useRegister()
        const type = ref('text')
        return { register, type }
      },
      render: compileToRender(`<input v-register="register" :type="type" />`),
    })
    const ParentCompiled = defineComponent({
      name: 'WrapperParentCompiled',
      components: { UiTextField: UiTextFieldCompiled },
      setup() {
        const form = useForm({
          schema: z.object({ orgName: z.string() }),
          defaultValues: { orgName: 'Acme PHA' },
          key: `xpath-wrapper-compiled-${adapter.name}`,
        })
        return { form }
      },
      render: compileToRender(`<div><UiTextField v-register="form.register('orgName')" /></div>`),
    })

    const UiTextFieldRuntime = defineComponent({
      name: 'UiTextField',
      inheritAttrs: false,
      setup() {
        const register = useRegister()
        return () => withDirectives(h('input', { type: 'text' }), [[vRegister, register?.value]])
      },
    })
    const ParentRuntime = defineComponent({
      name: 'WrapperParentRuntime',
      setup() {
        const form = useForm({
          schema: z.object({ orgName: z.string() }),
          defaultValues: { orgName: 'Acme PHA' },
          key: `xpath-wrapper-runtime-${adapter.name}`,
        })
        return () => {
          const rv = form.register('orgName')
          // Pass the registerValue bridge prop the compiled transform would
          // inject, plus the directive marker, so the child's useRegister()
          // binds for real. A variable (not an inline literal) sidesteps the
          // excess-property check on the propless child.
          const childProps = { registerValue: rv }
          return h('div', null, [
            withDirectives(h(UiTextFieldRuntime, childProps), [[vRegister, rv]]),
          ])
        }
      },
    })

    function inputValue(html: string): string | null {
      const root = document.createElement('div')
      root.innerHTML = html
      const el = root.querySelector('input')
      return el === null ? null : (el as HTMLInputElement).value
    }

    const compiledHtml = await renderToString(createSSRApp(ParentCompiled).use(createAttaform()))
    const runtimeHtml = await renderToString(createSSRApp(ParentRuntime).use(createAttaform()))

    expect(inputValue(compiledHtml), 'compiled wrapper value').toBe('Acme PHA')
    expect(inputValue(runtimeHtml), 'runtime wrapper value').toBe('Acme PHA')
    // The two paths agree -- the lockstep the matrix exists to enforce.
    expect(inputValue(compiledHtml)).toBe(inputValue(runtimeHtml))
  })

  // Case B integration: a THIRD-PARTY v-model component (no useRegister; it
  // declares a `modelValue` prop and renders it onto an inner control). The
  // compiled path injects `:modelValue` via componentBridgeTransform; the
  // runtime path seeds the inner control's value via the directive's
  // getSSRProps firing on the transferred element. A scalar model paints the
  // same value on both paths and survives hydration: on the client runtime
  // path the host renders value="" (no modelValue prop reaches it), yet the
  // seeded SSR value stays put (Vue leaves it during hydration).
  it('integration: a third-party scalar component host paints + hydrates on both paths', async () => {
    const { z, useForm } = adapter

    const ThirdPartyInput = defineComponent({
      name: 'ThirdPartyInput',
      inheritAttrs: false,
      props: ['modelValue'],
      emits: ['update:modelValue'],
      setup(props) {
        return () => h('input', { type: 'text', value: props.modelValue ?? '' })
      },
    })

    const ParentCompiled = defineComponent({
      name: 'ScalarHostParentCompiled',
      components: { ThirdPartyInput },
      setup() {
        const form = useForm({
          schema: z.object({ orgName: z.string() }),
          defaultValues: { orgName: 'Acme PHA' },
          key: `xpath-scalarhost-compiled-${adapter.name}`,
        })
        return { form }
      },
      render: compileToRender(`<ThirdPartyInput v-register="form.register('orgName')" />`),
    })

    const ParentRuntime = defineComponent({
      name: 'ScalarHostParentRuntime',
      setup() {
        const form = useForm({
          schema: z.object({ orgName: z.string() }),
          defaultValues: { orgName: 'Acme PHA' },
          key: `xpath-scalarhost-runtime-${adapter.name}`,
        })
        return () => withDirectives(h(ThirdPartyInput), [[vRegister, form.register('orgName')]])
      },
    })

    function innerValue(html: string): string | null {
      const root = document.createElement('div')
      root.innerHTML = html
      const el = root.querySelector('input')
      return el === null ? null : (el as HTMLInputElement).value
    }

    async function renderAndHydrate(
      Comp: Component
    ): Promise<{ ssr: string | null; client: string | null }> {
      let ssr: string | null = null
      let client: string | null = null
      const warnings = await withWarnCapture(async () => {
        const html = await renderToString(createSSRApp(Comp).use(createAttaform()))
        ssr = innerValue(html)
        const container = document.createElement('div')
        container.innerHTML = html
        document.body.appendChild(container)
        const app = createSSRApp(Comp).use(createAttaform())
        app.mount(container)
        await settle()
        client = container.querySelector('input')?.value ?? null
        app.unmount()
        container.remove()
      })
      expect(
        warnings.filter((w) => /hydrat|mismatch/i.test(w)),
        'no hydration mismatch'
      ).toEqual([])
      expect(
        warnings.filter((w) => w.includes('is a no-op')),
        'no false no-op warn'
      ).toEqual([])
      return { ssr, client }
    }

    const compiled = await renderAndHydrate(ParentCompiled)
    const runtime = await renderAndHydrate(ParentRuntime)

    expect(compiled.ssr, 'compiled SSR value').toBe('Acme PHA')
    expect(runtime.ssr, 'runtime SSR value').toBe('Acme PHA')
    expect(compiled.client, 'compiled post-hydration value').toBe('Acme PHA')
    expect(runtime.client, 'runtime post-hydration value').toBe('Acme PHA')
    expect(runtime.ssr).toBe(compiled.ssr)
  })

  // A TYPED (array) host pins the value-channel split. The transform carries
  // the typed model on `:modelValue` (innerRef.value, not the stringified
  // displayValue), so the host renders the real array -- `join('|')` proves it
  // arrived as an array. The directive must NOT then clobber that with the
  // per-element `value = displayValue` seed when it fires on the transferred
  // inner control. On the COMPILED path it doesn't: the SSR_COMPONENT_HOST
  // modifier rides the transferred fire, gating getSSRFormStateProps off, so
  // the host's `alpha|beta` survives. The RUNTIME render-function path carries
  // no modifier on that fire, so it cannot tell the host's inner control from a
  // directly-bound native input and still seeds the stringified `alpha,beta`.
  // That asymmetry is a documented limitation (the hand-written runtime path
  // with a typed component host), mirroring select's runtime `selected`
  // omission; the compiled SFC path -- how apps actually author -- is correct.
  it('integration: a typed component host keeps its render on compiled, stringifies on runtime', async () => {
    const { z, useForm } = adapter

    const TagsHost = defineComponent({
      name: 'TagsHost',
      inheritAttrs: false,
      props: ['modelValue'],
      emits: ['update:modelValue'],
      setup(props) {
        return () => {
          const v = props.modelValue
          return h('input', { type: 'text', value: Array.isArray(v) ? v.join('|') : '' })
        }
      },
    })

    const ParentCompiled = defineComponent({
      name: 'TagsHostParentCompiled',
      components: { TagsHost },
      setup() {
        const form = useForm({
          schema: z.object({ tags: z.array(z.string()) }),
          defaultValues: { tags: ['alpha', 'beta'] },
          key: `xpath-tagshost-compiled-${adapter.name}`,
        })
        return { form }
      },
      render: compileToRender(`<TagsHost v-register="form.register('tags')" />`),
    })

    const ParentRuntime = defineComponent({
      name: 'TagsHostParentRuntime',
      setup() {
        const form = useForm({
          schema: z.object({ tags: z.array(z.string()) }),
          defaultValues: { tags: ['alpha', 'beta'] },
          key: `xpath-tagshost-runtime-${adapter.name}`,
        })
        return () => withDirectives(h(TagsHost), [[vRegister, form.register('tags')]])
      },
    })

    function innerValue(html: string): string | null {
      const root = document.createElement('div')
      root.innerHTML = html
      const el = root.querySelector('input')
      return el === null ? null : (el as HTMLInputElement).value
    }

    const compiledHtml = await renderToString(createSSRApp(ParentCompiled).use(createAttaform()))
    const runtimeHtml = await renderToString(createSSRApp(ParentRuntime).use(createAttaform()))

    // Compiled (the authored path): the typed model survives, host renders it.
    expect(innerValue(compiledHtml), 'compiled: host render survives').toBe('alpha|beta')
    // Runtime render-function path: documented limitation, stringified seed.
    expect(innerValue(runtimeHtml), 'runtime: stringified displayValue').toBe('alpha,beta')
  })

  // Async-hydration row (#370): under Nuxt-style lazy hydration (an async
  // setup ancestor under <Suspense>), the prescribed useRegister wrapper must
  // hydrate without the false `v-register no-op` warn that the marker-timing
  // race used to emit. This is the genuine distinct risk of the "restored
  // (async)" value shape -- timing, not attribute emission.
  it('async hydration of a useRegister wrapper emits no false no-op warn (#370)', async () => {
    const { z, useForm } = adapter

    const Field = defineComponent({
      name: 'Field',
      inheritAttrs: false,
      setup() {
        const rv = useRegister()
        return () =>
          h('div', { class: 'field' }, [
            withDirectives(h('input', { type: 'text' }), [[vRegister, rv]]),
          ])
      },
    })
    const Parent = defineComponent({
      name: 'AsyncWrapperParent',
      setup() {
        const form = useForm({
          schema: z.object({ email: z.string() }),
          defaultValues: { email: '' },
          key: `xpath-async-hydration-${adapter.name}`,
        })
        return () => {
          const rv = form.register('email')
          const childProps = { registerValue: rv }
          return withDirectives(h(Field, childProps), [[vRegister, rv]])
        }
      },
    })
    const AsyncBoundary = defineComponent({
      name: 'AsyncBoundary',
      async setup() {
        await Promise.resolve()
        return () => h(Parent)
      },
    })
    const App = defineComponent({
      name: 'AsyncApp',
      setup() {
        return () => h(Suspense, null, { default: () => h(AsyncBoundary) })
      },
    })

    const warnings = await withWarnCapture(async () => {
      const html = await renderToString(createSSRApp(App).use(createAttaform()))
      const container = document.createElement('div')
      container.innerHTML = html
      document.body.appendChild(container)
      const app = createSSRApp(App).use(createAttaform())
      app.mount(container)
      await settle()
      app.unmount()
      container.remove()
    })

    expect(warnings.filter((w) => w.includes('is a no-op'))).toEqual([])
  })
})
