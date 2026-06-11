import { nextTick } from 'vue'

/**
 * Reactive-settle barriers, applied identically after every edit so they
 * cannot bias one library over another.
 *
 * A form library can defer per-keystroke work to three places:
 *   1. a macrotask (`setTimeout(0)`) - Attaform's 0ms validation debounce,
 *      FormKit's commit. Our timer is queued AFTER the edit dispatched the
 *      library's, so it fires once that work has run;
 *   2. the Vue scheduler (microtasks) - component updates the edit queued. Two
 *      `nextTick` waves: the first flushes them, the second catches updates a
 *      watcher scheduled during that first flush;
 *   3. an animation frame - paint-adjacent commits.
 *
 * `flush()` drains (1) and (2): it is the barrier the keystroke clock measures
 * to, because folding rAF's frame latency into a sub-millisecond keystroke
 * would swamp the signal. `settle()` adds the frame and is used between
 * samples and for non-latency dimensions, so a library that commits on rAF is
 * fully caught before the next sample begins.
 */
export function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      void nextTick()
        .then(() => nextTick())
        .then(() => resolve())
    }, 0)
  })
}

/** One animation frame; the unmeasured paint gate between samples. */
export function frame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

/** The full barrier: drain async reactive work, then wait one paint frame. */
export async function settle(): Promise<void> {
  await flush()
  await frame()
}

/**
 * Wall-clock milliseconds for one already-self-settling operation.
 *
 * Every `MountHandle` method does its work and then awaits the shared
 * `flush()` before resolving, so the settle barrier is identical across the
 * whole cohort (no adapter can substitute its own). The driver times the
 * awaited call directly: the figure is the library's per-edit cost plus the
 * single, constant `setTimeout(0)` floor every adapter pays equally.
 */
export async function timed(op: () => Promise<void>): Promise<number> {
  const start = performance.now()
  await op()
  return performance.now() - start
}

export interface Summary {
  /** Median over the kept samples, in the dimension's unit. */
  median: number
  /** 95th percentile over the kept samples. */
  p95: number
  /** Interquartile range of the raw samples (the trim ceiling input). */
  iqr: number
  /** Samples kept after trimming. */
  count: number
  /** Samples dropped as GC-suspect (above median + 3 x IQR). */
  trimmed: number
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0
  const pos = q * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const loV = sorted[lo] ?? 0
  const hiV = sorted[hi] ?? loV
  return loV + (hiV - loV) * (pos - lo)
}

/**
 * Median + p95 + IQR over samples, trimming GC-suspect outliers (anything
 * above median + 3 x IQR) and recording how many were dropped. The robust
 * statistics keep a stray garbage-collection pause from moving the headline.
 */
export function summarize(samples: readonly number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b)
  const q1 = quantile(sorted, 0.25)
  const q3 = quantile(sorted, 0.75)
  const iqr = q3 - q1
  const ceiling = quantile(sorted, 0.5) + 3 * iqr
  const kept = sorted.filter((s) => s <= ceiling)
  return {
    median: quantile(kept, 0.5),
    p95: quantile(kept, 0.95),
    iqr,
    count: kept.length,
    trimmed: sorted.length - kept.length,
  }
}

/**
 * A fixed, allocation-light arithmetic workload timed once per run. Its
 * wall-clock duration is a proxy for the machine's single-core speed, so the
 * docs can normalize absolute milliseconds across runners (a fast laptop and a
 * slower CI box differ by this factor). Pure compute: no DOM, no GC churn.
 */
export function calibrate(): number {
  const start = performance.now()
  let acc = 0
  for (let r = 0; r < 4000; r++) {
    for (let i = 1; i < 1000; i++) acc += Math.sqrt(i) * 1.0000001
  }
  // Consume the accumulator so the loop cannot be optimized away.
  if (!Number.isFinite(acc)) throw new Error('calibration diverged')
  return performance.now() - start
}
