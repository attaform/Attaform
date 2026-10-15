// @vitest-environment jsdom
//
// Behavior-lock harness: freezes Attaform's observable surface across the
// workload matrix so the runtime-performance busts (which target shared
// core) are provably behavior-preserving.
//
// Three layered locks per scenario:
//   1. Cross-adapter parity: the two independent implementations (zod v3
//      and v4) must produce the identical normalized surface, checkpoint
//      for checkpoint. Catches adapter-specific drift.
//   2. Named invariants, sanity that the script exercised real state
//      transitions (guards against a vacuous all-empty capture).
//   3. Golden master, freezes the full adapter-agnostic surface, catching
//      a shared-core change that moves BOTH adapters identically (which
//      parity alone cannot see). This is the load-bearing refactor lock.
//
// The first-read mode runs the same three locks over the frame a form
// mounts on: it snaps synchronously right after `app.mount`, before any
// activation or settling, then settles and snaps again. Its captures add
// the per-path error channels and the `firstValidationDone` gate, so a
// change to WHEN construction's verdict lands, not only to what it says,
// fails here. Where zod v3 legitimately differs at a checkpoint, the
// scenario names why and the golden pins v3's differing values.
import { renderToString } from '@vue/server-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, createSSRApp, defineComponent, h, nextTick, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'
import { getRegistryFromApp } from '../../src/runtime/core/registry'
import { hydrateAttaformState, renderAttaformState } from '../../src/runtime/core/serialize'
import { wait } from '../utils/form-harness'
import { captureErrorChannels, captureForm, makeKeyNormalizer, type StoreLike } from './capture'
import { assertGolden, divergence } from './golden'
import {
  FIRST_READ_SCENARIOS,
  SCENARIOS,
  settle,
  type DriveForm,
  type FirstReadScenario,
  type Scenario,
} from './scenarios'

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

describe('behavior-lock: observable surface frozen across the matrix', () => {
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

      // (2) Named invariants, prove the script moved real state.
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

type Adapter = (typeof ADAPTERS)[number]

/** The store behind `key`, read through the app's registry. */
function storeOf(app: App, key: string): StoreLike {
  const store = getRegistryFromApp(app).forms.get(key)
  if (store === undefined) throw new Error(`[behavior-lock] no store under "${key}"`)
  return store
}

/**
 * Mount `scenario` and snap its first read. `ssr-round-trip` builds the form
 * on a server app first and mounts a hydrating client under the same fixed
 * key; every other scenario mounts a plain client under a fresh key.
 */
async function runFirstReadScenario(
  adapter: Adapter,
  scenario: FirstReadScenario
): Promise<{ apps: App[]; checkpoints: Checkpoint[]; firstReadSchemaErrors: number }> {
  const schema = scenario.makeSchema(adapter.z)
  const optionsFor = (key: string): Record<string, unknown> => ({
    schema,
    key,
    ...(scenario.defaultValues === undefined ? {} : { defaultValues: scenario.defaultValues }),
    ...scenario.extraOptions?.(),
  })
  const apps: App[] = []
  const handle: { api?: any } = {}
  const ClientApp = (key: string) =>
    defineComponent({
      setup() {
        handle.api = adapter.useForm(optionsFor(key))
        return () => h('div')
      },
    })

  let key: string
  let app: App
  if (scenario.mount === 'ssr-round-trip') {
    key = `perf-lock-${scenario.id}-${adapter.name}`
    const ServerApp = defineComponent({
      setup() {
        const api = adapter.useForm(optionsFor(key))
        scenario.serverSetup?.(api)
        return () => h('div')
      },
    })
    const server = createSSRApp(ServerApp).use(createAttaform({ ssr: true }))
    const html = await renderToString(server)
    const payload = JSON.parse(JSON.stringify(renderAttaformState(server)))
    app = createSSRApp(ClientApp(key)).use(createAttaform())
    hydrateAttaformState(app, payload)
    const container = document.createElement('div')
    container.innerHTML = html
    app.mount(container)
  } else {
    key = `perf-lock-${scenario.id}-${adapter.name}-${Math.random().toString(36).slice(2)}`
    app = createApp(ClientApp(key)).use(createAttaform())
    app.mount(document.createElement('div'))
  }
  apps.push(app)

  const form = handle.api as DriveForm & { activate?: () => Promise<void> }
  const store = storeOf(app, key)
  const checkpoints: Checkpoint[] = []
  const normalizeKey = makeKeyNormalizer()
  const snap = (label: string): void => {
    checkpoints.push({
      label,
      capture: captureForm(form, scenario.fieldPaths, scenario.arrays ?? [], normalizeKey, store),
    })
  }

  // Nothing between mount and this snap but the scenario's own writes: no
  // activation, no timer, no tick.
  scenario.beforeFirstRead?.(form)
  snap('first-read')
  let firstReadSchemaErrors = 0
  for (const cell of store.errorCells.values()) firstReadSchemaErrors += cell.schema.length
  await form.activate?.()
  await settle()
  snap('settled')
  await scenario.afterSettled?.(form, snap)
  return { apps, checkpoints, firstReadSchemaErrors }
}

/** The three wizard steps: a valid sync refine, a failing check, an async refine. */
const WIZARD_STEPS = ['a', 'b', 'c'] as const

/**
 * A three-step `useWizard` whose step rail reads every step's status at t=0,
 * the way a stepper renders on mount. Snaps `statuses`, `progress` and
 * `complete` first, then each step form's error channels and gate.
 */
async function runWizardFirstRead(
  adapter: Adapter
): Promise<{ apps: App[]; checkpoints: Checkpoint[] }> {
  const z = adapter.z
  const suffix = `${adapter.name}-${Math.random().toString(36).slice(2)}`
  const keyOf = (step: string): string => `perf-lock-t0-wizard-${step}-${suffix}`
  const configs = {
    a: {
      schema: z.object({
        title: z.string().refine((v: string) => v.length > 0, { message: 'required' }),
      }),
      defaultValues: { title: 'ok' },
    },
    b: { schema: z.object({ age: z.number().min(18) }), defaultValues: { age: 0 } },
    c: {
      schema: z.object({
        handle: z
          .string()
          .refine(async (v: string) => Promise.resolve(v.length > 2), { message: 'short' }),
      }),
      defaultValues: { handle: 'abc' },
    },
  }
  const handle: { wizard?: any } = {}
  const App = defineComponent({
    setup() {
      const forms = WIZARD_STEPS.map((step) =>
        adapter.useForm({ ...configs[step], key: keyOf(step) })
      )
      handle.wizard = useWizard({ steps: forms, restore: false, persist: false })
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.mount(document.createElement('div'))

  const wizard = handle.wizard
  const checkpoints: Checkpoint[] = []
  const snap = (label: string): void => {
    const statuses: Record<string, unknown> = {}
    for (const step of WIZARD_STEPS) {
      const status = wizard.statuses[keyOf(step)]
      statuses[step] = {
        valid: status.valid,
        dirty: status.dirty,
        submitted: status.submitted,
        errorCount: status.errorCount,
        locked: status.locked,
        gate: status.gate,
      }
    }
    const capture: Record<string, unknown> = {
      statuses,
      progress: wizard.progress,
      complete: wizard.complete,
    }
    const forms: Record<string, unknown> = {}
    for (const step of WIZARD_STEPS) {
      const store = storeOf(app, keyOf(step))
      forms[step] = {
        errorChannels: captureErrorChannels(store),
        firstValidationDone: store.firstValidationDone.value,
      }
    }
    capture['forms'] = forms
    checkpoints.push({ label, capture })
  }

  snap('first-read')
  await settle()
  snap('settled')
  return { apps: [app], checkpoints }
}

/**
 * Parity and golden for a first-read run. Without a declared divergence the
 * adapters must match exactly; with one, v3 must actually differ (a stale
 * declaration fails) and its differing values join the golden.
 */
function assertFirstReadLocks(
  id: string,
  v4: Checkpoint[],
  v3: Checkpoint[],
  declaredDivergence: string | undefined
): void {
  expect(v3.map((c) => c.label)).toEqual(v4.map((c) => c.label))
  const v3Divergence: Record<string, Record<string, unknown>> = {}
  for (let i = 0; i < v4.length; i++) {
    const v4Capture = v4[i]?.capture
    const v3Capture = v3[i]?.capture
    if (declaredDivergence === undefined) {
      expect(v3Capture).toEqual(v4Capture)
      continue
    }
    const delta = divergence(v4Capture, v3Capture)
    if (Object.keys(delta).length > 0) v3Divergence[v4[i]?.label ?? `#${i}`] = delta
  }
  if (declaredDivergence !== undefined) {
    expect(Object.keys(v3Divergence).length, `declared: ${declaredDivergence}`).toBeGreaterThan(0)
  }
  assertGolden(`${id}.first-read`, { checkpoints: v4, v3Divergence })
}

describe('behavior-lock: first synchronous read after mount', () => {
  const mounted: App[] = []
  afterEach(() => {
    while (mounted.length > 0) mounted.pop()?.unmount()
    document.body.innerHTML = ''
  })

  for (const scenario of FIRST_READ_SCENARIOS) {
    it(`${scenario.id}: first read, zod v3 / v4 parity + golden master`, async () => {
      const v4 = await runFirstReadScenario(ADAPTERS[0], scenario)
      mounted.push(...v4.apps)
      const v3 = await runFirstReadScenario(ADAPTERS[1], scenario)
      mounted.push(...v3.apps)

      // The first frame shows what the scenario says it shows, so a capture
      // that silently went empty cannot pass as a lock.
      expect(v4.checkpoints[0]?.label).toBe('first-read')
      if (scenario.firstReadSchemaErrors === 'some') {
        expect(v4.firstReadSchemaErrors).toBeGreaterThan(0)
      } else {
        expect(v4.firstReadSchemaErrors).toBe(0)
      }

      assertFirstReadLocks(scenario.id, v4.checkpoints, v3.checkpoints, scenario.v3Divergence)
    })
  }

  it('t0-wizard: step rail at first read, zod v3 / v4 parity + golden master', async () => {
    const v4 = await runWizardFirstRead(ADAPTERS[0])
    mounted.push(...v4.apps)
    const v3 = await runWizardFirstRead(ADAPTERS[1])
    mounted.push(...v3.apps)
    assertFirstReadLocks(
      't0-wizard',
      v4.checkpoints,
      v3.checkpoints,
      'v3 counts every .refine as possibly async, so step a starts gated and reads invalid until its post-mount pass'
    )
  })
})
/* eslint-enable @typescript-eslint/no-explicit-any */
