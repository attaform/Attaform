// @vitest-environment jsdom
/**
 * Names that leave the type system, and the symbols they have to match.
 *
 * Two surfaces reference runtime members by STRING, where nothing checks
 * the reference and nothing fails loudly when it stops resolving:
 *
 *  - **The compiler transforms.** `v-register-hint-transform` and
 *    `component-bridge-transform` emit source text calling
 *    `?.markConnectedOptimistically?.()`, `?.setValueFromHost?.($event)`
 *    and `?.findIndex?.()` on a `RegisterValue`. The optional call is
 *    what makes a rename dangerous rather than merely wrong: the emitted
 *    call evaluates to `undefined` and does nothing, so the connected
 *    flag is never set and a host component's writes are dropped, with
 *    no error anywhere.
 *  - **The devtools panel.** `dist/runtime/components/*.vue` is copied
 *    raw by mkdist and compiled by the CONSUMER, so it is outside every
 *    build this repo runs. It reads `forms`, `errorCells`,
 *    `setValueAtPath` and `onFormChange` off a live `FormStore`.
 *
 * Both are read out of the source here and checked against the real
 * objects, so a rename fails at test time rather than in a consumer's
 * browser. This is the gate that makes renaming those members safe,
 * including, but not only, renaming them for a minifier.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp, defineComponent, h } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'
import { useRegistry } from '../../src/runtime/core/registry'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8')

const TRANSFORM_SOURCES = [
  'src/runtime/lib/core/transforms/v-register-hint-transform.ts',
  'src/runtime/lib/core/transforms/component-bridge-transform.ts',
]

/**
 * Every `?.name?.(` an emitted string calls. Read from the source rather
 * than listed, so a transform that starts calling a new member is
 * covered the day it is written.
 */
function emittedOptionalCalls(): string[] {
  const found = new Set<string>()
  for (const rel of TRANSFORM_SOURCES) {
    for (const m of read(rel).matchAll(/\?\.([A-Za-z_][A-Za-z0-9_]*)\?\.\(/g)) {
      const name = m[1]
      if (name !== undefined) found.add(name)
    }
  }
  return [...found].sort()
}

/** Property reads the devtools panel performs against a `FormStore`. */
function devtoolsStoreReads(): string[] {
  const source = read('src/runtime/components/AttaformDevtoolsPanel.vue')
  const found = new Set<string>()
  for (const m of source.matchAll(/\bform\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = m[1]
    if (name !== undefined) found.add(name)
  }
  return [...found].sort()
}

function mountProbe(): { rv: Record<string, unknown>; store: Record<string, unknown> } {
  const schema = z.object({ email: z.string(), rows: z.array(z.object({ n: z.number() })) })
  let rv: unknown
  let store: unknown
  const App = defineComponent({
    setup() {
      const form = useForm({
        schema,
        key: 'boundary-probe',
        defaultValues: { email: '', rows: [] },
      })
      rv = form.register('email')
      store = useRegistry().forms.get('boundary-probe')
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.config.warnHandler = () => {}
  app.mount(document.createElement('div'))
  return { rv: rv as Record<string, unknown>, store: store as Record<string, unknown> }
}

describe('names the compiler transforms emit as text still resolve', () => {
  it('finds the calls to check, so the gate cannot pass vacuously', () => {
    const calls = emittedOptionalCalls()
    expect(calls.length).toBeGreaterThanOrEqual(3)
    expect(calls).toContain('markConnectedOptimistically')
    expect(calls).toContain('setValueFromHost')
  })

  it('every emitted optional call names a real member of the object it targets', () => {
    const { rv } = mountProbe()
    // `findIndex` is called on an array the emitted code builds, not on
    // the RegisterValue; check it against `Array.prototype` for the same
    // reason: a rename there is not ours to make, but a typo is.
    const missing = emittedOptionalCalls().filter((name) => {
      if (name in rv) return false
      return !(name in Array.prototype)
    })
    expect(missing, `emitted calls that no longer resolve: ${missing.join(', ')}`).toEqual([])
  })
})

describe('names the devtools panel reads still resolve', () => {
  it('finds the reads to check, so the gate cannot pass vacuously', () => {
    const reads = devtoolsStoreReads()
    expect(reads.length).toBeGreaterThanOrEqual(8)
    expect(reads).toContain('errorCells')
    expect(reads).toContain('setValueAtPath')
  })

  it('every store member the panel reads exists on a real FormStore', () => {
    const { store } = mountProbe()
    // `form.value` and `form.change` are reads THROUGH a member
    // (`store.form.value`) or a local, not members of the store itself.
    const throughMembers = new Set(['value', 'change'])
    const missing = devtoolsStoreReads().filter(
      (name) => !throughMembers.has(name) && !(name in store)
    )
    expect(
      missing,
      `devtools panel reads members the store no longer has: ${missing.join(', ')}`
    ).toEqual([])
  })

  it('the panel is shipped raw, which is why this gate exists', () => {
    // mkdist copies `.vue` through untransformed and the consumer's own
    // build compiles it, so no build in this repo would notice a break.
    const pkg = JSON.parse(read('package.json')) as {
      files?: string[]
    }
    expect(pkg.files?.some((entry) => entry.includes('dist'))).toBe(true)
  })
})
