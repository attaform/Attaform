// @vitest-environment jsdom
//
// Behavior-lock harness: freezes Attaform's observable surface across the
// workload matrix so the runtime-performance busts (which target shared
// core) are provably behavior-preserving.
//
// Three layered locks per scenario:
//   1. Cross-adapter parity — the two independent implementations (zod v3
//      and v4) must produce the identical normalized surface, checkpoint
//      for checkpoint. Catches adapter-specific drift.
//   2. Named invariants — sanity that the script exercised real state
//      transitions (guards against a vacuous all-empty capture).
//   3. Golden master — freezes the full adapter-agnostic surface, catching
//      a shared-core change that moves BOTH adapters identically (which
//      parity alone cannot see). This is the load-bearing refactor lock.
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'
import { wait } from '../utils/form-harness'
import { captureForm, makeKeyNormalizer } from './capture'
import { assertGolden } from './golden'
import { SCENARIOS, type DriveForm, type Scenario } from './scenarios'

/* eslint-disable @typescript-eslint/no-explicit-any */
const ADAPTERS = [
  { name: 'zod-v4', z: zV4 as any, useForm: useFormV4 as any },
  { name: 'zod-v3', z: zV3 as any, useForm: useFormV3 as any },
] as const

type Checkpoint = { label: string; capture: Record<string, unknown> }

async function runScenario(
  adapter: { name: string; z: any; useForm: any },
  scenario: Scenario
): Promise<{ app: App; checkpoints: Checkpoint[] }> {
  const schema = scenario.makeSchema(adapter.z)
  const handle: { api?: any } = {}
  const App = defineComponent({
    setup() {
      handle.api = adapter.useForm({
        schema,
        // Random suffix per mount: matches repo convention and dodges any
        // key-keyed store caching. The key is not captured (redacted), so
        // it does not affect parity or the golden.
        key: `perf-lock-${scenario.id}-${adapter.name}-${Math.random().toString(36).slice(2)}`,
        defaultValues: scenario.defaultValues,
      })
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.mount(document.createElement('div'))

  const form = handle.api as DriveForm & { activate?: () => Promise<void> }
  // Forms are lazy-by-default; apply defaults before the first checkpoint.
  await form.activate?.()
  await wait(20)
  await nextTick()
  await nextTick()

  const checkpoints: Checkpoint[] = []
  const normalizeKey = makeKeyNormalizer()
  const snap = (label: string): void => {
    checkpoints.push({
      label,
      capture: captureForm(form, scenario.fieldPaths, scenario.arrays ?? [], normalizeKey),
    })
  }
  await scenario.drive(form, snap)
  return { app, checkpoints }
}

describe('behavior-lock — observable surface frozen across the matrix', () => {
  const mounted: App[] = []
  afterEach(() => {
    while (mounted.length > 0) mounted.pop()?.unmount()
    document.body.innerHTML = ''
  })

  for (const scenario of SCENARIOS) {
    it(`${scenario.id}: zod v3 / v4 parity + golden master`, async () => {
      const v4 = await runScenario(ADAPTERS[0], scenario)
      mounted.push(v4.app)
      const v3 = await runScenario(ADAPTERS[1], scenario)
      mounted.push(v3.app)

      // (1) Cross-adapter parity.
      expect(v3.checkpoints.map((c) => c.label)).toEqual(v4.checkpoints.map((c) => c.label))
      for (let i = 0; i < v4.checkpoints.length; i++) {
        expect(v3.checkpoints[i]?.capture).toEqual(v4.checkpoints[i]?.capture)
      }

      // (2) Named invariants — prove the script moved real state.
      const byLabel = new Map(v4.checkpoints.map((c) => [c.label, c.capture]))
      const initial = byLabel.get('initial') as any
      const afterReset = byLabel.get('after-reset') as any
      expect(initial).toBeDefined()
      expect(afterReset).toBeDefined()
      // reset restores the initial value surface.
      expect(afterReset.meta.value).toEqual(initial.meta.value)
      // when the script submits, the reveal gate must have fired.
      const afterSubmit = byLabel.get('after-submit') as any
      if (afterSubmit) {
        expect(afterSubmit.meta.submissionAttempts).toBeGreaterThan(0)
      }

      // (3) Golden master (v4 canonical; v3 proven equal in step 1).
      assertGolden(scenario.id, v4.checkpoints)
    })
  }
})
/* eslint-enable @typescript-eslint/no-explicit-any */
