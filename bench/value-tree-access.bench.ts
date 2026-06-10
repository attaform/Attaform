/**
 * Value-tree access decomposition bench (T5): what does the deep reactive
 * `ref` cost on the READ path, and is any of it a bustable win over a raw
 * walk + manual reactivity?
 *
 * `form = ref(stubbedInitialData)` (create-form-store.ts:1321) is a deep
 * reactive Proxy doing double duty: the value store AND the fine-grained
 * reactivity engine. Every value read funnels through
 * `getAtPath(form.value, segments)` inside a `computed(...)`
 * (build-form-api.ts:345 `pathToRef`, register-api.ts:173 `innerRef`,
 * `getValueAtPath` at create-form-store.ts:2873), so the proxy's get/has
 * traps record per-PROPERTY deps -- a write to one leaf wakes only the
 * computeds that read it. The ledger's floor ("shallow values + Map-driven
 * reactivity") would split those two jobs: a RAW value store + a hand-rolled
 * per-path version-token Map.
 *
 * `getAtPath` does `key in record` (a `has` trap) + `record[key]` (a `get`
 * trap) per level, so a depth-L read pays ~2L proxy-trap dispatches on a
 * proxy vs ~2L plain property reads on a raw object. This bench sizes that
 * delta in the two contexts it actually occurs in:
 *
 *   untracked  -- a read OUTSIDE any active effect (the internal guard /
 *                snapshot / write-path reads). Vue's trap bails early when
 *                nothing is tracking, so this is the trap-DISPATCH floor.
 *                Delta vs raw = the byte-identical sub-lever (route internal
 *                reads through `toRaw(form.value)`): safe, no contract change.
 *   tracked    -- a read INSIDE a recomputing `computed` (the per-keystroke
 *                reactive wave: a write invalidates the edited field's
 *                computeds, each re-runs ONE `getAtPath` WITH dep-tracking).
 *                `triggerRef` stands in for the write's invalidation so the
 *                cell isolates the read-recompute cost from the write cost.
 *                Compared against the FLOOR alternative -- one token dep + a
 *                raw walk -- so the delta is what the full "shallow + manual
 *                reactivity" rearchitecture would actually recover per
 *                reactive read (computed machinery cancels in the delta).
 *
 * DELTAS:
 *   untracked proxy - untracked raw      = sub-lever (ii) per internal read.
 *   tracked proxy   - tracked token+raw  = full-floor per reactive read.
 *
 * Depth L in {1, 4, 16} sweeps the per-level trap cost (traps ~ 2L). Field
 * count is NOT an axis: a single read is O(depth), and post-P3 a keystroke
 * re-evaluates O(1) fields, so per-keystroke read VOLUME is small and
 * depth-bounded. The amortised O(F) first-access proxy CREATION cost is not
 * re-measured here -- it is folded into render and already measured healthy/
 * O(F) by P5's `noreg` SSR floor and P4's init decomposition.
 */

import { bench, describe } from 'vitest'
import { computed, ref, shallowRef, toRaw, triggerRef } from 'vue'
import { getAtPath } from '../src/runtime/core/path-walker'
import type { Path } from '../src/runtime/core/paths'

// A single nesting chain l0.l1...l{L-1} with a string leaf at depth L.
function makeChain(len: number): Record<string, unknown> {
  let node: unknown = 'leaf-value'
  for (let i = len - 1; i >= 0; i--) node = { [`l${i}`]: node }
  return node as Record<string, unknown>
}
const chainPath = (len: number): Path => Array.from({ length: len }, (_, i) => `l${i}`)

const DEPTHS = [1, 4, 16]

// Sink so the engine can't dead-code-eliminate the reads.
let sink: unknown

describe('value-tree access: deep-proxy read cost vs raw walk (T5)', () => {
  for (const L of DEPTHS) {
    const tree = makeChain(L)
    const path = chainPath(L)

    // The production store shape: a deep reactive ref. `proxyVal` is the
    // deep Proxy; `rawVal` is the underlying plain object (toRaw bypasses it).
    const r = ref(tree)
    const proxyVal = r.value
    const rawVal = toRaw(proxyVal)

    bench(`untracked proxy L=${L}`, () => {
      sink = getAtPath(proxyVal, path)
    })
    bench(`untracked raw L=${L}`, () => {
      sink = getAtPath(rawVal, path)
    })

    // Tracked: a computed that re-runs one getAtPath WITH dep-tracking each
    // time its dep is invalidated -- exactly one reactive read per keystroke.
    const cProxy = computed(() => getAtPath(r.value, path))
    void cProxy.value // prime: create nested proxies + establish the dep set
    bench(`tracked proxy L=${L}`, () => {
      triggerRef(r)
      sink = cProxy.value
    })

    // Floor alternative: one token dep + a RAW walk (no proxy, no per-level
    // tracking) -- the "shallow + Map-driven reactivity" read shape.
    const token = shallowRef(0)
    const cToken = computed(() => {
      void token.value
      return getAtPath(rawVal, path)
    })
    void cToken.value
    bench(`tracked token+raw L=${L}`, () => {
      triggerRef(token)
      sink = cToken.value
    })
  }
})

// Keep `sink` observably used across the module.
export const __sink = () => sink
