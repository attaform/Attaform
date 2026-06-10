import { type Page, expect, test } from '@playwright/test'

/**
 * The cohort driver: loop every adapter across the scenario suite and every
 * dimension, read each in-page measurement, and assert it is well-formed and
 * sane. The numbers themselves are logged for human inspection; this spec's job
 * is to prove every adapter mounts, drives, validates, and reports through the
 * one uniform contract, and that an adapter which cannot express a (scenario,
 * dimension) reports it unsupported rather than faking a number.
 * Provenance-stamped `results.json` writing is Phase 4.
 */

const ADAPTERS = [
  'attaform',
  'vee-validate',
  'tanstack',
  'formisch',
  'regle-schema',
  'regle-rules',
  'formkit',
  'vuelidate',
] as const

/** A scenario plus the param labels and dimensions it is swept across. */
interface ScenarioCase {
  readonly scenario: string
  readonly params: readonly string[]
  readonly dims: readonly string[]
  /**
   * A (param, dim) cell to skip for a library-agnostic measurement-budget
   * reason (never a per-library one). Applied uniformly across the whole
   * cohort, so it never biases a comparison: it removes a cell no library
   * reports, not a number a slow library would lose on.
   */
  readonly skip?: (params: string, dim: string) => boolean
}

const CASES: readonly ScenarioCase[] = [
  {
    scenario: 'flat',
    params: ['F10', 'F50'],
    dims: ['keystroke', 'mount', 'validate', 'rerender', 'memory'],
  },
  {
    scenario: 'nested',
    params: ['D4', 'D8', 'D16'],
    dims: ['keystroke', 'mount', 'validate', 'rerender', 'memory'],
  },
  {
    scenario: 'arrays',
    params: ['N10', 'N100'],
    dims: ['keystroke', 'mount', 'validate', 'rerender', 'arrayAdd', 'arrayReorder', 'memory'],
  },
  {
    scenario: 'grid',
    params: ['N20M8', 'N100M8'],
    dims: ['keystroke', 'mount', 'validate', 'rerender', 'arrayAdd', 'arrayReorder', 'memory'],
  },
  {
    scenario: 'discriminated-union',
    params: ['DU'],
    dims: ['keystroke', 'mount', 'validate', 'rerender', 'variantFlip', 'memory'],
  },
  {
    scenario: 'massive',
    params: ['L2000', 'L5000'],
    dims: ['keystroke', 'mount', 'validate', 'memory'],
    // Mounting thousands of inputs is seconds per single mount on the heavier
    // libraries, so a stable median over repeated fresh mounts at L5000 exceeds
    // any practical cell budget. That hits both mount and memory (a retained
    // heap sample is itself a fresh mount), so both are skipped at L5000; the
    // L2000 mount and heap already expose the per-field cost and slope (a one
    // time cost), while L5000 carries keystroke and full-form validate, where
    // the whole-form-versus-granular gap is the headline and both complete.
    skip: (params, dim) => params === 'L5000' && (dim === 'mount' || dim === 'memory'),
  },
  {
    // A linear multi-step flow. The two genuinely comparable operations are the
    // gated forward advance (stepTransition: validate the leaving step, move on)
    // and the cross-step aggregate validate, plus the cross-cutting memory dim
    // (the per-step forms' retained heap). Keystroke/mount/rerender add no
    // wizard-specific signal over flat/nested, so they are not swept here.
    scenario: 'wizard',
    params: ['S4'],
    dims: ['stepTransition', 'validate', 'memory'],
  },
]

/**
 * Whether an adapter legitimately reports a (scenario, dimension) as
 * unsupported. The page reports what the adapter actually does; this is what it
 * SHOULD do, so a disagreement fails the test in either direction (a rigged
 * number where a gap belongs, or a skipped cell that should have measured).
 */
function expectUnsupported(_adapter: string, _scenario: string, _dim: string): boolean {
  // Every adapter expresses every dimension of the object, array, grid,
  // massive, and wizard scenarios. The wizard's expressiveness gap is
  // native-versus-hand-rolled (the capability matrix column), not a measurement
  // one: Attaform has a wizard primitive, the rest hand-compose the flow, but
  // all of them advance steps and validate, so none reports a wizard dimension
  // unsupported. FormKit owns its inputs, so its render scope falls back to the
  // caveated DOM-mutation proxy (asserted below) rather than unsupported.
  return false
}

interface Payload {
  summary: { median: number; p95: number; iqr: number; count: number; trimmed: number }
  unit: 'ms' | 'renders' | 'dom-mutations'
  supported: boolean
  calibrationMs: number
  error?: string
}

async function runCell(
  page: Page,
  adapter: string,
  scenario: string,
  params: string,
  dim: string,
  timeoutMs: number
): Promise<Payload> {
  await page.goto(
    `/?adapter=${adapter}&scenario=${scenario}&params=${params}&trigger=input&dim=${dim}`
  )
  await page.waitForFunction(() => document.body.dataset['benchDone'] === '1', undefined, {
    timeout: timeoutMs,
  })
  const payload = await page.evaluate(
    () => (window as unknown as { __BENCH_RESULTS__: Payload }).__BENCH_RESULTS__
  )
  // Collect after every cell of every scenario so one library's garbage cannot
  // skew the next (the harness also collects before it measures, so the heap is
  // clean at both ends of each cell).
  await page.evaluate(() => (globalThis as { gc?: () => void }).gc?.())
  return payload
}

/** Median of a sample set (the memory cell's summary; p95/iqr land in Phase 4). */
function median(samples: readonly number[]): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0
}

/** The page window once the memory hooks are installed. */
type MemoryWindow = Window & {
  __BENCH_MEM__?: {
    cycles: number
    burst: number
    mount(): Promise<void>
    typeBurst(): Promise<void>
    teardown(): Promise<void>
  }
  __BENCH_RESULTS__?: { error?: string }
}

/**
 * The three retained/churn/leak medians (bytes) and the cycle count driven, plus
 * the raw per-cycle series the orchestrator keeps for the leak-creep sparkline.
 */
interface MemoryResult {
  error?: string
  cycles: number
  retained: number
  churn: number
  leak: number
  series: { retained: number[]; churn: number[]; leak: number[] }
}

/**
 * Drive the memory dimension. The page only installs mount/type/teardown hooks;
 * a precise heap is read driver-side through CDP, since the in-page
 * performance.memory is quantized to uselessness (tens-of-MB buckets that ignore
 * real allocations). Per cycle, with `s0` the collected baseline, `s1` the
 * collected live mount, `s2` the heap after a keystroke burst (uncollected), and
 * `s3` the collected heap after teardown: retained = s1 - s0 (live-form heap),
 * churn = s2 - s1 (the burst's allocation), leak = s3 - s0 (post-teardown
 * residual). A leak that makes the baseline creep leaves every per-cycle delta
 * correct. Production preview only: a dev build's HMR registry retains every
 * mount and swamps the signal (leak then reads as the whole retained heap).
 */
async function runMemoryCell(
  page: Page,
  adapter: string,
  scenario: string,
  params: string,
  timeoutMs: number
): Promise<MemoryResult> {
  await page.goto(
    `/?adapter=${adapter}&scenario=${scenario}&params=${params}&trigger=input&dim=memory`
  )
  await page.waitForFunction(() => document.body.dataset['benchDone'] === '1', undefined, {
    timeout: timeoutMs,
  })
  const empty = {
    cycles: 0,
    retained: 0,
    churn: 0,
    leak: 0,
    series: { retained: [], churn: [], leak: [] },
  }
  const setupError = await page.evaluate(() => (window as MemoryWindow).__BENCH_RESULTS__?.error)
  if (setupError) return { ...empty, error: setupError }
  const cycles = await page.evaluate(() => (window as MemoryWindow).__BENCH_MEM__?.cycles ?? 0)
  if (!cycles) return { ...empty, error: 'memory hooks were not installed' }

  const client = await page.context().newCDPSession(page)
  await client.send('HeapProfiler.enable')
  // Two collection passes: a single full GC can leave a large heap (FormKit at
  // thousands of fields holds hundreds of MB) partly uncollected, which would
  // overstate the leak; the second pass reclaims what the first left pending, so
  // a reported leak is real, not collection lag. Symmetric across s0/s1/s3.
  const gc = async (): Promise<void> => {
    await client.send('HeapProfiler.collectGarbage')
    await client.send('HeapProfiler.collectGarbage')
  }
  const used = async (): Promise<number> => (await client.send('Runtime.getHeapUsage')).usedSize
  const retained: number[] = []
  const churn: number[] = []
  const leak: number[] = []
  for (let i = 0; i < cycles; i++) {
    await gc()
    const s0 = await used()
    await page.evaluate(() => (window as MemoryWindow).__BENCH_MEM__?.mount())
    await gc()
    const s1 = await used()
    retained.push(Math.max(0, s1 - s0))
    await page.evaluate(() => (window as MemoryWindow).__BENCH_MEM__?.typeBurst())
    const s2 = await used()
    churn.push(Math.max(0, s2 - s1))
    await page.evaluate(() => (window as MemoryWindow).__BENCH_MEM__?.teardown())
    await gc()
    const s3 = await used()
    leak.push(Math.max(0, s3 - s0))
  }
  await client.detach()
  return {
    cycles,
    retained: median(retained),
    churn: median(churn),
    leak: median(leak),
    series: { retained, churn, leak },
  }
}

for (const { scenario, params: paramSet, dims, skip } of CASES) {
  test.describe(`${scenario} scenario · full cohort`, () => {
    for (const adapter of ADAPTERS) {
      for (const params of paramSet) {
        for (const dim of dims) {
          test(`${adapter} · ${params} · ${dim}`, async ({ page }, testInfo) => {
            test.skip(skip?.(params, dim) ?? false, 'cell exceeds the per-cell measurement budget')
            // The massive scenario mounts thousands of inputs, so a single mount
            // or full-form validate runs for seconds on the heavier libraries;
            // give those cells a wide test + wait budget (still bounded, so a
            // genuine hang still fails). Every other cell keeps the default.
            const wide = scenario === 'massive'
            if (wide) test.setTimeout(360_000)
            const waitMs = wide ? 320_000 : 60_000

            // Memory is driver-measured via CDP, so it reports three byte
            // figures (retained/churn/leak) rather than one timed summary; it
            // takes its own path. Every adapter mounts, so none is unsupported.
            if (dim === 'memory') {
              const m = await runMemoryCell(page, adapter, scenario, params, waitMs)
              expect(
                m.error,
                `error in ${adapter}/${scenario}/${params}/memory: ${m.error ?? ''}`
              ).toBeUndefined()
              expect(
                m.cycles,
                `${adapter}/${scenario}/${params}/memory ran no cycles`
              ).toBeGreaterThan(0)
              for (const [facet, value] of [
                ['retained', m.retained],
                ['churn', m.churn],
                ['leak', m.leak],
              ] as const) {
                expect(
                  Number.isFinite(value),
                  `${adapter}/${scenario}/${params}/memory ${facet} not finite`
                ).toBe(true)
                expect(
                  value,
                  `${adapter}/${scenario}/${params}/memory ${facet} negative`
                ).toBeGreaterThanOrEqual(0)
              }
              const kb = (n: number): string => `${(n / 1024).toFixed(1)}KB`
              // eslint-disable-next-line no-console
              console.log(
                `${adapter.padEnd(14)} ${scenario.padEnd(8)} ${params.padEnd(4)} memory     ` +
                  `retained=${kb(m.retained)} churn=${kb(m.churn)} leak=${kb(m.leak)} n=${m.cycles}`
              )
              // Hand the cell's measurement to the orchestrator: it harvests
              // these attachments from the same green run that asserts them, so
              // the published numbers and the gate can never diverge.
              await testInfo.attach('cell', {
                body: JSON.stringify({
                  kind: 'memory',
                  adapter,
                  scenario,
                  params,
                  cycles: m.cycles,
                  retained: m.retained,
                  churn: m.churn,
                  leak: m.leak,
                  series: m.series,
                }),
                contentType: 'application/json',
              })
              return
            }

            const r = await runCell(page, adapter, scenario, params, dim, waitMs)
            expect(r, `no payload for ${adapter}/${scenario}/${params}/${dim}`).toBeTruthy()
            expect(
              r.error,
              `error in ${adapter}/${scenario}/${params}/${dim}: ${r.error ?? ''}`
            ).toBeUndefined()

            if (expectUnsupported(adapter, scenario, dim)) {
              expect(
                r.supported,
                `${adapter}/${scenario}/${params}/${dim} should be unsupported`
              ).toBe(false)
            } else {
              expect(
                r.supported,
                `${adapter}/${scenario}/${params}/${dim} reported unsupported`
              ).toBe(true)
              expect(Number.isFinite(r.summary.median)).toBe(true)
              expect(r.summary.median).toBeGreaterThanOrEqual(0)
              expect(r.summary.count).toBeGreaterThan(0)
            }

            // Lock the render-scope unit: the bare-input cohort reports
            // component renders; FormKit owns its inputs, so its rerender cell
            // falls back to the caveated DOM-mutation proxy. Both are
            // well-formed numbers; only the unit distinguishes them.
            if (dim === 'rerender') {
              expect(r.unit, `${adapter}/${scenario}/${params}/rerender unit`).toBe(
                adapter === 'formkit' ? 'dom-mutations' : 'renders'
              )
            }

            const unitLabel =
              r.unit === 'renders' ? ' renders' : r.unit === 'dom-mutations' ? ' dom-mut' : 'ms'
            // eslint-disable-next-line no-console
            console.log(
              `${adapter.padEnd(14)} ${scenario.padEnd(8)} ${params.padEnd(4)} ${dim.padEnd(10)} ` +
                `median=${r.summary.median.toFixed(3)}${unitLabel} p95=${r.summary.p95.toFixed(3)} ` +
                `n=${r.summary.count} trim=${r.summary.trimmed} calib=${r.calibrationMs.toFixed(1)}ms`
            )
            await testInfo.attach('cell', {
              body: JSON.stringify({
                kind: 'timed',
                adapter,
                scenario,
                params,
                dim,
                summary: r.summary,
                unit: r.unit,
                supported: r.supported,
                calibrationMs: r.calibrationMs,
              }),
              contentType: 'application/json',
            })
          })
        }
      }
    }
  })
}

test.describe('cohort metadata', () => {
  test('capability and display metadata', async ({ page }, testInfo) => {
    await page.goto('/?meta=1')
    await page.waitForFunction(() => document.body.dataset['benchDone'] === '1', undefined, {
      timeout: 60_000,
    })
    const meta = await page.evaluate(
      () => (window as unknown as { __BENCH_META__?: readonly unknown[] }).__BENCH_META__
    )
    expect(meta, 'adapter meta was not exposed on ?meta=1').toBeTruthy()
    expect(Array.isArray(meta), 'adapter meta is not an array').toBe(true)
    expect((meta as readonly unknown[]).length, 'meta count does not match the cohort').toBe(
      ADAPTERS.length
    )
    // The orchestrator builds the capability matrix and display metadata from
    // this attachment, so both come from the real built adapters, not a copy.
    await testInfo.attach('meta', { body: JSON.stringify(meta), contentType: 'application/json' })
  })
})
