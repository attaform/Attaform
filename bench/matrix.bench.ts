/**
 * Runtime-performance matrix bench: absolute baselines across the scaling
 * axes the complexity ledger flags as blockers. Unlike the `old:`/`new:`
 * micro-benches (gated by scripts/check-bench.mjs at a 3x floor), these report
 * ABSOLUTE ops/sec per cell, so the dashboard can track drift and the
 * profiling pass can read the SCALING SLOPE to confirm or refute predictions:
 *
 *   init flat F={5,50,500}     -> T3 double-parse [BUSTED], O(F.D)? (+ T6 v3 vs v4)
 *   keystroke deep D={3,8,16}  -> T1 guard, O(D^2) with zero unions?
 *   keystroke flat F={5,50,500}
 *     & wideArray N={10,100,1000} -> T2 full-tree diff, O(F)?
 *   validate refined F={5,50,500} -> T4 whole-form parse forced by a container
 *     refine on every keystroke, O(F)? (component probe, both adapters)
 *
 * Mounting follows discriminated-union.bench.ts: a real public `useForm`
 * inside an SSR app, so we measure the genuine consumer pipeline (real zod,
 * both adapters). The render tree is a constant `h('div')`, so Vue's mount
 * cost is ~flat across schema size and the init slope is Attaform's own
 * schema work.
 *
 * Keystroke benches use `validateOn: 'submit'` to isolate the STRUCTURAL
 * write cost (diff + guard, i.e. T1/T2). The default 'change' mode would
 * queue a setTimeout per write that never flushes inside the tight bench
 * loop, accumulating timers and skewing later iterations; validation timing
 * gets its own bench once the structural picture is clear. The write path is
 * adapter-independent when no union is touched, so the keystroke sweeps run
 * on v4 alone; init runs both adapters (parse cost is where T6 lives).
 *
 * Bust 2 (targeted in-place apply) BUSTED T2: the `keystroke flat` and
 * `keystroke array` sweeps are now ~FLAT in F / N (a single write is O(depth),
 * not O(field-count) / O(array-length)). A re-introduced slope on those groups
 * is a regression. `keystroke deep` stays O(D) by design. See PERF-ANALYSIS.md
 * "Bust 2" and test/core/reactivity-contract.test.ts (the behavioral lock).
 *
 * Bust 3 (single-pass authored-path derivation) BUSTED T3: init no longer runs a
 * second full `getDefaultValues` pass to diff for authored-default paths. `init
 * flat` v4 gained ~26-35% and the v4/v3 init gap narrowed (T6-adjacent); v3 is flat
 * within noise. A re-introduced second full pass on init is a regression. See
 * PERF-ANALYSIS.md "Bust 3" and test/core/authored-baseline-equivalence.test.ts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { bench, describe } from 'vitest'
import { createSSRApp, defineComponent, h, type App } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4, unset } from '../src/zod-v4'
import { useForm as useFormV3 } from '../src/zod-v3'
import { zodAdapter as zodV4Adapter } from '../src/runtime/adapters/zod-v4'
import { zodAdapter as zodV3Adapter } from '../src/runtime/adapters/zod-v3'
import { createAttaform } from '../src/runtime/core/plugin'
import { deep, flat, flatRefined, wideArray, type MatrixForm } from './lib/matrix-forms'

type Adapter = { tag: string; z: any; useForm: any }
const ADAPTERS: Adapter[] = [
  { tag: 'v4', z: zV4, useForm: useFormV4 },
  { tag: 'v3', z: zV3 as any, useForm: useFormV3 },
]

function buildApp(useForm: any, form: MatrixForm): { app: App; getHandle: () => any } {
  let handle: any
  const Root = defineComponent({
    setup() {
      handle = useForm({
        schema: form.schema,
        key: `matrix-${Math.random().toString(36).slice(2)}`,
        defaultValues: form.defaultValues,
        validateOn: 'submit',
      })
      return () => h('div')
    },
  })
  const app = createSSRApp(Root)
  app.use(createAttaform({ ssr: true }))
  return { app, getHandle: () => handle }
}

/** Full cold construction: awaits the SSR render so init has fully run. */
async function mountAsync(useForm: any, form: MatrixForm): Promise<any> {
  const { app, getHandle } = buildApp(useForm, form)
  await renderToString(app)
  return getHandle()
}

/** Synchronous mount: setup (where init happens) runs during render invoke. */
function mountSync(useForm: any, form: MatrixForm): any {
  const { app, getHandle } = buildApp(useForm, form)
  void renderToString(app)
  const handle = getHandle()
  if (handle === undefined) throw new Error('useForm setup did not run')
  return handle
}

const FIELD_COUNTS = [5, 50, 500]
const DEPTHS = [3, 8, 16]
const ARRAY_ROWS = [10, 100, 1000]

describe('init: cold form construction', () => {
  for (const F of FIELD_COUNTS) {
    for (const a of ADAPTERS) {
      const form = flat(a.z, F)
      bench(`init flat F=${F} [${a.tag}]`, async () => {
        await mountAsync(a.useForm, form)
      })
    }
  }
})

describe('keystroke: single scalar write, flat (T2 diff vs F)', () => {
  for (const F of FIELD_COUNTS) {
    const form = flat(zV4, F)
    const handle = mountSync(useFormV4, form)
    handle.setValue(form.keystrokePath, form.keystrokeValue(0)) // prime the path
    let i = 1
    bench(`keystroke flat F=${F} [v4]`, () => {
      handle.setValue(form.keystrokePath, form.keystrokeValue(i++))
    })
  }
})

describe('keystroke: scalar write into a mostly-BLANK flat form (blank-sweep vs F)', () => {
  // Distinct from the defaulted flat sweep above. Provided defaults are NOT
  // blank-marked (schema-default-no-autoblank), so that form has an empty
  // blankPaths and never exercises the descendant sweep. Here every field is
  // explicitly unset, so blankPaths holds ~F entries: the representative
  // fresh-form keystroke, and the case the blank-sweep gate targets.
  for (const F of FIELD_COUNTS) {
    const form = flat(zV4, F)
    const handle = mountSync(useFormV4, form)
    for (let k = 0; k < F; k++) handle.setValue(`f${k}`, unset) // mark all blank
    handle.setValue('f0', 'v0') // prime f0 (now non-blank; f1..f{F-1} stay blank)
    let i = 1
    bench(`keystroke blank-flat F=${F} [v4]`, () => {
      handle.setValue('f0', `v${i++}`)
    })
  }
})

describe('keystroke: deep-leaf write (T1 guard vs D, zero unions)', () => {
  for (const D of DEPTHS) {
    const form = deep(zV4, D)
    const handle = mountSync(useFormV4, form)
    handle.setValue(form.keystrokePath, form.keystrokeValue(0))
    let i = 1
    bench(`keystroke deep D=${D} [v4]`, () => {
      handle.setValue(form.keystrokePath, form.keystrokeValue(i++))
    })
  }
})

describe('keystroke: row-field write, wide array (T2 diff vs N)', () => {
  for (const N of ARRAY_ROWS) {
    const form = wideArray(zV4, N)
    const handle = mountSync(useFormV4, form)
    handle.setValue(form.keystrokePath, form.keystrokeValue(0))
    let i = 1
    bench(`keystroke array N=${N} [v4]`, () => {
      handle.setValue(form.keystrokePath, form.keystrokeValue(i++))
    })
  }
})

/**
 * T4 — the per-keystroke validation cost a CONTAINER/ROOT REFINE forces. When
 * `hasContainerOrRootRefine()` is true the scheduler cannot subtree-scope
 * (create-form-store.ts:2651): every keystroke runs a whole-form parse
 * (`validateAtPath(form.value, undefined)`), re-validating every unchanged
 * sibling leaf's own constraints. The refine itself genuinely MUST re-run
 * (its verdict depends on any field) — the bustable waste is the sibling
 * re-parse.
 *
 * This is a COMPONENT probe on the exact primitive the scheduler calls, NOT
 * an end-to-end keystroke loop. The scheduler runs `validateAtPath` inside a
 * microtask chain (`Promise.resolve().then(...)`); a tight synchronous bench
 * loop would never flush those microtasks (the same skew the `validateOn:
 * 'submit'` note above avoids), so we time `validateAtPath` directly — the
 * Bust-3 component-probe discipline. The default async path is awaited, so a
 * constant await/microtask cost rides each cell; read the SLOPE vs F (it
 * compresses small F), not the small-F absolutes.
 *
 * Three cells decompose the cost (per adapter — validation parse is exactly
 * where the v4/v3 asymmetry T6 lives, so unlike the write sweeps this is NOT
 * adapter-independent):
 *
 *   whole-form refined -> T4 today: F leaf-parses + the refine
 *   whole-form plain   -> F leaf-parses, no refine; refine's marginal cost
 *                         = refined - plain
 *   subtree-leaf       -> the floor a refine-free form's subtree pass pays
 *                         (1 leaf-parse); redundant-sibling prize = plain - subtree
 *
 * A re-introduced subtree scope under a refine (or a flattened whole-form
 * slope) would show here. See PERF-ANALYSIS.md "T4".
 */
type RefineAdapter = { tag: string; z: any; build: any }
const REFINE_ADAPTERS: RefineAdapter[] = [
  { tag: 'v4', z: zV4, build: zodV4Adapter },
  { tag: 'v3', z: zV3 as any, build: zodV3Adapter },
]

describe('validate: whole-form parse forced by a container refine (T4 vs F)', () => {
  for (const a of REFINE_ADAPTERS) {
    for (const F of FIELD_COUNTS) {
      const refined = flatRefined(a.z, F)
      const plain = flat(a.z, F)
      const builtRefined = a.build(refined.schema)('t4-refined-probe', { maxRecursionDepth: 64 })
      const builtPlain = a.build(plain.schema)('t4-plain-probe', { maxRecursionDepth: 64 })

      // Premise guards: the refined shape MUST trip the whole-form branch and
      // the plain shape MUST NOT, on BOTH adapters — otherwise the cells below
      // silently measure the wrong scheduler path.
      if (builtRefined.hasContainerOrRootRefine() !== true)
        throw new Error(`flatRefined must trip hasContainerOrRootRefine [${a.tag} F=${F}]`)
      if (builtPlain.hasContainerOrRootRefine() !== false)
        throw new Error(`flat must not trip hasContainerOrRootRefine [${a.tag} F=${F}]`)

      const wholeRefined = refined.defaultValues
      const wholePlain = plain.defaultValues
      // The subtree floor is measured on the PLAIN schema: the scheduler's
      // subtree branch only ever runs when no refine is present, and path
      // resolution to the leaf is unambiguous there.
      const leafPath = [plain.keystrokePath]
      const leafValue = plain.defaultValues[plain.keystrokePath]

      bench(`t4 whole-form refined F=${F} [${a.tag}]`, async () => {
        await builtRefined.validateAtPath(wholeRefined, undefined)
      })
      bench(`t4 whole-form plain F=${F} [${a.tag}]`, async () => {
        await builtPlain.validateAtPath(wholePlain, undefined)
      })
      bench(`t4 subtree-leaf F=${F} [${a.tag}]`, async () => {
        await builtPlain.validateAtPath(leafValue, leafPath)
      })
    }
  }
})
