import type {
  BenchAdapter,
  DimensionId,
  MountHandle,
  MountOpts,
  ScenarioId,
  ScenarioParams,
  TriggerMode,
} from './adapters/contract'
import { adapters } from './adapters/registry'
import { calibrate, frame, type Summary, summarize, timed } from './shared/clock'
import { shapeFor } from './shared/scenarios'
import type { ScenarioShape } from './shared/scenarios/types'

/**
 * The harness entry. It reads one (adapter, scenario, params, trigger,
 * dimension) cell from the URL, mounts that single adapter, runs the
 * dimension's protocol entirely in-page (only the final scalar summary crosses
 * the Playwright boundary), and signals completion via `body[data-bench-done]`.
 *
 *   /?adapter=attaform&scenario=flat&params=F50&trigger=input&dim=keystroke
 */

interface BenchPayload {
  adapter: string
  scenario: string
  params: ScenarioParams
  trigger: string
  dimension: string
  /** Summary unit: milliseconds for timed dims, component renders for rerender. */
  unit: 'ms' | 'renders'
  summary: Summary
  /** Machine-speed proxy so absolute numbers normalize across runners. */
  calibrationMs: number
  /** False when the library cannot express this scenario; summary is then zero. */
  supported: boolean
  error?: string
}

declare global {
  interface Window {
    __BENCH_RESULTS__?: BenchPayload
  }
}

const WARMUP = 30
const MEASURE = 200
const MOUNT_RUNS = 15
const VALIDATE_RUNS = 100
const RERENDER_RUNS = 30

const ZERO: Summary = { median: 0, p95: 0, iqr: 0, count: 0, trimmed: 0 }

// Compact param labels (F50, D8, N1000, ...) decode to the scenario knobs.
const CODE_TO_KEY: Record<string, string> = { F: 'fields', D: 'depth', N: 'rows', M: 'cols' }

function parseParams(label: string): ScenarioParams {
  const out: Record<string, number> = {}
  const re = /([A-Za-z]+)(\d+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(label)) !== null) {
    const code = match[1] ?? ''
    out[CODE_TO_KEY[code] ?? code.toLowerCase()] = Number(match[2])
  }
  return out
}

interface Query {
  adapter: string
  scenario: ScenarioId
  paramsLabel: string
  params: ScenarioParams
  trigger: TriggerMode
  dim: DimensionId
  seed: number
}

function readQuery(): Query {
  const p = new URLSearchParams(window.location.search)
  const paramsLabel = p.get('params') ?? 'F10'
  return {
    adapter: p.get('adapter') ?? 'attaform',
    scenario: (p.get('scenario') ?? 'flat') as ScenarioId,
    paramsLabel,
    params: parseParams(paramsLabel),
    trigger: (p.get('trigger') ?? 'input') as TriggerMode,
    dim: (p.get('dim') ?? 'keystroke') as DimensionId,
    seed: Number(p.get('seed') ?? '1'),
  }
}

function makeContainer(): HTMLElement {
  const host = document.getElementById('app') ?? document.body
  const el = document.createElement('div')
  host.appendChild(el)
  return el
}

/** Keystroke latency: warm up, then time MEASURE round-robin keystrokes. */
async function measureKeystroke(handle: MountHandle, shape: ScenarioShape): Promise<Summary> {
  const fieldCount = shape.paths.length
  for (let i = 0; i < WARMUP; i++) await handle.setFieldValue(i % fieldCount, `s${i}`)
  const samples: number[] = []
  for (let i = 0; i < MEASURE; i++) {
    const index = i % fieldCount
    samples.push(await timed(() => handle.typeChar(index, `s${WARMUP + i}`)))
    await frame()
  }
  return summarize(samples)
}

/** Full-form validation throughput. */
async function measureValidate(handle: MountHandle): Promise<Summary> {
  for (let i = 0; i < 5; i++) await handle.validateAll()
  const samples: number[] = []
  for (let i = 0; i < VALIDATE_RUNS; i++) {
    samples.push(await timed(() => handle.validateAll()))
    await frame()
  }
  return summarize(samples)
}

/** Components re-rendered per keystroke. Null render count => unsupported here. */
async function measureRerender(handle: MountHandle, shape: ScenarioShape): Promise<Summary | null> {
  const fieldCount = shape.paths.length
  const counts: number[] = []
  for (let i = 0; i < RERENDER_RUNS; i++) {
    handle.resetRenderCount()
    await handle.typeChar(i % fieldCount, `r${i}`)
    const count = handle.getRenderCount()
    if (count === null) return null
    counts.push(count)
    await frame()
  }
  return summarize(counts)
}

/** Mount/init cost over fresh mounts; the only dim that re-mounts per sample. */
async function measureMount(adapter: BenchAdapter, opts: MountOpts): Promise<Summary> {
  const samples: number[] = []
  for (let i = 0; i < MOUNT_RUNS; i++) {
    const container = makeContainer()
    let handle: MountHandle | undefined
    samples.push(
      await timed(async () => {
        handle = await adapter.mount(container, opts)
      })
    )
    handle?.teardown()
    container.remove()
    await frame()
  }
  return summarize(samples)
}

async function run(): Promise<BenchPayload> {
  const q = readQuery()
  const adapter = adapters[q.adapter]
  if (!adapter) throw new Error(`bench: unknown adapter "${q.adapter}"`)

  const shape = shapeFor(q.scenario, q.params)
  const opts: MountOpts = {
    scenario: q.scenario,
    params: q.params,
    trigger: q.trigger,
    seed: q.seed,
  }
  const calibrationMs = calibrate()

  const base = {
    adapter: q.adapter,
    scenario: q.scenario,
    params: q.params,
    trigger: q.trigger,
    dimension: q.dim,
    calibrationMs,
  }

  if (q.dim === 'mount') {
    return { ...base, unit: 'ms', summary: await measureMount(adapter, opts), supported: true }
  }

  const container = makeContainer()
  const handle = await adapter.mount(container, opts)
  try {
    switch (q.dim) {
      case 'keystroke':
        return {
          ...base,
          unit: 'ms',
          summary: await measureKeystroke(handle, shape),
          supported: true,
        }
      case 'validate':
        return { ...base, unit: 'ms', summary: await measureValidate(handle), supported: true }
      case 'rerender': {
        const summary = await measureRerender(handle, shape)
        return summary === null
          ? { ...base, unit: 'renders', summary: ZERO, supported: false }
          : { ...base, unit: 'renders', summary, supported: true }
      }
      default:
        throw new Error(`bench: dimension "${q.dim}" is not implemented yet`)
    }
  } finally {
    handle.teardown()
    container.remove()
  }
}

run()
  .then((payload) => {
    window.__BENCH_RESULTS__ = payload
  })
  .catch((err: unknown) => {
    const q = readQuery()
    window.__BENCH_RESULTS__ = {
      adapter: q.adapter,
      scenario: q.scenario,
      params: q.params,
      trigger: q.trigger,
      dimension: q.dim,
      unit: 'ms',
      summary: ZERO,
      calibrationMs: 0,
      supported: false,
      error: err instanceof Error ? err.message : String(err),
    }
  })
  .finally(() => {
    document.body.dataset['benchDone'] = '1'
  })
