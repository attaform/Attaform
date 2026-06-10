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
}

const CASES: readonly ScenarioCase[] = [
  {
    scenario: 'flat',
    params: ['F10', 'F50'],
    dims: ['keystroke', 'mount', 'validate', 'rerender'],
  },
  {
    scenario: 'nested',
    params: ['D4', 'D8', 'D16'],
    dims: ['keystroke', 'mount', 'validate', 'rerender'],
  },
  {
    scenario: 'arrays',
    params: ['N10', 'N100'],
    dims: ['keystroke', 'mount', 'validate', 'rerender'],
  },
]

/**
 * Whether an adapter legitimately reports a (scenario, dimension) as
 * unsupported. The page reports what the adapter actually does; this is what it
 * SHOULD do, so a disagreement fails the test in either direction (a rigged
 * number where a gap belongs, or a skipped cell that should have measured).
 */
function expectUnsupported(adapter: string, _scenario: string, dim: string): boolean {
  // FormKit owns its inputs, so component render scope is not applicable on any
  // scenario; it reports unsupported (the DOM-mutation proxy lands later).
  return dim === 'rerender' && adapter === 'formkit'
}

interface Payload {
  summary: { median: number; p95: number; iqr: number; count: number; trimmed: number }
  unit: 'ms' | 'renders'
  supported: boolean
  calibrationMs: number
  error?: string
}

async function runCell(
  page: Page,
  adapter: string,
  scenario: string,
  params: string,
  dim: string
): Promise<Payload> {
  await page.goto(
    `/?adapter=${adapter}&scenario=${scenario}&params=${params}&trigger=input&dim=${dim}`
  )
  await page.waitForFunction(() => document.body.dataset['benchDone'] === '1', undefined, {
    timeout: 60_000,
  })
  const payload = await page.evaluate(
    () => (window as unknown as { __BENCH_RESULTS__: Payload }).__BENCH_RESULTS__
  )
  // Collect between cells so one library's garbage cannot skew the next.
  await page.evaluate(() => (globalThis as { gc?: () => void }).gc?.())
  return payload
}

for (const { scenario, params: paramSet, dims } of CASES) {
  test.describe(`${scenario} scenario · full cohort`, () => {
    for (const adapter of ADAPTERS) {
      for (const params of paramSet) {
        for (const dim of dims) {
          test(`${adapter} · ${params} · ${dim}`, async ({ page }) => {
            const r = await runCell(page, adapter, scenario, params, dim)
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

            const unit = r.unit === 'renders' ? ' renders' : 'ms'
            // eslint-disable-next-line no-console
            console.log(
              `${adapter.padEnd(14)} ${scenario.padEnd(8)} ${params.padEnd(4)} ${dim.padEnd(10)} ` +
                `median=${r.summary.median.toFixed(3)}${unit} p95=${r.summary.p95.toFixed(3)} ` +
                `n=${r.summary.count} trim=${r.summary.trimmed} calib=${r.calibrationMs.toFixed(1)}ms`
            )
          })
        }
      }
    }
  })
}
