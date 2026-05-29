// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createDebouncedWriter } from '../../../src/runtime/core/persistence'

/**
 * `createDebouncedWriter`'s `flush()` must resolve only AFTER every
 * scheduled write has settled. PASS2-S2 traced a race in the original
 * implementation: a finished older write's `.finally` nulled the
 * shared `pending` even when a newer write had replaced it, so
 * `flush()` / `awaitPendingWrites()` could resolve before the newest
 * write settled. The persisted bytes were never lost (each write is
 * a full idempotent snapshot), but the drain signal lied.
 *
 * These tests pin the corrected drain semantics: the latest write's
 * promise survives the older write's settle, and `flush()` loops
 * until no scheduled write remains.
 */

type WriteEntry = { resolve: () => void; settled: boolean }

function entryAt(runs: readonly WriteEntry[], index: number): WriteEntry {
  const e = runs[index]
  if (e === undefined) throw new Error(`runs[${index}] not yet scheduled`)
  return e
}

describe('createDebouncedWriter — overlapping-write drain (PASS2-S2)', () => {
  /**
   * Build a write function that returns a controllable promise on each
   * call. The harness records every call's promise + its resolver so
   * the test can settle writes in arbitrary order — and observe which
   * promise `flush()` actually awaits.
   */
  function makeControllableWriter(): {
    write: () => Promise<void>
    runs: WriteEntry[]
  } {
    const runs: WriteEntry[] = []
    const write = (): Promise<void> => {
      const entry: WriteEntry = {
        resolve: () => undefined,
        settled: false,
      }
      const promise = new Promise<void>((resolve) => {
        entry.resolve = () => {
          entry.settled = true
          resolve()
        }
      })
      runs.push(entry)
      return promise
    }
    return { write, runs }
  }

  it('flush() resolves only after the LATEST scheduled write settles, not the oldest', async () => {
    const { write, runs } = makeControllableWriter()
    const writer = createDebouncedWriter(write, 0)

    // Kick off write1 (debounceMs:0 fires synchronously).
    writer.schedule()
    expect(runs.length).toBe(1)
    // Schedule write2 before write1 has had a chance to settle. The
    // sync-arm path immediately starts a second write call.
    writer.schedule()
    expect(runs.length).toBe(2)
    expect(entryAt(runs, 0).settled).toBe(false)
    expect(entryAt(runs, 1).settled).toBe(false)

    // Begin awaiting a drain.
    let flushResolved = false
    const flushDone = writer.flush().then(() => {
      flushResolved = true
    })

    // Settle write1 FIRST. Without the generation guard, write1's
    // `.finally` would null `pending` and a flush awaiting that
    // pending would resolve here even though write2 is still
    // in flight. With the guard, flush stays pending.
    entryAt(runs, 0).resolve()
    // Drain enough microtasks for any unwanted flush resolution to
    // propagate. 10 hops cover the worst-case .finally → await →
    // return → .then chain by a comfortable margin.
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(entryAt(runs, 1).settled).toBe(false)
    expect(flushResolved).toBe(false)

    // Settling write2 lets the drain finish.
    entryAt(runs, 1).resolve()
    await flushDone
    expect(flushResolved).toBe(true)
  })

  it('flush() catches a NEW schedule landed during the prior pending await', async () => {
    const { write, runs } = makeControllableWriter()
    const writer = createDebouncedWriter(write, 0)

    writer.schedule()
    expect(runs.length).toBe(1)

    // Start the drain. flush captures `pending === P1` and starts
    // awaiting it.
    let flushResolved = false
    const flushDone = writer.flush().then(() => {
      flushResolved = true
    })

    // Inject another schedule WHILE flush is awaiting write1. P2
    // replaces P1 as `pending`; the prior implementation lost track
    // of P2 here, because write1's eventual `.finally` nulled the
    // shared `pending` and flush's await unblocked on write1's
    // settle (P1's resolution) without consulting whether a fresher
    // write was still in flight.
    writer.schedule()
    expect(runs.length).toBe(2)

    // Settle write1 first.
    entryAt(runs, 0).resolve()
    // Drain enough microtasks for flush's await-chain to fully
    // propagate. The race lets flush resolve in ~4 microtask hops
    // (U1.finally → F1 resolves → flush awaits → flush returns →
    // flushDone .then) — bound the loop to 10 to leave headroom on
    // a slower scheduler.
    for (let i = 0; i < 10; i++) await Promise.resolve()
    // The bug: flush resolved while write2 is still in flight.
    // Correct semantics: flush should still be pending — runs[1]
    // hasn't settled, so the drain isn't done.
    expect(entryAt(runs, 1).settled).toBe(false)
    expect(flushResolved).toBe(false)

    // Settle write2; drain completes.
    entryAt(runs, 1).resolve()
    await flushDone
    expect(flushResolved).toBe(true)
  })

  it('flush() is a no-op when nothing is scheduled', async () => {
    const { write, runs } = makeControllableWriter()
    const writer = createDebouncedWriter(write, 0)
    await writer.flush()
    expect(runs.length).toBe(0)
  })
})
