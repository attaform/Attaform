// @vitest-environment jsdom
import { baseCompile } from '@vue/compiler-core'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import * as Vue from 'vue'
import { createSSRApp, defineComponent } from 'vue'
import { z as zV3 } from 'zod-v3'
import { z as zV4 } from 'zod'
import { createAttaform } from '../../src/runtime/core/plugin'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { componentBridgeTransform } from '../../src/runtime/lib/core/transforms/component-bridge-transform'
import { inputTextAreaNodeTransform } from '../../src/runtime/lib/core/transforms/input-text-area-transform'
import { vRegisterHintTransform } from '../../src/runtime/lib/core/transforms/v-register-hint-transform'
import { vRegisterPreambleTransform } from '../../src/runtime/lib/core/transforms/v-register-preamble-transform'

/**
 * Binding-scope safety for the `:selected` marks `componentBridgeTransform`
 * injects onto a `<select>`'s `<option>` children (#566).
 *
 * An `<option>` may sit in any binding scope the author chose: inline,
 * inside a `v-for`, inside several sibling `v-for`s, nested under an
 * `<optgroup>` that is itself looped. The expression the transform
 * injects has to resolve in whichever scope that option lands in, which
 * means it may only reference the option's own bindings and those of
 * the enclosing `<select>` — never another option's.
 *
 * The transform used to concatenate every preceding sibling's match
 * expression into each option's binding, as a "one of us already
 * matched" guard. Two `<option v-for>` siblings then put the first
 * loop's alias inside the second loop's render callback and the
 * component died at render with `ReferenceError: a is not defined`.
 * It read as a `v-register` fault because the stack pointed at the
 * directive's line, and as an intermittent one because a second loop
 * that happened to render zero items never evaluated the bad callback.
 *
 * The generated-code assertions below are the durable half: rendering
 * proves today's templates work, but only reading the emitted callback
 * proves no sibling's alias got baked into it.
 */

const TRANSFORMS = [
  componentBridgeTransform,
  inputTextAreaNodeTransform,
  vRegisterPreambleTransform,
  vRegisterHintTransform,
]

function compileModule(template: string): string {
  return baseCompile(template, {
    nodeTransforms: TRANSFORMS,
    mode: 'module',
    prefixIdentifiers: true,
    hoistStatic: false,
  }).code
}

function compileRender(template: string): (this: unknown, ctx: unknown) => unknown {
  const result = baseCompile(template, {
    nodeTransforms: TRANSFORMS,
    mode: 'function',
    prefixIdentifiers: true,
    hoistStatic: false,
  })
  const fn = new Function('Vue', `${result.code}\nreturn render`)
  return fn(Vue) as (this: unknown, ctx: unknown) => unknown
}

/**
 * Slice out each `_renderList(..., (alias) => ...)` callback body so a
 * test can ask what a single loop's generated code references. Brace
 * matching from the arrow rather than a regex, because the bodies nest.
 */
function renderListBodies(code: string): { alias: string; body: string }[] {
  const out: { alias: string; body: string }[] = []
  const opener = /_renderList\([^,]+,\s*\((\w+)[^)]*\)\s*=>\s*\{/g
  let match: RegExpExecArray | null
  while ((match = opener.exec(code)) !== null) {
    const alias = match[1]
    if (alias === undefined) continue
    let depth = 1
    let i = opener.lastIndex
    while (i < code.length && depth > 0) {
      const ch = code[i]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      i++
    }
    out.push({ alias, body: code.slice(opener.lastIndex, i - 1) })
  }
  return out
}

/**
 * Each adapter builds its own forms. The two adapters' `useForm`
 * signatures do not unify, so a shared `useForm(schema)` call site
 * would be uncallable through the `describe.each` union; keeping the
 * call inside the adapter entry keeps every schema type concrete.
 */
const ADAPTERS = [
  {
    name: 'zod v4',
    choiceForm: (choice: string) =>
      useFormV4({ schema: zV4.object({ choice: zV4.string() }), defaultValues: { choice } }),
    picksForm: (picks: string[]) =>
      useFormV4({
        schema: zV4.object({ picks: zV4.array(zV4.string()) }),
        defaultValues: { picks },
      }),
  },
  {
    name: 'zod v3',
    choiceForm: (choice: string) =>
      useFormV3({ schema: zV3.object({ choice: zV3.string() }), defaultValues: { choice } }),
    picksForm: (picks: string[]) =>
      useFormV3({
        schema: zV3.object({ picks: zV3.array(zV3.string()) }),
        defaultValues: { picks },
      }),
  },
] as const

// ── generated code: every option expression resolves in its OWN scope ──

describe("option expressions are resolved in the option's own scope", () => {
  // The other half of #566's rule, and a bug it left standing.
  //
  // The `:selected` binding used to be built while transforming the
  // enclosing `<select>`, which is visited before any option's scope
  // exists. Reading an option's props from there returns raw source
  // text, and raw text spliced into a compound expression is opaque to
  // the compiler's identifier pass — so whatever was read is what
  // shipped. A `v-for` alias survived that by luck, because bare is
  // what an alias needs. Anything else did not.
  //
  // The binding is built on the option's own visit now, where the props
  // are already resolved and `context.identifiers` holds the aliases.
  it('prefixes a plain dynamic `:value` that is not a loop alias', () => {
    const code = compileModule(
      `<select v-register="form.register('choice')"><option :value="code">X</option></select>`
    )
    // Was `String((code))`, which throws `ReferenceError: code is not
    // defined` wherever identifiers are prefixed rather than resolved
    // lexically.
    expect(code).toContain('_ctx.code')
    expect(code).not.toMatch(/String\(\(code\)\)/)
  })

  it('leaves a `v-for` alias bare while prefixing an outer ref beside it', () => {
    // One expression, two scopes. Nothing built from the `<select>`
    // could have told them apart.
    const code = compileModule(
      `<select v-register="form.register('choice')">` +
        `<option v-for="o in opts" :key="o" :value="o" :selected="o === pick">X</option>` +
        `</select>`
    )
    expect(code).toContain('o === _ctx.pick')
    // Word-bounded: `_ctx.opts` (the loop SOURCE, correctly prefixed)
    // contains `_ctx.o` as a substring, so a bare `toContain` would
    // fail on correct output.
    expect(code).not.toMatch(/_ctx\.o\b(?!pts)/)
  })

  it('resolves an alias from an enclosing `<optgroup v-for>`', () => {
    const code = compileModule(
      `<select v-register="form.register('choice')">` +
        `<optgroup v-for="g in groups"><option v-for="o in g.items" :key="o" :value="o">X</option></optgroup>` +
        `</select>`
    )
    expect(code).not.toMatch(/_ctx\.o\b/)
    expect(code).not.toMatch(/_ctx\.g\b/)
  })

  it('still reads an option value from static text content', () => {
    // The D3 text-content fallback rides along with the move.
    const code = compileModule(
      `<select v-register="form.register('choice')"><option>apple</option></select>`
    )
    expect(code).toContain('String(("apple"))')
  })
})

// ── generated code: no option may reference a sibling's scope ────────

describe('option `:selected` binding scopes — generated code', () => {
  // The reported repro, read at the level the issue pinned it to.
  it('two sibling `<option v-for>`s each reference only their own alias', () => {
    const code = compileModule(
      `<select v-register="form.register('choice')">` +
        `<option v-for="a in alpha" :key="a.value" :value="a.value">{{ a.label }}</option>` +
        `<option v-for="b in beta" :key="b.value" :value="b.value">{{ b.label }}</option>` +
        `</select>`
    )
    const bodies = renderListBodies(code)
    expect(bodies.map((entry) => entry.alias)).toEqual(['a', 'b'])
    expect(bodies[0]?.body).not.toMatch(/\bb\b\./)
    expect(bodies[1]?.body).not.toMatch(/\ba\b\./)
  })

  // The original Cubic Housing shape: the second loop lived in an
  // `<optgroup>`. Flattening it kept the failure, so the grouping was
  // incidental, but a nested scope is the harder case and belongs here.
  it('a loop nested in an `<optgroup>` does not reach the preceding loop', () => {
    const code = compileModule(
      `<select v-register="form.register('choice')">` +
        `<option v-for="role in roles" :key="role.id" :value="role.id">{{ role.name }}</option>` +
        `<optgroup label="Questions">` +
        `<option v-for="q in questions" :key="q.id" :value="q.id">{{ q.text }}</option>` +
        `</optgroup>` +
        `</select>`
    )
    const bodies = renderListBodies(code)
    expect(bodies.map((entry) => entry.alias)).toEqual(['role', 'q'])
    expect(bodies[1]?.body).not.toMatch(/\brole\b/)
  })

  it('three sibling loops stay independent', () => {
    const code = compileModule(
      `<select v-register="form.register('choice')">` +
        `<option v-for="a in alpha" :value="a.v">{{ a.v }}</option>` +
        `<option v-for="b in beta" :value="b.v">{{ b.v }}</option>` +
        `<option v-for="c in gamma" :value="c.v">{{ c.v }}</option>` +
        `</select>`
    )
    const bodies = renderListBodies(code)
    expect(bodies.map((entry) => entry.alias)).toEqual(['a', 'b', 'c'])
    expect(bodies[2]?.body).not.toMatch(/\ba\b\./)
    expect(bodies[2]?.body).not.toMatch(/\bb\b\./)
  })

  // A static option's value is a literal, so inlining it never produced
  // a ReferenceError -- which is why the ship-elsewhere shape masked the
  // bug. It must not be inlined now either: nothing from one option
  // belongs in another's binding.
  it('a static option preceding a loop is not inlined into the loop', () => {
    const code = compileModule(
      `<select v-register="form.register('choice')">` +
        `<option value="placeholder-sentinel">Pick one</option>` +
        `<option v-for="b in beta" :key="b.value" :value="b.value">{{ b.label }}</option>` +
        `</select>`
    )
    const bodies = renderListBodies(code)
    expect(bodies[0]?.body).not.toContain('placeholder-sentinel')
  })

  // Each option carried every earlier sibling's expression, so a static
  // list's generated code grew with the square of its length and the
  // earliest option appeared the most often. Asserting that every
  // option's value occurs the same number of times states the linearity
  // without pinning the per-option expression's exact shape: under the
  // old scheme the first value appeared 12 times against the last
  // value's 3.
  it('generated size stays linear in the option count', () => {
    const options = Array.from(
      { length: 10 },
      (_unused, i) => `<option value="v${i}">L${i}</option>`
    ).join('')
    const code = compileModule(`<select v-register="form.register('choice')">${options}</select>`)
    const counts = Array.from(
      { length: 10 },
      (_unused, i) => (code.match(new RegExp(`"v${i}"`, 'g')) ?? []).length
    )
    expect(counts.every((count) => count > 0)).toBe(true)
    expect(new Set(counts).size).toBe(1)
  })
})

// ── rendering: the templates above actually mount and select ─────────

describe.each(ADAPTERS)('option `:selected` binding scopes — SSR ($name)', (adapter) => {
  function ssr(
    template: string,
    makeForm: () => unknown,
    extra: Record<string, unknown> = {}
  ): Promise<string> {
    const Component = defineComponent({
      setup() {
        return { form: makeForm(), ...extra }
      },
      render: compileRender(template),
    })
    const app = createSSRApp(Component)
    app.use(createAttaform())
    return renderToString(app)
  }

  const TWO_LOOPS =
    `<select v-register="form.register('choice')">` +
    `<option v-for="a in alpha" :key="a.value" :value="a.value">{{ a.label }}</option>` +
    `<option v-for="b in beta" :key="b.value" :value="b.value">{{ b.label }}</option>` +
    `</select>`

  const ALPHA = [{ value: 'a1', label: 'A1' }]
  const BETA = [{ value: 'b1', label: 'B1' }]

  it('renders both loops and selects a match in the FIRST one', async () => {
    const html = await ssr(TWO_LOOPS, () => adapter.choiceForm('a1'), {
      alpha: ALPHA,
      beta: BETA,
    })
    expect(html).toContain('<option value="a1" selected>A1</option>')
    expect(html).toContain('<option value="b1">B1</option>')
  })

  // The mark the removed guard would have suppressed had it ever fired,
  // and the half of the behaviour a naive "just delete it" could break.
  it('selects a match in the SECOND loop', async () => {
    const html = await ssr(TWO_LOOPS, () => adapter.choiceForm('b1'), {
      alpha: ALPHA,
      beta: BETA,
    })
    expect(html).toContain('<option value="a1">A1</option>')
    expect(html).toContain('<option value="b1" selected>B1</option>')
  })

  // Two of eight stories passed pre-fix, and these were exactly the ones
  // whose second loop rendered nothing: an empty array never runs the
  // callback holding the out-of-scope reference. Same template, opposite
  // outcome, which is what made it read as a data problem.
  it('renders with an empty second loop (the case that used to pass)', async () => {
    const html = await ssr(TWO_LOOPS, () => adapter.choiceForm('a1'), {
      alpha: ALPHA,
      beta: [],
    })
    expect(html).toContain('<option value="a1" selected>A1</option>')
  })

  it('marks matches across both loops on a `<select multiple>`', async () => {
    const html = await ssr(
      `<select v-register="form.register('picks')" multiple>` +
        `<option v-for="a in alpha" :key="a.value" :value="a.value">{{ a.label }}</option>` +
        `<option v-for="b in beta" :key="b.value" :value="b.value">{{ b.label }}</option>` +
        `</select>`,
      () => adapter.picksForm(['a1', 'b1']),
      { alpha: ALPHA, beta: BETA }
    )
    expect(html).toContain('<option value="a1" selected>A1</option>')
    expect(html).toContain('<option value="b1" selected>B1</option>')
  })

  // Characterization, not an endorsement. The removed guard existed to
  // mark only the FIRST of several matching options on a single-select,
  // and this is the one shape where that could matter: two options
  // sharing a value. Both are marked, exactly as they were before the
  // guard was removed, because the guard compared the register handle
  // against an option value and so never evaluated true. The browser
  // resolves the duplicate on parse and the directive re-syncs from the
  // model at mount, so the marks agree with the model either way. If a
  // correct first-match-wins is ever wanted, this test is the place
  // that decision gets made rather than slipped in.
  it('marks BOTH of two options sharing one value on a single-select', async () => {
    const html = await ssr(
      `<select v-register="form.register('choice')">` +
        `<option value="dup">First</option>` +
        `<option value="dup">Second</option>` +
        `</select>`,
      () => adapter.choiceForm('dup')
    )
    expect((html.match(/selected/g) ?? []).length).toBe(2)
  })

  it('renders a loop nested in an `<optgroup>` beside a sibling loop', async () => {
    const html = await ssr(
      `<select v-register="form.register('choice')">` +
        `<option v-for="a in alpha" :key="a.value" :value="a.value">{{ a.label }}</option>` +
        `<optgroup label="More">` +
        `<option v-for="b in beta" :key="b.value" :value="b.value">{{ b.label }}</option>` +
        `</optgroup>` +
        `</select>`,
      () => adapter.choiceForm('b1'),
      { alpha: ALPHA, beta: BETA }
    )
    expect(html).toContain('<optgroup label="More">')
    expect(html).toContain('<option value="b1" selected>B1</option>')
  })
})
