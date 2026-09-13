import { afterEach, describe, expect, it } from 'vitest'
import {
  compressDemoLatency,
  DEMO_LATENCY_COMPRESSION_FACTOR,
  DEMO_LATENCY_THRESHOLD_MS,
} from './demo-latency'
import { DEFAULT_TIMINGS } from '../../src/runtime/core/display-state'

/**
 * The compression helper sits between two sets of timers it must keep
 * apart: the docs demos' simulated server latency, which the smoke
 * suite should not pay for, and Attaform's own display-state timings,
 * which the smoke suite is partly there to observe. A threshold that
 * drifted into the second set would quietly change what the suite
 * proves about pending states while every test stayed green.
 *
 * So the gap itself is pinned here, not just the arithmetic.
 */

let restore: (() => void) | undefined

afterEach(() => {
  restore?.()
  restore = undefined
})

describe('compressDemoLatency', () => {
  it('leaves the runtime’s own timings untouched', () => {
    // The whole design rests on this gap. `DEFAULT_TIMINGS` is read
    // from the runtime rather than copied, so raising either value
    // above the threshold fails here instead of silently compressing
    // the behaviour the smoke suite is watching.
    expect(DEFAULT_TIMINGS.showDelay).toBeLessThan(DEMO_LATENCY_THRESHOLD_MS)
    expect(DEFAULT_TIMINGS.minVisible).toBeLessThan(DEMO_LATENCY_THRESHOLD_MS)
  })

  it('passes sub-threshold delays through unchanged', () => {
    const seen: number[] = []
    const original = globalThis.setTimeout
    globalThis.setTimeout = ((fn: TimerHandler, ms?: number) => {
      seen.push(ms ?? 0)
      return original(fn, 0)
    }) as typeof globalThis.setTimeout
    restore = compressDemoLatency()

    globalThis.setTimeout(() => {}, 0)
    globalThis.setTimeout(() => {}, DEFAULT_TIMINGS.showDelay)
    globalThis.setTimeout(() => {}, DEMO_LATENCY_THRESHOLD_MS - 1)

    restore()
    restore = undefined
    globalThis.setTimeout = original
    expect(seen).toEqual([0, DEFAULT_TIMINGS.showDelay, DEMO_LATENCY_THRESHOLD_MS - 1])
  })

  it('scales delays at or above the threshold', () => {
    const seen: number[] = []
    const original = globalThis.setTimeout
    globalThis.setTimeout = ((fn: TimerHandler, ms?: number) => {
      seen.push(ms ?? 0)
      return original(fn, 0)
    }) as typeof globalThis.setTimeout
    restore = compressDemoLatency()

    // The real spread across apps/site/docs-demos: 350ms to 1200ms.
    globalThis.setTimeout(() => {}, 350)
    globalThis.setTimeout(() => {}, 700)
    globalThis.setTimeout(() => {}, 1200)

    restore()
    restore = undefined
    globalThis.setTimeout = original
    expect(seen).toEqual([
      Math.round(350 / DEMO_LATENCY_COMPRESSION_FACTOR),
      Math.round(700 / DEMO_LATENCY_COMPRESSION_FACTOR),
      Math.round(1200 / DEMO_LATENCY_COMPRESSION_FACTOR),
    ])
  })

  it('preserves the relative order of staged delays', () => {
    // Scaled rather than clamped precisely so a demo that debounces and
    // then saves keeps the two steps in order. A constant would flatten
    // them and could invert the behaviour a demo exists to show.
    const seen: number[] = []
    const original = globalThis.setTimeout
    globalThis.setTimeout = ((fn: TimerHandler, ms?: number) => {
      seen.push(ms ?? 0)
      return original(fn, 0)
    }) as typeof globalThis.setTimeout
    restore = compressDemoLatency()

    globalThis.setTimeout(() => {}, 400)
    globalThis.setTimeout(() => {}, 500)
    globalThis.setTimeout(() => {}, 1200)

    restore()
    restore = undefined
    globalThis.setTimeout = original
    expect(seen[0]).toBeLessThan(seen[1] as number)
    expect(seen[1]).toBeLessThan(seen[2] as number)
  })

  it('actually fires on the compressed schedule', async () => {
    restore = compressDemoLatency()
    const startedAt = Date.now()
    await new Promise((resolve) => setTimeout(resolve, 700))
    const elapsed = Date.now() - startedAt
    // 700ms becomes 14ms. Generous upper bound so the assertion is
    // about compression happening at all, not about timer precision.
    expect(elapsed).toBeLessThan(300)
  })

  it('restores the original setTimeout', async () => {
    const before = globalThis.setTimeout
    const undo = compressDemoLatency()
    expect(globalThis.setTimeout).not.toBe(before)
    undo()
    expect(globalThis.setTimeout).toBe(before)

    // And the restored binding waits for real again.
    const startedAt = Date.now()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30)
  })
})
