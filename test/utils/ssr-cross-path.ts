// Shared harness for the cross-render-path SSR parity matrix (#378).
//
// Attaform emits SSR form-state through two disjoint code paths that must
// agree for the same field + form state:
//
//   - COMPILED path: the node transforms (inputTextAreaNodeTransform,
//     componentBridgeTransform) bake value / checked / selected into the
//     generated render code.
//   - RUNTIME path: the directive's getSSRFormStateProps returns the same
//     attributes as a prop object for h() + withDirectives usage.
//
// The suite tests each path independently against the spec, but nothing
// asserts the two paths emit EQUIVALENT output for the same state -- the
// exact blind spot behind #370 / #374 (one symptom, two unrelated fixes in
// two paths) and #394. This module renders one shared fixture through both
// paths and locks them in step.
//
// IMPORTANT (scope of the guard): a cross-path equality check catches the
// two paths DIVERGING. It cannot catch a shared-core semantic bug where both
// paths read the same helper and agree on the same WRONG answer -- e.g. the
// autoAria #381 / #404 class through shared resolveAriaValue. Those need
// per-feature correctness tests, not this matrix.
//
// Consumers must run under `@vitest-environment jsdom` (extractSignal and the
// hydration assertions parse and mount real DOM).
import { baseCompile } from '@vue/compiler-core'
import { renderToString } from '@vue/server-renderer'
import { expect, vi } from 'vitest'
import * as Vue from 'vue'
import {
  createSSRApp,
  defineComponent,
  h,
  nextTick,
  withDirectives,
  type Component,
  type DirectiveArguments,
  type VNode,
} from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { installVRegister, vRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import { componentBridgeTransform } from '../../src/runtime/lib/core/transforms/component-bridge-transform'
import { inputTextAreaNodeTransform } from '../../src/runtime/lib/core/transforms/input-text-area-transform'
import { vRegisterHintTransform } from '../../src/runtime/lib/core/transforms/v-register-hint-transform'
import { vRegisterPreambleTransform } from '../../src/runtime/lib/core/transforms/v-register-preamble-transform'

// zV3 / useFormV3 are cast to their v4 static types so a shared loop
// type-checks (the two adapters' static types don't unify, but their runtime
// surface used here is identical). The real v3 instances run at runtime; the
// cast only satisfies the compiler -- same pattern as the per-path SSR tests.
export const ADAPTERS = [
  { name: 'zod-v4', z: zV4, useForm: useFormV4 },
  {
    name: 'zod-v3',
    z: zV3 as unknown as typeof zV4,
    useForm: useFormV3 as unknown as typeof useFormV4,
  },
] as const

export type Adapter = (typeof ADAPTERS)[number]

// The full transform stack a real SFC compile runs through, so the compiled
// path under test matches production codegen exactly.
const TRANSFORMS = [
  componentBridgeTransform,
  inputTextAreaNodeTransform,
  vRegisterPreambleTransform,
  vRegisterHintTransform,
]

/** Compile a parent template to a render function (mirrors the per-path tests). */
export function compileToRender(template: string): (this: unknown, ctx: unknown) => unknown {
  const result = baseCompile(template, {
    nodeTransforms: TRANSFORMS,
    mode: 'function',
    prefixIdentifiers: true,
    hoistStatic: false,
  })
  const fn = new Function('Vue', `${result.code}\nreturn render`)
  return fn(Vue) as (this: unknown, ctx: unknown) => unknown
}

export type Variant =
  | 'text'
  | 'email'
  | 'number'
  | 'textarea'
  | 'checkbox'
  | 'radio'
  | 'select'
  | 'file'

// The canonical form-state signal, normalised across both paths:
//   - text / email / number / textarea -> the element's effective value
//   - checkbox / radio                 -> whether `checked` is present
//   - select                           -> per-option `selected` map
//   - file                             -> the `value` ATTRIBUTE (expected null)
export type Signal = string | boolean | null | Record<string, boolean>

export interface Fixture {
  /** Unique, human-readable label -- also seeds the per-row form key. */
  label: string
  variant: Variant
  /** Built per adapter so v3 and v4 both run. */
  makeSchema: (z: typeof zV4) => unknown
  path: string
  defaultValues: Record<string, unknown>
  /**
   * Concrete resolved input type (text / email / number / checkbox / radio /
   * file). The RUNTIME path always sees this concrete value -- there is no
   * static-vs-dynamic distinction at the SSR layer there.
   */
  resolvedType?: string
  /**
   * How the COMPILED template authors the type. 'dynamic' emits `:type="t"`
   * (the #374 wrapper shape that the transform must still resolve); 'static'
   * emits `type="..."`. Ignored by the runtime path.
   */
  typeBinding?: 'static' | 'dynamic'
  /** Option values for select. */
  optionValues?: string[]
  /** The value discriminator on a checkbox/radio input (also the chosen select option). */
  matchValue?: string
  /** The canonical signal both paths emit, unless overridden per path below. */
  expected: Signal
  /**
   * Per-path expected override for a DELIBERATE asymmetry. Only `select`
   * needs this: the runtime path emits no option-level `selected`
   * (getSSRFormStateProps returns undefined for select -- it is not
   * element-expressible), while the compiled path emits it via
   * componentBridgeTransform. Encoding it here means a future variant with an
   * inherent split MUST declare it or the parity assertion fails.
   */
  asymmetry?: { compiled?: Signal; runtime?: Signal }
  /** File only: this substring (the model value) must never appear in the SSR HTML. */
  leakString?: string
}

type RenderPath = 'compiled' | 'runtime'

/** Author the COMPILED parent template for a fixture. */
function buildTemplate(f: Fixture): string {
  const reg = `v-register="form.register('${f.path}')"`
  if (f.variant === 'textarea') return `<textarea ${reg}></textarea>`
  if (f.variant === 'select') {
    const opts = (f.optionValues ?? []).map((v) => `<option value="${v}">${v}</option>`).join('')
    return `<select ${reg}>${opts}</select>`
  }
  const typeAttr = f.typeBinding === 'dynamic' ? `:type="t"` : `type="${f.resolvedType ?? 'text'}"`
  const valueAttr = f.matchValue !== undefined ? ` value="${f.matchValue}"` : ''
  return `<input ${typeAttr} ${reg}${valueAttr} />`
}

/** Build the equivalent RUNTIME vnode for a fixture. */
function buildRuntimeVNode(f: Fixture, rv: unknown): VNode {
  const dirs: DirectiveArguments = [[vRegister, rv]]
  if (f.variant === 'textarea') return withDirectives(h('textarea'), dirs)
  if (f.variant === 'select') {
    const opts = (f.optionValues ?? []).map((v) => h('option', { value: v }, v))
    return withDirectives(h('select', null, opts), dirs)
  }
  const props: Record<string, unknown> = { type: f.resolvedType ?? 'text' }
  if (f.matchValue !== undefined) props['value'] = f.matchValue
  return withDirectives(h('input', props), dirs)
}

function makeComponent(
  renderPath: RenderPath,
  f: Fixture,
  adapter: Adapter,
  key: string
): Component {
  const { z, useForm } = adapter
  if (renderPath === 'compiled') {
    return defineComponent({
      setup() {
        // The schema is statically `unknown` (the harness is generic over
        // every fixture's shape); useForm needs a concrete type, so the one
        // cast lives here -- same as the per-path SSR tests.
        const form = useForm({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          schema: f.makeSchema(z) as any,
          defaultValues: f.defaultValues,
          key,
        })
        return { form, t: f.resolvedType ?? 'text' }
      },
      render: compileToRender(buildTemplate(f)),
    })
  }
  return defineComponent({
    setup() {
      const form = useForm({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        schema: f.makeSchema(z) as any,
        defaultValues: f.defaultValues,
        key,
      })
      // The `any` schema collapses register's path parameter to `never`; cast
      // the fixture path to satisfy the typed call.
      const rv = form.register(f.path as never)
      return () => buildRuntimeVNode(f, rv)
    },
  })
}

/** Read the canonical signal out of a parsed SSR container. */
export function signalFrom(container: HTMLElement, f: Fixture): Signal {
  switch (f.variant) {
    case 'text':
    case 'email':
    case 'number': {
      const el = container.querySelector('input')
      return el === null ? null : (el as HTMLInputElement).value
    }
    case 'file': {
      // file inputs reject a programmatic value; assert the ATTRIBUTE absence
      // (the property is always '' in jsdom and would mask a leak).
      return container.querySelector('input')?.getAttribute('value') ?? null
    }
    case 'textarea': {
      const el = container.querySelector('textarea')
      // `.value` reflects the spec-correct effective value: Vue routes a
      // seeded textarea value to its text content, and the property reads it
      // back. If a path wrongly emitted a value= ATTRIBUTE, the property would
      // be '' -- and the parity check would catch that divergence.
      return el === null ? null : (el as HTMLTextAreaElement).value
    }
    case 'checkbox':
    case 'radio': {
      const sel = f.matchValue !== undefined ? `input[value="${f.matchValue}"]` : 'input'
      return container.querySelector(sel)?.hasAttribute('checked') ?? false
    }
    case 'select': {
      const map: Record<string, boolean> = {}
      for (const v of f.optionValues ?? []) {
        map[v] = container.querySelector(`option[value="${v}"]`)?.hasAttribute('selected') ?? false
      }
      return map
    }
  }
}

function parse(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

// Async hydration completes over several microtasks and the directive's warn
// deferral is itself a post-flush nextTick, so drain both queues to make the
// no-mismatch / no-false-warn assertions conclusive (mirrors the warn-race
// test's settle()).
async function settle(): Promise<void> {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 10))
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Run the full guard for one fixture on one render path:
 *   1+2. Parse the SSR HTML and assert the signal equals the per-path
 *        expectation -- this is both ground-truth correctness AND no-flash
 *        (the parsed markup IS the pre-hydration DOM the browser paints).
 *   3.   Mount over that markup and assert a clean hydration: no
 *        hydration-mismatch warning and no false `v-register` no-op /
 *        no-parent-RV warn (folds #370 in).
 */
async function runOnePath(renderPath: RenderPath, f: Fixture, adapter: Adapter): Promise<void> {
  const key = `xpath-${adapter.name}-${f.label}-${renderPath}`
  const Comp = makeComponent(renderPath, f, adapter, key)
  const expected = f.asymmetry?.[renderPath] ?? f.expected
  const where = `${f.label} [${adapter.name}/${renderPath}]`

  const warnings: string[] = []
  const capture = (...args: unknown[]): void => {
    warnings.push(args.map((a) => String(a)).join(' '))
  }
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(capture)
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(capture)

  try {
    // The compiled path resolves `v-register` at render time
    // (runtime-compiled template): installVRegister is that path's
    // production delivery, since createAttaform registers no directive.
    const serverApp = createSSRApp(Comp).use(createAttaform())
    installVRegister(serverApp)
    const html = await renderToString(serverApp)

    // Ground-truth + no-flash: the value/checked/selected the browser parses
    // before any client JS runs.
    const root = parse(html)
    document.body.appendChild(root)
    expect(signalFrom(root, f), `${where}: SSR signal pre-hydration`).toEqual(expected)
    if (f.leakString !== undefined) {
      expect(html, `${where}: no model leak`).not.toContain(f.leakString)
    }

    // Clean hydration over the planted markup.
    const app = createSSRApp(Comp).use(createAttaform())
    installVRegister(app)
    app.mount(root)
    await settle()
    const mismatches = warnings.filter((w) => /hydrat|mismatch/i.test(w))
    const falseWarns = warnings.filter(
      (w) => w.includes('is a no-op') || w.includes('no parent registerValue')
    )
    // The delivery guard: a compiled-path fixture rendering without the
    // directive would still pass the signal assertions (the transforms
    // carry value/checked/selected), so an unresolved `v-register` must
    // fail loudly here rather than degrade the matrix silently.
    const unresolved = warnings.filter((w) => w.includes('Failed to resolve directive'))
    expect(mismatches, `${where}: hydration mismatch warnings`).toEqual([])
    expect(falseWarns, `${where}: false v-register warnings`).toEqual([])
    expect(unresolved, `${where}: v-register not delivered`).toEqual([])
    app.unmount()
    root.remove()
  } finally {
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  }
}

/**
 * The matrix entry point: render the fixture through BOTH paths and assert
 * each matches its per-path expectation. A single `expected` drives both
 * paths for non-asymmetric variants, so the two paths are locked in step --
 * you cannot author one side's expectation differently from the other's by
 * accident.
 */
export async function assertCrossPathParity(f: Fixture, adapter: Adapter): Promise<void> {
  await runOnePath('compiled', f, adapter)
  await runOnePath('runtime', f, adapter)
}

/** Capture console.warn/error for the duration of `fn`; returns the lines. */
export async function withWarnCapture(fn: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = []
  const capture = (...args: unknown[]): void => {
    warnings.push(args.map((a) => String(a)).join(' '))
  }
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(capture)
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(capture)
  try {
    await fn()
  } finally {
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  }
  return warnings
}

export { settle }
