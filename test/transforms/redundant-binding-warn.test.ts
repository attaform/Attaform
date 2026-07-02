import { baseCompile } from '@vue/compiler-core'
import { describe, expect, it, vi } from 'vitest'
import { componentBridgeTransform } from '../../src/runtime/lib/core/transforms/component-bridge-transform'
import { inputTextAreaNodeTransform } from '../../src/runtime/lib/core/transforms/input-text-area-transform'
import { redundantBindingWarnTransform } from '../../src/runtime/lib/core/transforms/redundant-binding-warn-transform'
import { vRegisterHintTransform } from '../../src/runtime/lib/core/transforms/v-register-hint-transform'
import { vRegisterPreambleTransform } from '../../src/runtime/lib/core/transforms/v-register-preamble-transform'

/**
 * The compile-time half of the #464 redundant-binding guard. Compile a
 * template through @vue/compiler-core with the transform registered and
 * capture the `console.warn` output (the diagnostic channel — the Vue
 * compiler gives transforms no onWarn hook).
 */

// The transforms in the exact production order attaform/vite installs
// them. redundantBindingWarnTransform runs FIRST, before the two that
// strip/inject the value channel — the ordering this suite locks in.
const FULL_PIPELINE = [
  redundantBindingWarnTransform,
  componentBridgeTransform,
  inputTextAreaNodeTransform,
  vRegisterPreambleTransform,
  vRegisterHintTransform,
]

function redundantWarnsFor(
  template: string,
  transforms: typeof FULL_PIPELINE | [typeof redundantBindingWarnTransform] = [
    redundantBindingWarnTransform,
  ]
): string[] {
  const warns: string[] = []
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(args.map((a) => String(a)).join(' '))
  })
  try {
    baseCompile(template, { nodeTransforms: [...transforms], mode: 'module' })
  } finally {
    spy.mockRestore()
  }
  return warns.filter((w) => w.includes('redundant beside v-register'))
}

function compile(template: string): string {
  return baseCompile(template, { nodeTransforms: [redundantBindingWarnTransform], mode: 'module' })
    .code
}

describe('redundantBindingWarnTransform — state bindings warn', () => {
  it('warns on a text input with :value', () => {
    const warns = redundantWarnsFor(`<input v-register="reg" :value="x" />`)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain(':value')
    expect(warns[0]).toContain('<input>')
  })

  it('warns on a text input with a static value= attribute', () => {
    const warns = redundantWarnsFor(`<input v-register="reg" value="hi" />`)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('value')
  })

  it('warns on a text input with v-model', () => {
    const warns = redundantWarnsFor(`<input v-register="reg" v-model="x" />`)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('v-model')
  })

  it('warns on a textarea with :value', () => {
    const warns = redundantWarnsFor(`<textarea v-register="reg" :value="x" />`)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('<textarea>')
  })

  it('warns on a checkbox with :checked', () => {
    const warns = redundantWarnsFor(`<input type="checkbox" v-register="reg" :checked="x" />`)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain(':checked')
  })

  it('warns on a radio with :checked', () => {
    const warns = redundantWarnsFor(`<input type="radio" v-register="reg" :checked="x" />`)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain(':checked')
  })

  it('warns on a select with :value', () => {
    const warns = redundantWarnsFor(
      `<select v-register="reg" :value="x"><option value="a">A</option></select>`
    )
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('<select>')
  })

  it('warns on a select with v-model', () => {
    const warns = redundantWarnsFor(
      `<select v-register="reg" v-model="x"><option value="a">A</option></select>`
    )
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('v-model')
  })

  it('warns on an <option :selected> inside a v-register-d select', () => {
    const warns = redundantWarnsFor(
      `<select v-register="reg"><option :value="o" :selected="s">A</option></select>`
    )
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain(':selected')
    expect(warns[0]).toContain('<option>')
  })

  it('warns on a static <option selected> inside a v-register-d select', () => {
    const warns = redundantWarnsFor(
      `<select v-register="reg"><option value="a" selected>A</option></select>`
    )
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('selected')
  })

  it('warns on an <option :selected> nested under v-for', () => {
    const warns = redundantWarnsFor(
      `<select v-register="reg"><option v-for="o in opts" :value="o" :selected="o === sel">{{ o }}</option></select>`
    )
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain(':selected')
  })
})

describe('redundantBindingWarnTransform — identity carve-out stays silent', () => {
  it('is silent on a radio with :value (radio identity)', () => {
    expect(redundantWarnsFor(`<input type="radio" v-register="reg" :value="opt" />`)).toHaveLength(
      0
    )
  })

  it('is silent on a radio with a static value= (radio identity)', () => {
    expect(redundantWarnsFor(`<input type="radio" v-register="reg" value="opt" />`)).toHaveLength(0)
  })

  it('is silent on a checkbox with :value (member identity)', () => {
    expect(
      redundantWarnsFor(`<input type="checkbox" v-register="reg" :value="opt" />`)
    ).toHaveLength(0)
  })

  it('is silent on an <option :value> (option identity)', () => {
    expect(
      redundantWarnsFor(`<select v-register="reg"><option :value="o">X</option></select>`)
    ).toHaveLength(0)
  })

  it('is silent on a static <option value="x"> (option identity)', () => {
    expect(
      redundantWarnsFor(`<select v-register="reg"><option value="x">X</option></select>`)
    ).toHaveLength(0)
  })

  it('is silent on a clean text input (no co-located binding)', () => {
    expect(redundantWarnsFor(`<input v-register="reg" />`)).toHaveLength(0)
  })

  it('is silent on a clean select', () => {
    expect(
      redundantWarnsFor(`<select v-register="reg"><option value="a">A</option></select>`)
    ).toHaveLength(0)
  })
})

describe('redundantBindingWarnTransform — classification edge cases', () => {
  it('skips a dynamic :type input (cannot classify at compile time)', () => {
    expect(redundantWarnsFor(`<input :type="kind" v-register="reg" :value="x" />`)).toHaveLength(0)
  })

  it('skips a file input (browser rejects value)', () => {
    expect(redundantWarnsFor(`<input type="file" v-register="reg" :value="x" />`)).toHaveLength(0)
  })

  it('ignores an element with no v-register', () => {
    expect(redundantWarnsFor(`<input :value="x" />`)).toHaveLength(0)
  })

  it('ignores a component host (:value is a legit prop channel there)', () => {
    expect(redundantWarnsFor(`<MyInput v-register="reg" :value="x" />`)).toHaveLength(0)
  })
})

describe('redundantBindingWarnTransform — marker stamping', () => {
  it('stamps the compile-active modifier on a native v-register', () => {
    expect(compile(`<input v-register="reg" />`)).toContain('attaformCompiled')
  })

  it('stamps the marker on a component host too (so the runtime stands down)', () => {
    expect(compile(`<MyInput v-register="reg" :value="x" />`)).toContain('attaformCompiled')
  })

  it('is idempotent — a doubly-applied pipeline warns once and stamps once', () => {
    const warns: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warns.push(args.map((a) => String(a)).join(' '))
    })
    try {
      // The same transform twice in the array simulates a doubly-registered
      // pipeline (test combinatorics / a re-run bundler config).
      baseCompile(`<input v-register="reg" :value="x" />`, {
        nodeTransforms: [redundantBindingWarnTransform, redundantBindingWarnTransform],
        mode: 'module',
      })
    } finally {
      spy.mockRestore()
    }
    expect(warns.filter((w) => w.includes('redundant beside v-register'))).toHaveLength(1)
  })
})

describe('redundantBindingWarnTransform — ordering / full pipeline (load-bearing)', () => {
  it('does NOT cry wolf on our own injected :value (clean input through the real pipeline)', () => {
    // inputTextAreaNodeTransform strips + injects :value on EVERY
    // v-register'd input. Because our transform runs FIRST, it sees the
    // authored props (none here) before the injection, so a clean input
    // must produce zero warnings even though the compiled output carries
    // an injected :value. This is the whole reason the ordering matters.
    expect(redundantWarnsFor(`<input v-register="reg" />`, FULL_PIPELINE)).toHaveLength(0)
  })

  it('warns exactly once on an authored :value through the real pipeline', () => {
    expect(redundantWarnsFor(`<input v-register="reg" :value="x" />`, FULL_PIPELINE)).toHaveLength(
      1
    )
  })

  it('warns once for a v-for of identical redundant inputs (one template node)', () => {
    // A v-for compiles the inner <input> to a single template node, so
    // the build-time warning fires once no matter the row count — the
    // clean "warn once for the pattern" story the runtime can't give a
    // non-plugin consumer.
    const warns = redundantWarnsFor(
      `<div v-for="i in 3" :key="i"><input v-register="reg" :value="i" /></div>`,
      FULL_PIPELINE
    )
    expect(warns).toHaveLength(1)
  })

  it('stays silent for a clean select with options through the real pipeline', () => {
    expect(
      redundantWarnsFor(
        `<select v-register="reg"><option value="a">A</option><option value="b">B</option></select>`,
        FULL_PIPELINE
      )
    ).toHaveLength(0)
  })
})
