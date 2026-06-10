/**
 * SSR per-field decomposition bench (P5): what does Attaform add to each
 * field's server render, and is any of it a bustable constant over the
 * O(F)-unavoidable floor (every field must emit its value + aria)?
 *
 * The directive emits field state into SSR markup through two hooks
 * (directive.ts `getSSRProps`), each O(1) per field:
 *
 *   form-state  getSSRFormStateProps   value / checked / selected emission.
 *               Type-dispatches on the vnode, then reads displayValue (text)
 *               or innerRef (checkbox/radio). Runtime (h() / withDirectives)
 *               path ONLY — compiled templates inject the binding at compile
 *               time, so this is the runtime-path UPPER BOUND on value cost.
 *   aria        getSSRAriaProps        aria-invalid / -describedby emission.
 *               Gated on ariaEnabled (autoAria); when on, reads
 *               ariaDisplayState.value — ONE display-engine recompute per
 *               field — then a fixed MANAGED_ARIA_ATTRS loop. Shared by BOTH
 *               SSR paths (compiled + runtime), so this is the dominant
 *               Attaform-added per-field SSR cost regardless of authoring style.
 *
 * FOUR CELLS isolate each layer (init + Vue's own F-input render cancel in the
 * deltas — they are identical across modes):
 *
 *   noreg            F inputs, NO register() and NO directive.
 *                    Floor: useForm init + Vue's plain SSR render only.
 *   plain            + register(autoAria:false) x F, NO directive applied.
 *                    noreg + the per-field register() cost (rv + computeds).
 *   register-noaria  + withDirectives(vRegister), autoAria:false.
 *                    plain + F x getSSRFormStateProps (aria short-circuits).
 *   register-aria    + withDirectives(vRegister), autoAria:true (the default).
 *                    register-noaria + F x getSSRAriaProps (display engine).
 *
 * DELTAS:
 *   plain - noreg            = per-field register() cost (adapter-dependent).
 *   register-noaria - plain  = per-field value-emission cost (runtime path).
 *   register-aria - register-noaria = per-field aria cost = lazy ariaDisplayState
 *                    creation + one display-engine recompute at render time.
 *   register-aria - noreg    = total Attaform per-field SSR cost (wire + emit).
 *
 * The display engine at SSR computes 'idle' for a fresh form (gate closed: no
 * submit, no blur), so it emits no aria-invalid — but it RUNS regardless, and
 * that run is the one reducible-looking slice. It is constrained: the server
 * aria must match the client's post-hydration output byte-for-byte, so skipping
 * the engine risks an SSR/hydration mismatch. See PERF-ANALYSIS.md "P5".
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { bench, describe } from 'vitest'
import { createSSRApp, defineComponent, h, withDirectives, type App } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../src/zod-v4'
import { useForm as useFormV3 } from '../src/zod-v3'
import { createAttaform } from '../src/runtime/core/plugin'
import { vRegister } from '../src/runtime/core/directive'
import { flat, type MatrixForm } from './lib/matrix-forms'

type Adapter = { tag: string; z: any; useForm: any }
const ADAPTERS: Adapter[] = [
  { tag: 'v4', z: zV4, useForm: useFormV4 },
  { tag: 'v3', z: zV3 as any, useForm: useFormV3 },
]

const FIELD_COUNTS = [5, 50, 500]
type Mode = 'noreg' | 'plain' | 'register-noaria' | 'register-aria'

// Distinct form key per built app so per-instance state never aliases.
let keySeq = 0

function buildSSRApp(adapter: Adapter, form: MatrixForm, mode: Mode): App {
  const paths = Object.keys(form.defaultValues)
  const aria = mode === 'register-aria'
  keySeq += 1
  const seq = keySeq
  const Root = defineComponent({
    setup() {
      const handle = adapter.useForm({
        schema: form.schema,
        key: `ssr-p5-${adapter.tag}-${paths.length}-${mode}-${seq}`,
        defaultValues: form.defaultValues,
        validateOn: 'submit',
      })
      // The 'noreg' floor skips register() entirely; every other mode wires
      // all F fields. Only the directive application (and autoAria) differs
      // above the register layer.
      const rvs = mode === 'noreg' ? null : paths.map((p) => handle.register(p, { autoAria: aria }))
      return () =>
        h(
          'form',
          null,
          paths.map((p, i) => {
            const input = h('input', { name: p, type: 'text' })
            if (rvs === null || mode === 'plain') return input
            return withDirectives(input, [[vRegister, rvs[i]]])
          })
        )
    },
  })
  const app = createSSRApp(Root)
  app.use(createAttaform({ ssr: true }))
  return app
}

describe('SSR per-field: emission cost decomposition (P5)', () => {
  for (const a of ADAPTERS) {
    for (const F of FIELD_COUNTS) {
      const form = flat(a.z, F)
      bench(`ssr noreg F=${F} [${a.tag}]`, async () => {
        await renderToString(buildSSRApp(a, form, 'noreg'))
      })
      bench(`ssr plain F=${F} [${a.tag}]`, async () => {
        await renderToString(buildSSRApp(a, form, 'plain'))
      })
      bench(`ssr register-noaria F=${F} [${a.tag}]`, async () => {
        await renderToString(buildSSRApp(a, form, 'register-noaria'))
      })
      bench(`ssr register-aria F=${F} [${a.tag}]`, async () => {
        await renderToString(buildSSRApp(a, form, 'register-aria'))
      })
    }
  }
})
