import { describe, expect, it } from 'vitest'
import { defer, isDeferMarker } from '../../src/runtime/core/wizard-defer'

/**
 * `defer((ctx) => …)` produces a `DeferMarker` that the wizard's slot
 * compiler treats as lazy-sticky: the wrapped function does not
 * resolve until navigation lands on the slot for the first time, and
 * its resolution sticks across subsequent departures and returns.
 *
 * Unit 1 ships the helper and its type guard; the compiler-side
 * behavior lands in Unit 2 (steps compiler) alongside the rest of the
 * `useWizardV2` core.
 */

describe('defer()', () => {
  it('returns a marker that isDeferMarker recognises', () => {
    const marker = defer(() => undefined)
    expect(isDeferMarker(marker)).toBe(true)
  })

  it('preserves the consumer-provided resolver for the compiler to call later', () => {
    const resolver = () => 'shipping-review'
    const marker = defer(resolver)
    expect((marker as { resolve: typeof resolver }).resolve).toBe(resolver)
  })

  it('does NOT invoke the resolver at construction', () => {
    let calls = 0
    defer(() => {
      calls++
      return undefined
    })
    expect(calls).toBe(0)
  })

  it('survives Symbol.for cross-realm identity (structural recognition)', () => {
    const marker = defer(() => undefined)
    expect(isDeferMarker(marker)).toBe(true)
    expect(isDeferMarker({ ...marker })).toBe(true)
  })

  it('returns false for non-marker values', () => {
    expect(isDeferMarker(null)).toBe(false)
    expect(isDeferMarker(undefined)).toBe(false)
    expect(isDeferMarker({})).toBe(false)
    expect(isDeferMarker('shipping')).toBe(false)
    expect(isDeferMarker(() => undefined)).toBe(false)
    expect(isDeferMarker({ resolve: () => undefined })).toBe(false)
  })
})
