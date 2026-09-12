import { describe, expect, it } from 'vitest'
import { assertNeverSettles, waitUntil } from './form-harness'

/**
 * Standing pin for the two wait helpers the rest of the suite is built
 * on. 500-odd call sites take `waitUntil` on trust, so its failure mode
 * is load-bearing: it used to give up SILENTLY and return `null`, which
 * made every expiry surface as whatever assertion ran next. The
 * `docs-demos-smoke` async-refinement case reported `expected '' to
 * contain 'taken'`, a message describing a wrong value rather than a
 * value that never arrived, and that mis-signal cost two rounds of
 * ceiling-raising (2000ms, then 5000ms) before the budget itself was
 * questioned.
 *
 * So these tests pin the diagnostics, not just the control flow. A
 * revert to silent-null, or a message that drops the budget or the
 * predicate, fails here.
 */

describe('waitUntil', () => {
  it('returns the first non-nullish value the predicate produces', async () => {
    let polls = 0
    const value = await waitUntil(() => (++polls >= 3 ? `settled-on-${polls}` : null), 500, 1)
    expect(value).toBe('settled-on-3')
  })

  it('treats a falsy-but-present value as settled', async () => {
    // Only `null` / `undefined` mean "not yet". `0`, `''` and `false`
    // are real answers, and a predicate returning one must not hang.
    await expect(waitUntil(() => 0, 100, 1)).resolves.toBe(0)
    await expect(waitUntil(() => '', 100, 1)).resolves.toBe('')
    await expect(waitUntil(() => false, 100, 1)).resolves.toBe(false)
  })

  it('throws on expiry rather than resolving null', async () => {
    await expect(waitUntil(() => null, 20, 1)).rejects.toThrow(/timed out/)
  })

  it('names the budget and the predicate in the timeout message', async () => {
    const error = await waitUntil(() => undefined, 20, 1).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    const message = error instanceof Error ? error.message : ''
    // The budget: distinguishes "the wait was too tight" from "the
    // pipeline is broken" without re-reading the call site.
    expect(message).toContain('budget 20ms')
    // The predicate source: says WHICH wait expired. This is what a
    // label argument would buy, at no cost to 500-odd call sites.
    expect(message).toContain('waiting for:')
    expect(message).toContain('undefined')
    // The poll count: a count of 1 means the loop never got to run.
    expect(message).toMatch(/\d+ polls/)
  })

  it('caps a long predicate source so it cannot bury the failure output', async () => {
    // The cap applies to the predicate's SOURCE TEXT, so the length has
    // to live in the source, not in a captured variable.
    const error = await waitUntil(
      () =>
        'a-deliberately-long-predicate-body-that-would-bury-the-rest-of-the-failure-output-a-deliberately-long-predicate-body-that-would-bury-the-rest-of-the-failure-output-a-deliberately-long-predicate-body-that-would-bury-the-rest-of-the-failure-output-a-deliberately-long-predicate-body-that-would-bury-the-rest-of-the-failure-output-'
          .length > 1e9
          ? 1
          : null,
      20,
      1
    ).catch((e: unknown) => e)
    const message = error instanceof Error ? error.message : ''
    expect(message).toContain('…')
    expect(message.length).toBeLessThan(400)
  })
})

describe('assertNeverSettles', () => {
  it('resolves quietly when the signal never fires', async () => {
    await expect(assertNeverSettles(() => false, 20, 'signal', 1)).resolves.toBeUndefined()
  })

  it('treats false as "did not fire", matching a boolean would-fire probe', async () => {
    // The negative helper is normally handed a boolean predicate, so
    // `false` has to mean "not yet" here even though `waitUntil` would
    // read it as a real answer.
    await expect(assertNeverSettles(() => false, 20, 'boolean probe', 1)).resolves.toBeUndefined()
  })

  it('throws the moment the signal fires, naming the label', async () => {
    let polls = 0
    const error = await assertNeverSettles(
      () => ++polls >= 2,
      500,
      'the async seed fired',
      1
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    const message = error instanceof Error ? error.message : ''
    expect(message).toContain('the async seed fired')
    expect(message).toContain('Predicate:')
  })

  it('fails fast instead of burning the whole window', async () => {
    const startedAt = Date.now()
    await assertNeverSettles(() => true, 5000, 'immediate', 1).catch(() => undefined)
    expect(Date.now() - startedAt).toBeLessThan(1000)
  })
})
