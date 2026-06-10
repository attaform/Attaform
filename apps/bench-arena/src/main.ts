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
  /**
   * Summary unit: milliseconds for timed dims, component renders for the
   * rerender dim, or DOM mutations for the rerender dim of a library that owns
   * its inputs (FormKit), where the driver falls back to a mutation proxy.
   */
  unit: 'ms' | 'renders' | 'dom-mutations'
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
const ARRAYOP_RUNS = 50

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

/** The rerender result plus which unit it is measured in. */
interface RerenderResult {
  summary: Summary
  unit: 'renders' | 'dom-mutations'
}

/**
 * Re-render scope per keystroke. For the bare-input cohort this is the count of
 * field components whose render function ran (Attaform ~ 1, an O(F) library up
 * to F). FormKit owns its inputs, so `getRenderCount` is null; the driver then
 * falls back to a DOM-mutation proxy: a MutationObserver over the mounted
 * subtree counts the attribute, child-list, and text mutations one keystroke
 * produces. That is a DIFFERENT unit, not a component-render count, and is
 * reported as such (the page caveats it, never placed numerically beside the
 * render counts), but it answers the same real question the grid scenario asks:
 * does editing one field churn DOM beyond that field?
 *
 * The proxy splits its count between the records the observer callback has
 * already received during the settle (`delivered`) and the records still queued
 * but undelivered (`takeRecords()`); the two sets are disjoint, so their sum is
 * the keystroke's full mutation count with no double counting.
 */
async function measureRerender(
  handle: MountHandle,
  shape: ScenarioShape,
  container: HTMLElement
): Promise<RerenderResult> {
  const fieldCount = shape.paths.length
  const renderCounts: number[] = []
  const mutationCounts: number[] = []
  let usesProxy = false

  let delivered = 0
  const observer = new MutationObserver((records) => {
    delivered += records.length
  })
  observer.observe(container, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  })

  for (let i = 0; i < RERENDER_RUNS; i++) {
    handle.resetRenderCount()
    observer.takeRecords()
    delivered = 0
    await handle.typeChar(i % fieldCount, `r${i}`)
    const count = handle.getRenderCount()
    if (count === null) {
      usesProxy = true
      mutationCounts.push(delivered + observer.takeRecords().length)
    } else {
      renderCounts.push(count)
    }
    await frame()
  }
  observer.disconnect()

  return usesProxy
    ? { summary: summarize(mutationCounts), unit: 'dom-mutations' }
    : { summary: summarize(renderCounts), unit: 'renders' }
}

/**
 * Add-a-row then remove-the-last (a size-stable rotation): the cost of the
 * library's array insert + delete at the scenario's row count, including the
 * reactive reflow of the rendered list. Size-stable so every sample starts from
 * the same N, and the appended row is valid so no error state churns.
 */
async function measureArrayAdd(handle: MountHandle): Promise<Summary> {
  for (let i = 0; i < 5; i++) {
    await handle.arrayOp('append')
    await handle.arrayOp('remove')
  }
  const samples: number[] = []
  for (let i = 0; i < ARRAYOP_RUNS; i++) {
    samples.push(
      await timed(async () => {
        await handle.arrayOp('append')
        await handle.arrayOp('remove')
      })
    )
    await frame()
  }
  return summarize(samples)
}

/**
 * Reorder: swap the first and last rows. An identity-keyed list moves the two
 * DOM nodes and rebinds them to their new positional paths; an index-keyed list
 * re-renders the two changed positions. Either way the cost is the library's
 * array swap plus the reactive settle. Each sample swaps back, so the array
 * alternates between two orderings of equal cost.
 */
async function measureArrayReorder(handle: MountHandle, shape: ScenarioShape): Promise<Summary> {
  // The swap exchanges two ROWS (array elements), so the index lives in row
  // space, not the flat input index. For a multi-column grid the input count
  // (paths.length) is rows x columns, so divide by the column count to recover
  // the row count; for a single-column array the two coincide.
  const cols = shape.arrayItemFields?.length ?? 1
  const rowCount = Math.floor(shape.paths.length / cols)
  const last = Math.max(0, rowCount - 1)
  for (let i = 0; i < 5; i++) await handle.arrayOp('swap', 0, last)
  const samples: number[] = []
  for (let i = 0; i < ARRAYOP_RUNS; i++) {
    samples.push(await timed(() => handle.arrayOp('swap', 0, last)))
    await frame()
  }
  return summarize(samples)
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
        const result = await measureRerender(handle, shape, container)
        return { ...base, unit: result.unit, summary: result.summary, supported: true }
      }
      case 'arrayAdd':
        return { ...base, unit: 'ms', summary: await measureArrayAdd(handle), supported: true }
      case 'arrayReorder':
        return {
          ...base,
          unit: 'ms',
          summary: await measureArrayReorder(handle, shape),
          supported: true,
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
