import type {
  AdapterMeta,
  BenchAdapter,
  DimensionId,
  MountHandle,
  MountOpts,
  ScenarioId,
  ScenarioParams,
  TriggerMode,
} from './adapters/contract'
import { adapters } from './adapters/registry'
import { calibrate, frame, settle, type Summary, summarize, timed } from './shared/clock'
import { shapeFor } from './shared/scenarios'
import type { ScenarioShape } from './shared/scenarios/types'

/**
 * The harness entry. It reads one (adapter, scenario, params, trigger,
 * dimension) cell from the URL, mounts that single adapter, runs the
 * dimension's protocol entirely in-page (only the final scalar summary crosses
 * the Playwright boundary), and signals completion via `body[data-bench-done]`.
 *
 *   /?adapter=attaform&scenario=flat&params=F50&trigger=input&dim=keystroke
 *
 * The memory dimension is the one exception: a precise heap reading is only
 * available through the privileged CDP protocol (driver-side), so for `memory`
 * the page installs `window.__BENCH_MEM__` mount/type/teardown hooks and the
 * driver brackets them with CDP garbage collection and heap reads. See
 * `setupMemoryHooks`.
 */

interface BenchPayload {
  adapter: string
  scenario: string
  params: ScenarioParams
  trigger: string
  dimension: string
  /**
   * Summary unit: milliseconds for timed dims, component renders for the
   * rerender dim, DOM mutations for the rerender dim of a library that owns its
   * inputs (FormKit), where the driver falls back to a mutation proxy, or bytes
   * for the memory dim (whose figures the driver fills in via CDP; the in-page
   * payload is a readiness placeholder).
   */
  unit: 'ms' | 'renders' | 'dom-mutations' | 'bytes'
  summary: Summary
  /** Machine-speed proxy so absolute numbers normalize across runners. */
  calibrationMs: number
  /** False when the library cannot express this scenario; summary is then zero. */
  supported: boolean
  error?: string
}

/**
 * The hooks the memory driver calls between its CDP heap reads. One `mount`
 * stands up a fresh form (held alive); `typeBurst` drives `burst` keystrokes
 * into it without an intervening collection (so the driver can read allocation
 * churn); `teardown` unmounts so the driver can read the post-teardown residual.
 * `cycles` and `burst` come from the sample plan, so the page stays the single
 * source for the counts.
 */
interface MemoryHooks {
  readonly cycles: number
  readonly burst: number
  mount(): Promise<void>
  typeBurst(): Promise<void>
  teardown(): Promise<void>
}

declare global {
  interface Window {
    __BENCH_RESULTS__?: BenchPayload
    __BENCH_MEM__?: MemoryHooks
    /**
     * Every adapter's static meta, exposed on the `?meta=1` page so the
     * orchestrator can build the capability matrix and display metadata from
     * the real built adapters (a single source of truth, never a hand-kept
     * copy). No adapter is mounted on this page; it only reads the registry.
     */
    __BENCH_META__?: readonly AdapterMeta[]
  }
}

/**
 * Per-cell sample counts. The massive scenario mounts thousands of inputs, so a
 * single fresh mount runs on the order of seconds for the heavier libraries; its
 * counts are trimmed (uniformly across the whole cohort, so the comparison stays
 * fair) to keep each cell inside the driver's per-cell time budget. Mount and
 * validation cost at that scale have low relative variance, so the smaller
 * median is still stable. Every other scenario keeps the full counts.
 */
interface SamplePlan {
  readonly warmup: number
  readonly measure: number
  readonly mountRuns: number
  readonly validateRuns: number
  readonly rerenderRuns: number
  readonly arrayOpRuns: number
  readonly variantFlipRuns: number
  readonly stepTransitionRuns: number
  readonly memoryRuns: number
}

const DEFAULT_PLAN: SamplePlan = {
  warmup: 30,
  measure: 200,
  mountRuns: 15,
  validateRuns: 100,
  rerenderRuns: 30,
  arrayOpRuns: 50,
  variantFlipRuns: 50,
  stepTransitionRuns: 50,
  // Memory cycles: each is a full mount, keystroke burst, and teardown bracketed
  // by CDP collections, so it costs more than a timed mount; the per-cycle heap
  // deltas have low relative variance, so a smaller count still yields a stable
  // median.
  memoryRuns: 12,
}

const MASSIVE_PLAN: SamplePlan = {
  warmup: 10,
  measure: 120,
  mountRuns: 7,
  // A single full-form validate at 5,000 leaves is seconds on the heaviest
  // library (TanStack, ~2.8s), so the run count stays low to keep the cell
  // inside its budget under runner variance; the median is stable regardless,
  // since a whole-form validate at this scale has low relative variance.
  validateRuns: 25,
  rerenderRuns: 30,
  arrayOpRuns: 50,
  variantFlipRuns: 50,
  stepTransitionRuns: 50,
  // Each memory cycle re-mounts thousands of inputs, so the count stays low to
  // keep the cell in budget; a many-thousand-leaf heap is large, so a few
  // cycles already give a stable median.
  memoryRuns: 5,
}

function planFor(scenario: ScenarioId): SamplePlan {
  return scenario === 'massive' ? MASSIVE_PLAN : DEFAULT_PLAN
}

const ZERO: Summary = { median: 0, p95: 0, iqr: 0, count: 0, trimmed: 0 }

/** Keystrokes the memory dimension drives per cycle to expose allocation churn. */
const MEMORY_BURST = 50

// Compact param labels (F50, D8, N1000, ...) decode to the scenario knobs.
const CODE_TO_KEY: Record<string, string> = {
  F: 'fields',
  D: 'depth',
  N: 'rows',
  M: 'cols',
  L: 'leaves',
  S: 'steps',
}

function parseParams(label: string): ScenarioParams {
  const out: Record<string, number> = {}
  const re = /([A-Za-z]+)(\d+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(label)) !== null) {
    const code = match[1] ?? ''
    // Only the fixed scenario knobs (F/D/N/M/L/S) are valid keys. A code
    // outside the allowlist is skipped rather than used as a property
    // name, so the URL `params` query can never write an arbitrary
    // property (CodeQL js/remote-property-injection).
    const key = CODE_TO_KEY[code]
    if (key === undefined) continue
    out[key] = Number(match[2])
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

/** Keystroke latency: warm up, then time `plan.measure` round-robin keystrokes. */
async function measureKeystroke(
  handle: MountHandle,
  shape: ScenarioShape,
  plan: SamplePlan
): Promise<Summary> {
  const fieldCount = shape.paths.length
  for (let i = 0; i < plan.warmup; i++) await handle.setFieldValue(i % fieldCount, `s${i}`)
  const samples: number[] = []
  for (let i = 0; i < plan.measure; i++) {
    const index = i % fieldCount
    samples.push(await timed(() => handle.typeChar(index, `s${plan.warmup + i}`)))
    await frame()
  }
  return summarize(samples)
}

/** Full-form validation throughput. */
async function measureValidate(handle: MountHandle, plan: SamplePlan): Promise<Summary> {
  for (let i = 0; i < 5; i++) await handle.validateAll()
  const samples: number[] = []
  for (let i = 0; i < plan.validateRuns; i++) {
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
  container: HTMLElement,
  plan: SamplePlan
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

  for (let i = 0; i < plan.rerenderRuns; i++) {
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
async function measureArrayAdd(handle: MountHandle, plan: SamplePlan): Promise<Summary> {
  for (let i = 0; i < 5; i++) {
    await handle.arrayOp('append')
    await handle.arrayOp('remove')
  }
  const samples: number[] = []
  for (let i = 0; i < plan.arrayOpRuns; i++) {
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
async function measureArrayReorder(
  handle: MountHandle,
  shape: ScenarioShape,
  plan: SamplePlan
): Promise<Summary> {
  // The swap exchanges two ROWS (array elements), so the index lives in row
  // space, not the flat input index. For a multi-column grid the input count
  // (paths.length) is rows x columns, so divide by the column count to recover
  // the row count; for a single-column array the two coincide.
  const cols = shape.arrayItemFields?.length ?? 1
  const rowCount = Math.floor(shape.paths.length / cols)
  const last = Math.max(0, rowCount - 1)
  for (let i = 0; i < 5; i++) await handle.arrayOp('swap', 0, last)
  const samples: number[] = []
  for (let i = 0; i < plan.arrayOpRuns; i++) {
    samples.push(await timed(() => handle.arrayOp('swap', 0, last)))
    await frame()
  }
  return summarize(samples)
}

/**
 * Cross-variant flip: cycle the discriminant through every variant, replacing
 * the whole union value each time. The library re-resolves the now-active
 * branch (its discriminated-union handling) and the rendered field set swaps to
 * the new variant. Each sample is one flip to the next variant in the cycle, so
 * the union rotates through all of its shapes, every one of them valid.
 */
async function measureVariantFlip(
  handle: MountHandle,
  shape: ScenarioShape,
  plan: SamplePlan
): Promise<Summary> {
  const tags = shape.union?.variants.map((variant) => variant.tag) ?? []
  if (tags.length === 0) throw new Error('bench: variantFlip needs a discriminated-union scenario')
  const at = (i: number): string => tags[i % tags.length] as string
  for (let i = 0; i < 5; i++) await handle.flipVariant(at(i))
  const samples: number[] = []
  for (let i = 0; i < plan.variantFlipRuns; i++) {
    samples.push(await timed(() => handle.flipVariant(at(5 + i))))
    await frame()
  }
  return summarize(samples)
}

/**
 * Wizard step transition: the gated forward advance, where a step is validated
 * before the next is revealed. Each measured sample advances one step from a
 * non-final step (the leaving step is validated, then the wizard moves on); on
 * reaching the final step the wizard retreats to the first through unmeasured
 * free back-steps, so every measured sample is the identical intermediate gated
 * advance. A library with a wizard primitive (Attaform's useWizard) validates
 * only the active step on an advance; a hand-composed wizard validates the step
 * the way its engine allows, so this is where a wizard primitive earns its keep.
 */
async function measureStepTransition(
  handle: MountHandle,
  shape: ScenarioShape,
  plan: SamplePlan
): Promise<Summary> {
  const steps = shape.wizard?.steps.length ?? 0
  if (steps < 2)
    throw new Error('bench: stepTransition needs a wizard scenario with two or more steps')
  // Retreat to the first step through free (ungated) back-steps; called only
  // from the final step, so it walks exactly `steps - 1` positions to step 0.
  const rewind = async (): Promise<void> => {
    for (let s = 0; s < steps - 1; s++) await handle.stepTransition(-1)
  }
  // Warm up one full forward sweep, then rewind to the first step.
  for (let i = 0; i < steps - 1; i++) await handle.stepTransition(1)
  await rewind()
  const samples: number[] = []
  let pos = 0
  for (let i = 0; i < plan.stepTransitionRuns; i++) {
    samples.push(await timed(() => handle.stepTransition(1)))
    pos += 1
    await frame()
    if (pos >= steps - 1) {
      await rewind()
      pos = 0
    }
  }
  return summarize(samples)
}

/** Mount/init cost over fresh mounts; the only dim that re-mounts per sample. */
async function measureMount(
  adapter: BenchAdapter,
  opts: MountOpts,
  plan: SamplePlan
): Promise<Summary> {
  const samples: number[] = []
  for (let i = 0; i < plan.mountRuns; i++) {
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

/**
 * Install the memory hooks the CDP driver brackets with heap reads, rather than
 * measuring in-page. The in-page `performance.memory` is quantized so heavily
 * (tens-of-MB buckets that ignore real allocations, even under cross-origin
 * isolation) that a delta reads zero for every library at every size, and
 * `measureUserAgentSpecificMemory` is unavailable under automation. The driver
 * instead reads the byte-exact heap through CDP (HeapProfiler.collectGarbage +
 * Runtime.getHeapUsage), collecting before and after each hook call.
 *
 * One mount/teardown cycle yields three drift-robust deltas: with `s0` the
 * collected baseline, `s1` the collected heap of the live mount, `s2` the heap
 * after a keystroke burst (no collection), and `s3` the collected heap after
 * teardown, the driver records retained `s1 - s0` (live-form heap), churn
 * `s2 - s1` (the burst's allocation pressure), and leak `s3 - s0` (residual a
 * mount/unmount leaves behind). A leak that makes `s0` creep upward across
 * cycles leaves every per-cycle delta correct, so retained and leak stay honest
 * even as the page accumulates.
 *
 * The DOM is held constant for the bare-input cohort, so the figures isolate the
 * library's own reactive and validation state; the compiled schema (zod/valibot)
 * and, for a library that owns its inputs (FormKit), its component tree ride
 * along, which is fair, since that is what the library needs to do its job.
 */
function setupMemoryHooks(
  adapter: BenchAdapter,
  opts: MountOpts,
  shape: ScenarioShape,
  plan: SamplePlan
): void {
  const fieldCount = shape.paths.length
  let container: HTMLElement | undefined
  let handle: MountHandle | undefined
  window.__BENCH_MEM__ = {
    cycles: plan.memoryRuns,
    burst: MEMORY_BURST,
    async mount() {
      container = makeContainer()
      handle = await adapter.mount(container, opts)
      await settle()
    },
    async typeBurst() {
      if (!handle) return
      for (let i = 0; i < MEMORY_BURST; i++) await handle.typeChar(i % fieldCount, `m${i}`)
    },
    async teardown() {
      handle?.teardown()
      container?.remove()
      handle = undefined
      container = undefined
      // Let the unmount's async cleanup run before the driver collects, so the
      // detached tree is actually reclaimable; without this the post-teardown
      // heap still looks live and the leak reads as the whole retained heap.
      await settle()
    },
  }
}

async function run(): Promise<BenchPayload> {
  // Collect before this cell allocates anything, so the previous cell's heap
  // cannot skew the measurement. The driver reuses one browser process across
  // every cell of every scenario, so a heavy cell leaves residue that slows the
  // next one: an isolated FormKit validate measured ~65s but ~240s when it
  // followed heavy mount cells with no collection between them. This runs for
  // every cell uniformly; the driver also collects after each cell, so the heap
  // is clean at both ends. Requires --expose-gc (the driver passes it); a safe
  // no-op without it.
  ;(globalThis as { gc?: () => void }).gc?.()

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
  const plan = planFor(q.scenario)

  const base = {
    adapter: q.adapter,
    scenario: q.scenario,
    params: q.params,
    trigger: q.trigger,
    dimension: q.dim,
    calibrationMs,
  }

  if (q.dim === 'mount') {
    return {
      ...base,
      unit: 'ms',
      summary: await measureMount(adapter, opts, plan),
      supported: true,
    }
  }

  // Memory is measured driver-side: install the hooks the CDP driver brackets
  // with heap reads, then report readiness. The summary here is a placeholder;
  // the driver fills in the real retained/churn/leak figures.
  if (q.dim === 'memory') {
    setupMemoryHooks(adapter, opts, shape, plan)
    return { ...base, unit: 'bytes', summary: ZERO, supported: true }
  }

  const container = makeContainer()
  const handle = await adapter.mount(container, opts)
  try {
    switch (q.dim) {
      case 'keystroke':
        return {
          ...base,
          unit: 'ms',
          summary: await measureKeystroke(handle, shape, plan),
          supported: true,
        }
      case 'validate':
        return {
          ...base,
          unit: 'ms',
          summary: await measureValidate(handle, plan),
          supported: true,
        }
      case 'rerender': {
        const result = await measureRerender(handle, shape, container, plan)
        return { ...base, unit: result.unit, summary: result.summary, supported: true }
      }
      case 'arrayAdd':
        return {
          ...base,
          unit: 'ms',
          summary: await measureArrayAdd(handle, plan),
          supported: true,
        }
      case 'arrayReorder':
        return {
          ...base,
          unit: 'ms',
          summary: await measureArrayReorder(handle, shape, plan),
          supported: true,
        }
      case 'variantFlip':
        return {
          ...base,
          unit: 'ms',
          summary: await measureVariantFlip(handle, shape, plan),
          supported: true,
        }
      case 'stepTransition':
        return {
          ...base,
          unit: 'ms',
          summary: await measureStepTransition(handle, shape, plan),
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

/** Expose every adapter's meta for the orchestrator; mounts nothing. */
function exposeMeta(): void {
  window.__BENCH_META__ = Object.values(adapters).map((adapter) => adapter.meta)
  document.body.dataset['benchDone'] = '1'
}

if (new URLSearchParams(window.location.search).get('meta') === '1') {
  exposeMeta()
} else {
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
}
