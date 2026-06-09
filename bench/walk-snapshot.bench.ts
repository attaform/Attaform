/**
 * P2 probe — repeated path-walks + blur-dedup snapshot clones.
 *
 * The complexity ledger (PERF-ANALYSIS.md row P2) flags two suspected
 * "redundant O(D)/O(scope)" costs on the write / validation path:
 *
 *   1. GUARD WALK — the cross-variant DU write guard
 *      (create-form-store.ts:2093-2116) runs a per-ancestor loop on every
 *      write with `path.length >= 2`, calling
 *      `schema.getUnionDiscriminatorAtPath(ancestorPath)` + slicing the
 *      ancestor path at each step, EVEN for a schema with zero unions
 *      (where the lookup always returns undefined and the loop is a no-op).
 *      Same guard as ledger row T1.
 *   2. BLUR-DEDUP SNAPSHOT — every committed blur-mode validation deep-clones
 *      its validation scope into `pathSnapshots` (create-form-store.ts:2693-2696)
 *      so a later blur can value-compare and skip a redundant revalidation.
 *
 * This probe MEASURES whether either is a bustable prize, on the same
 * "measure the candidate prize, don't trust the ledger's stated floor"
 * discipline that flipped P1 (where the named fix was 0% and the real lever
 * was the AbortController the ledger never flagged).
 *
 * Why a primitive microbench, not an end-to-end loop: both costs live behind
 * the validation scheduler (blur-mode async commits), and a blur-mode e2e
 * loop accumulates unflushed microtasks/timers and skews later iterations
 * (the same skew the matrix bench and the P1 alloc probe call out). So we
 * time the exact bustable primitives directly, with the REAL cached schema
 * lookup for the guard and the REAL `structuralSnapshot` for the clone.
 *
 * ── Block 1: guard walk ──────────────────────────────────────────────────
 * `getUnionDiscriminatorAtPath` is CACHED (abstract-schema-factory.ts:677 —
 * a `canonicalizePath().key` Map lookup, itself cache-hit O(1)), so the hot
 * path (repeated writes to the same field) pays only D x (slice + two cached
 * Map hits) per write. Cells:
 *   guard current -> the real loop with the real cached lookup, at depth D.
 *   guard gated   -> the candidate bust: an init-time `hasAnyDiscriminatedUnion`
 *                    flag short-circuits the whole loop for a zero-union
 *                    schema (T1's recorded O(1) floor). Models the skip.
 * Prize = hz(gated) / hz(current). A large absolute gap would revive T1;
 * a sub-microsecond one confirms T1's refutation (the guard is cache-cheap).
 *
 * ── Block 2: blur-dedup snapshot ─────────────────────────────────────────
 * The clone scope = the VALIDATION scope. Under subtree-scope (CORE-P1a,
 * `hasContainerOrRootRefine() === false`) only the edited subtree is cloned;
 * under whole-form scope (a container/root refine present — the cross-field
 * eligibility shape) the WHOLE form is cloned per blur commit. Cells sweep
 * field count F:
 *   snapshot whole-form F={5,50,500} -> the container-refine residual, O(F).
 *   snapshot subtree (leaf)          -> the refine-free CORE-P1a case: clone
 *                                       only the edited leaf, F-independent.
 *   dedup compare F={5,50,500}       -> the READER (create-form-store.ts:3230):
 *                                       getAtPath x2 + diffAndApply over the
 *                                       subtree-AT-PATH, NOT the whole scope.
 * Read: the whole-form / subtree ratio is exactly what CORE-P1a already saves
 * a refine-free form. The residual whole-form clone is REQUIRED for the dedup
 * to stay byte-identical (the validated value must be stored to compare a
 * later blur against), so it is not a free bust — only a scope to narrow,
 * which CORE-P1a already did.
 *
 * NOTE: no `old:`/`new:` cells, so scripts/check-bench.mjs skips this file —
 * these are absolute-ops probes for the dashboard, like matrix.bench.ts and
 * alloc-churn.bench.ts.
 */

import { bench, describe } from 'vitest'
import { z } from 'zod'
import { zodAdapter } from '../src/zod-v4'
import { getAtPath } from '../src/runtime/core/path-walker'
import { diffAndApply, structuralSnapshot } from '../src/runtime/core/diff-apply'

// Black-box sink: force every allocation to escape so V8's escape analysis
// cannot elide the clone/array we are trying to measure.
let sink: unknown
function blackbox(value: unknown): void {
  sink = value
}
function readSink(): unknown {
  return sink
}

// ── Block 1: guard walk ────────────────────────────────────────────────────

describe('P2: cross-variant DU guard (per nested write, zero unions)', () => {
  // A nested zero-union schema `a.b.c.d` (depth 4 — a realistic nested form;
  // the guard loop runs path.length-1 = 3 ancestor checks). Built through the
  // real adapter so `getUnionDiscriminatorAtPath` is the real cached method.
  const rawSchema = z.object({
    a: z.object({ b: z.object({ c: z.object({ d: z.string() }) }) }),
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema: any = (zodAdapter(rawSchema) as any)('walk-bench', { maxRecursionDepth: 10 })
  const path = ['a', 'b', 'c', 'd']

  // Prime the discriminator + path caches so we time STEADY STATE (the hot
  // path: repeated writes to the same field), not the one-time first miss.
  for (let i = 0; i < path.length - 1; i++) schema.getUnionDiscriminatorAtPath(path.slice(0, i + 1))

  // Today: the loop runs unconditionally for path.length >= 2 (every nested
  // or array-row write), doing a slice + cached lookup per ancestor.
  bench('guard current (slice + cached lookup per ancestor)', () => {
    if (path.length >= 2) {
      for (let i = 0; i < path.length - 1; i++) {
        const ancestorPath = path.slice(0, i + 1)
        const du = schema.getUnionDiscriminatorAtPath(ancestorPath)
        if (du === undefined) continue
        // Zero-union schema: never reached. (A real DU ancestor would do the
        // getAtPath + variant-default checks the loop guards behind this.)
        blackbox(du)
      }
    }
    blackbox(path)
  })

  // The candidate bust: an init-time `hasAnyDiscriminatedUnion` flag lets a
  // zero-union schema skip the whole loop. Models the short-circuit.
  // Init-time gate flag: does ANY path in this schema resolve to a DU? A real
  // `hasAnyDiscriminatedUnion` walks the schema once at construction; here it
  // is derived at runtime (false for this zero-union schema) so the cell
  // models a genuine flag check rather than a compile-time-dead branch.
  const hasAnyDiscriminatedUnion = path
    .map((_, i) => path.slice(0, i + 1))
    .some((p) => schema.getUnionDiscriminatorAtPath(p) !== undefined)
  bench('guard gated (has-any-DU init flag short-circuits)', () => {
    // A zero-union schema short-circuits before the per-ancestor loop; the
    // flag check is the entire per-write guard cost. The body models the work
    // that WOULD run (never reached here — the flag is false).
    if (hasAnyDiscriminatedUnion && path.length >= 2) {
      for (let i = 0; i < path.length - 1; i++) blackbox(path.slice(0, i + 1))
    }
    blackbox(path)
  })
})

// ── Block 2: blur-dedup snapshot ────────────────────────────────────────────

function flatValue(fieldCount: number): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  for (let i = 0; i < fieldCount; i++) o[`f${i}`] = `v${i}`
  return o
}

describe('P2: blur-dedup snapshot clone (per committed blur-mode validation)', () => {
  for (const F of [5, 50, 500]) {
    // Whole-form scope (container/root refine present): the entire form is
    // deep-cloned per blur commit. O(F).
    const wholeForm = flatValue(F)
    bench(`snapshot whole-form F=${F} (container-refine scope)`, () => {
      blackbox(structuralSnapshot(wholeForm))
    })
  }

  // Subtree scope (CORE-P1a, refine-free form): a single-leaf write clones
  // only the edited leaf. F-independent — this is what CORE-P1a saves the
  // common form down to.
  const leaf = 'v499'
  bench('snapshot subtree (leaf, CORE-P1a scope)', () => {
    blackbox(structuralSnapshot(leaf))
  })

  // The READER: a later blur extracts the subtree-AT-PATH from the snapshot
  // and the live form and diffs them. Only the leaf is walked, so this is
  // O(subtree-at-path), independent of the snapshot's scope size.
  for (const F of [5, 50, 500]) {
    const snapshot = flatValue(F)
    const live = flatValue(F)
    live[`f${F - 1}`] = 'changed'
    const leafPath = [`f${F - 1}`]
    bench(`dedup compare F=${F} (reader: getAtPath x2 + diffAndApply)`, () => {
      const snapshotSubtree = getAtPath(snapshot, leafPath)
      const liveSubtree = getAtPath(live, leafPath)
      let changed = false
      diffAndApply(snapshotSubtree, liveSubtree, leafPath, () => {
        changed = true
      })
      blackbox(changed)
    })
  }
})

// Keep the sink referenced at module scope so it is never dead code.
void readSink
