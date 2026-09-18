/**
 * The 3x floor that `check:bench` used to enforce from outside.
 *
 * Three bench files pair a baseline implementation against the one that
 * replaced it, and the replacement is required to be at least three times
 * faster. Under vitest 4 that ratio lived in `scripts/check-bench.mjs`,
 * which re-parsed the bench JSON and paired arms by an `old:` / `new:`
 * naming convention. vitest 5 asserts benchmark results directly
 * (`toBeFasterThan`), so the floor now sits beside the arms it governs and
 * the runner enforces it: a broken floor fails `pnpm bench` too, not only
 * the gate script.
 *
 * This helper OWNS the `old:` / `new:` prefixes, which is the point of it
 * existing rather than each file writing the pair by hand. Those prefixes
 * are what `scripts/check-bench.mjs` reads to report which scenarios carry
 * a floor and which do not, so a pair that skipped the assertion would be
 * counted as gated while measuring nothing. Routing the prefix through the
 * assertion makes that combination unwritable.
 *
 * `toBeFasterThan` states its threshold as a fraction of the baseline's
 * mean latency: `latency(new) < latency(old) * (1 - delta)`. A 3x ratio is
 * therefore `delta = 1 - 1/3`.
 */
import { expect, type Bench, type BenchFn } from 'vitest'

/** A replacement must beat the baseline it replaced by this factor. */
export const RATIO_FLOOR = 3

/** One side of a comparison: the name it reports under, and what it runs. */
export type BenchArm = readonly [name: string, fn: BenchFn]

/**
 * Run `baseline` and `replacement` under one comparison and fail the test
 * unless the replacement clears {@link RATIO_FLOOR}.
 *
 * Names arrive WITHOUT the prefix: `'flatten + setDifference x3'` reports
 * as `'old: flatten + setDifference x3'`. Those reported names are join
 * keys for `scripts/bench-delta.mjs`, which matches scenarios across two
 * runs by name, so renaming an arm silently drops it from a cross-branch
 * comparison rather than failing.
 */
export async function benchAgainstBaseline(
  bench: Bench,
  baseline: BenchArm,
  replacement: BenchArm
): Promise<void> {
  const oldName = `old: ${baseline[0]}`
  const newName = `new: ${replacement[0]}`
  const results = await bench.compare(bench(oldName, baseline[1]), bench(newName, replacement[1]))
  expect(results.get(newName)).toBeFasterThan(results.get(oldName), {
    delta: 1 - 1 / RATIO_FLOOR,
  })
}
