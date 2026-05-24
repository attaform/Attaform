import { describe, expect, it } from 'vitest'
import { isLazyMarker, lazy } from '../../src/runtime/core/wizard-lazy'

/**
 * `lazy((ctx) => …)` produces a `LazyMarker` that the wizard's slot
 * compiler wraps in its own memoized computed: the resolver runs once
 * on the first compile pass and the cached result holds until one of
 * the resolver's tracked reactive reads changes (or `wizard.reset()`
 * fires).
 *
 * This file covers the helper's marker shape and type guard; the
 * compiler-side memoization behavior lives alongside the wizard tests
 * in `test/composables/`.
 */

describe('lazy()', () => {
  it('returns a marker that isLazyMarker recognises', () => {
    const marker = lazy(() => undefined)
    expect(isLazyMarker(marker)).toBe(true)
  })

  it('preserves the consumer-provided resolver for the compiler to call later', () => {
    const resolver = () => 'shipping-review'
    const marker = lazy(resolver)
    expect(marker.resolve).toBe(resolver)
  })

  it('does NOT invoke the resolver at construction', () => {
    let calls = 0
    lazy(() => {
      calls++
      return undefined
    })
    expect(calls).toBe(0)
  })

  it('survives Symbol.for cross-realm identity (structural recognition)', () => {
    const marker = lazy(() => undefined)
    expect(isLazyMarker(marker)).toBe(true)
    expect(isLazyMarker({ ...marker })).toBe(true)
  })

  it('returns false for non-marker values', () => {
    expect(isLazyMarker(null)).toBe(false)
    expect(isLazyMarker(undefined)).toBe(false)
    expect(isLazyMarker({})).toBe(false)
    expect(isLazyMarker('shipping')).toBe(false)
    expect(isLazyMarker(() => undefined)).toBe(false)
    expect(isLazyMarker({ resolve: () => undefined })).toBe(false)
  })
})
