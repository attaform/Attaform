/**
 * P1 allocation probe — per-keystroke alloc churn on the validation scheduler.
 *
 * The complexity ledger (PERF-ANALYSIS.md row P1) flags `scheduleFieldValidation`
 * (create-form-store.ts:2589) for allocating fresh objects on every change/blur
 * keystroke with no pool. This bench MEASURES whether that churn is worth busting.
 *
 * STATUS: Bust B SHIPPED 2026-06-09 — the per-keystroke `new AbortController()`
 * was swapped for a one-shot `aborted` boolean on the entry (the `flag` cell,
 * the live scheduler's pattern). Bust A (pool the entry) stays DECLINED: pooled
 * ≈ current, so the entry object is not the cost. The controller cells below are
 * the retained pre-swap comparison that justified the swap.
 *
 * Why a primitive microbench, not an end-to-end keystroke loop: P1's allocations
 * only fire in 'change'/'blur' mode (submit-mode early-returns at :2595, which is
 * exactly why the matrix keystroke sweeps — all `validateOn: 'submit'` — never
 * exercise P1). A 'change'-mode end-to-end loop queues a setTimeout per write that
 * never flushes inside a tight bench, accumulating timers and skewing later
 * iterations (the same skew the matrix bench and the T4 probe call out). So we
 * follow the established Bust-3 / T4 discipline: time the exact SCHEDULING-TIME
 * primitive directly. The bustable work is synchronous and lives at
 * create-form-store.ts:2597-2612 — this models those lines faithfully:
 *
 *     const prev = state.get(key)
 *     if (prev !== undefined) {
 *       if (prev.timer !== null) clearTimeout(prev.timer)
 *       prev.controller.abort()              // cancel the in-flight prior run
 *     }
 *     const controller = new AbortController()
 *     const fresh = { controller, timer: null, settled: false, released: false }
 *     state.set(key, fresh)
 *     const myEpoch = ++epoch
 *     const run = () => { ... }              // closed over by the (omitted) timer
 *
 * The timer (`setTimeout(run, debounce)`) is omitted on purpose: it is IDENTICAL
 * across every variant below (a bust does not touch it), so excluding it keeps the
 * current-vs-pooled delta honest while avoiding timer accumulation in the loop.
 *
 * Four cells decompose the cost so every candidate prize is unambiguous:
 *
 *   controller-only -> the floor under the entry-pool bust. AbortController is
 *                      one-shot; once aborted it is dead, so a fresh one is
 *                      unavoidable per schedule IF the controller stays. Pooling
 *                      the entry CANNOT remove this.
 *   current         -> today: fresh AbortController + fresh entry object + run
 *                      closure + map.set (mirrors :2597-2612).
 *   pooled          -> bust A (P1-as-specified): reuse the entry object (mutate
 *                      in place), skip the map.set. Controller + closure stay.
 *   epoch-only      -> a REJECTED form of bust B: drop the AbortController but
 *                      cancel via a shared generation counter (`myGen !== gen`).
 *                      Declined because a per-path counter compared across map
 *                      delete / clear / recreate invites stale-run ↔ recreated-
 *                      token collisions; the shipped design reads a flag on the
 *                      run's OWN entry instead (see `flag`).
 *   flag            -> bust B AS SHIPPED: drop the AbortController, cancel via a
 *                      one-shot `aborted` boolean on the entry. Byte-identical
 *                      because the validation controller's signal never escapes —
 *                      `validateAtPath` (:2655) takes no signal, and the signal
 *                      was checked only internally (:2613 / :2657) to drop a
 *                      superseded verdict, which `fresh.aborted` reproduces.
 *                      (The transform subsystem's `ctx.signal` at :1724 is a
 *                      SEPARATE controller that does escape and must stay.)
 *
 * Read:  prize A    = hz(pooled) / hz(current)   (pooling the entry object)
 *        prize B    = hz(flag) / hz(current)     (dropping the controller, shipped)
 *        floor      = hz(controller-only)        (cost the entry-pool can't shed)
 * Bust A bought nothing (current ≈ pooled). Bust B is the realized win: `flag`
 * vs `current` is exactly the `new AbortController()` removal (both allocate a
 * fresh entry + closure + map.set). Weigh it in ABSOLUTE per-keystroke terms —
 * it fires change/blur only, against a deferred parse that dominates the
 * keystroke — not by the headline ratio.
 *
 * NOTE: no `old:`/`new:` cells here, so scripts/check-bench.mjs skips this file —
 * these are absolute-ops probes for the dashboard, like matrix.bench.ts.
 */

import { bench, describe } from 'vitest'

type Entry = {
  // `controller` models the PRE-SWAP scheduler (the comparison cells);
  // `aborted` models the SHIPPED one. Both optional so the historical
  // controller cells and the live `flag` cell share one structural type.
  controller?: AbortController
  aborted?: boolean
  timer: ReturnType<typeof setTimeout> | null
  settled: boolean
  released: boolean
  run?: () => void
}

// Black-box sink: force every allocation to escape so V8's escape analysis
// cannot elide the object/closure we are trying to measure.
let sink: unknown
function blackbox(value: unknown): void {
  sink = value
}
// Touch `sink` after the run so the assignment is observably live.
function readSink(): unknown {
  return sink
}

const KEY = 'f0'

describe('P1: validation-schedule alloc (per keystroke, change/blur mode)', () => {
  // The irreducible floor: only the AbortController is freshly allocated; the
  // entry is reused so we isolate JUST the controller alloc + the prior-abort.
  {
    const state = new Map<string, Entry>()
    state.set(KEY, {
      controller: new AbortController(),
      timer: null,
      settled: false,
      released: false,
    })
    bench('controller-only (irreducible floor)', () => {
      const prev = state.get(KEY)
      if (prev === undefined) return
      if (prev.timer !== null) clearTimeout(prev.timer)
      prev.controller.abort()
      const controller = new AbortController()
      prev.controller = controller
      blackbox(controller)
    })
  }

  // Today's pattern: a fresh entry object + run closure + map.set per keystroke.
  {
    const state = new Map<string, Entry>()
    let epoch = 0
    state.set(KEY, {
      controller: new AbortController(),
      timer: null,
      settled: false,
      released: false,
    })
    bench('current (fresh entry + closure + map.set)', () => {
      const prev = state.get(KEY)
      if (prev !== undefined) {
        if (prev.timer !== null) clearTimeout(prev.timer)
        prev.controller.abort()
      }
      const controller = new AbortController()
      const fresh: Entry = { controller, timer: null, settled: false, released: false }
      state.set(KEY, fresh)
      const myEpoch = ++epoch
      const run = (): void => {
        if (controller.signal.aborted) return
        if (fresh.settled) return
        void myEpoch
      }
      fresh.run = run
      blackbox(run)
    })
  }

  // The bust: reuse the entry object, skip the map.set. AbortController and the
  // run closure are still allocated (neither can be pooled).
  {
    const state = new Map<string, Entry>()
    let epoch = 0
    state.set(KEY, {
      controller: new AbortController(),
      timer: null,
      settled: false,
      released: false,
    })
    bench('pooled (reuse entry, mutate in place)', () => {
      const entry = state.get(KEY)
      if (entry === undefined) return
      if (entry.timer !== null) clearTimeout(entry.timer)
      entry.controller.abort()
      const controller = new AbortController()
      entry.controller = controller
      entry.timer = null
      entry.settled = false
      entry.released = false
      const myEpoch = ++epoch
      const run = (): void => {
        if (controller.signal.aborted) return
        if (entry.settled) return
        void myEpoch
      }
      entry.run = run
      blackbox(run)
    })
  }

  // Bust B: no AbortController at all. Cancellation rides a generation counter —
  // the run drops its verdict when a newer schedule has bumped `gen`, the same
  // outcome `controller.signal.aborted` gates today. Reuses the entry too, so
  // this isolates the controller-removal prize on top of the entry pool.
  {
    const state = new Map<string, Entry>()
    let gen = 0
    state.set(KEY, {
      controller: new AbortController(),
      timer: null,
      settled: false,
      released: false,
    })
    bench('epoch-only (no AbortController, generation counter)', () => {
      const entry = state.get(KEY)
      if (entry === undefined) return
      if (entry.timer !== null) clearTimeout(entry.timer)
      const myGen = ++gen
      entry.timer = null
      entry.settled = false
      entry.released = false
      const run = (): void => {
        if (myGen !== gen) return
        if (entry.settled) return
        void myGen
      }
      entry.run = run
      blackbox(run)
    })
  }

  // Bust B AS SHIPPED: drop the AbortController, cancel via a one-shot
  // `aborted` boolean on the entry — NOT a generation counter (the
  // epoch-only cell above models that rejected alternative). A fresh
  // schedule still allocates a fresh entry + run closure + map.set (same
  // as `current`); the ONLY removed work is the `new AbortController()`,
  // so `flag` vs `current` isolates exactly the controller-removal prize.
  // The run reads `fresh.aborted` through its own captured entry, so it is
  // collision-proof and survives the entry's map deletion (a supersede /
  // cancel latches the flag before deleting). Mirrors the live scheduler
  // at create-form-store.ts:2598-2613 post-swap.
  {
    const state = new Map<string, Entry>()
    state.set(KEY, { aborted: false, timer: null, settled: false, released: false })
    bench('flag (shipped: aborted boolean on entry)', () => {
      const prev = state.get(KEY)
      if (prev !== undefined) {
        if (prev.timer !== null) clearTimeout(prev.timer)
        prev.aborted = true
      }
      const fresh: Entry = { aborted: false, timer: null, settled: false, released: false }
      state.set(KEY, fresh)
      const run = (): void => {
        // `=== true` only because the shared `Entry` type leaves `aborted`
        // optional for the controller cells; the live scheduler's field is a
        // non-optional `boolean`, read as a bare `if (fresh.aborted)`.
        if (fresh.aborted === true) return
        if (fresh.settled) return
      }
      fresh.run = run
      blackbox(run)
    })
  }
})

// Keep the sink referenced at module scope so it is never dead code.
void readSink
