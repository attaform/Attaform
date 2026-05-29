import { toRaw } from 'vue'
import type { WriteMeta } from '../types/types-api'
import { isPathPrefix, segmentsForPathKey, type Path, type PathKey } from './paths'

/**
 * Per-(union-path, outgoing-disc-value) snapshot stashed on a
 * discriminated-union switch. `value` is the deep-cloned outgoing
 * subtree (detached from Vue's reactive graph); `blankPaths` is the
 * subset of the form's `blankPaths` set whose keys live under the
 * union path at the moment of the switch.
 *
 * The snapshot is in-memory only — never persisted, never on
 * `form.value` — and is consulted on the next switch-out for the same
 * disc value to restore the prior typed state.
 */
export type VariantSnapshot = {
  readonly value: unknown
  readonly blankPaths: ReadonlyArray<PathKey>
}

/**
 * Per-form variant-memory factory. Owns one
 * `Map<unionPathKey, Map<discValue, VariantSnapshot>>` and the
 * manipulation API that keeps the map in sync with structural form
 * mutations (array reshapes, resets, whole-form replacements). Pulled
 * out of `create-form-store.ts` so the union-reshape logic stays
 * focused on the reshape itself; the memory is a self-contained
 * bookkeeping concern that doesn't need to live in the same closure.
 *
 * The factory takes no parameters — the only state it owns is its own
 * map. Callers feed it raw `Path`s / `PathKey`s and the array-op
 * metadata that flows through `WriteMeta.arrayOp`.
 */
export interface VariantMemory {
  /** Empty all snapshots. Called on `reset()` / whole-form replace. */
  clear(): void
  /**
   * Drop snapshots whose union key sits at or under `parentPath`. Used
   * by `resetField` and after structural array mutations to forget the
   * outgoing-variant cache for paths that no longer exist (or whose
   * indices have shifted).
   */
  clearUnderPath(parentPath: Path): void
  /**
   * Translate an array-op delta into snapshot drops. Insert/remove
   * shift every snapshot whose index segment is at or past the touched
   * slot; move clears the moved range; swap clears the two touched
   * indices; replace-at clears the replaced index.
   */
  applyArrayOp(arrayPath: Path, op: NonNullable<WriteMeta['arrayOp']>): void
  /** Stash the outgoing-variant snapshot for a future switch-in. */
  recordOutgoing(unionKey: PathKey, discValue: unknown, snapshot: VariantSnapshot): void
  /** Look up the incoming-variant snapshot, or `undefined`. */
  lookupIncoming(unionKey: PathKey, discValue: unknown): VariantSnapshot | undefined
}

export function createVariantMemory(): VariantMemory {
  const memory = new Map<PathKey, Map<unknown, VariantSnapshot>>()

  function clearAtArrayIndices(arrayPath: Path, indexFilter: (idx: number) => boolean): void {
    for (const memKey of [...memory.keys()]) {
      const segs = segmentsForPathKey(memKey)
      if (segs === null) continue
      if (!isPathPrefix(arrayPath, segs)) continue
      if (segs.length <= arrayPath.length) continue
      const idxSeg = segs[arrayPath.length]
      if (typeof idxSeg !== 'number') continue
      if (indexFilter(idxSeg)) memory.delete(memKey)
    }
  }

  return {
    clear(): void {
      memory.clear()
    },
    clearUnderPath(parentPath: Path): void {
      for (const memKey of [...memory.keys()]) {
        const segs = segmentsForPathKey(memKey)
        if (segs === null) continue
        if (isPathPrefix(parentPath, segs)) memory.delete(memKey)
      }
    },
    applyArrayOp(arrayPath: Path, op: NonNullable<WriteMeta['arrayOp']>): void {
      switch (op.kind) {
        case 'insert':
        case 'remove':
          // Every index at or past the touched slot now refers to a
          // different element (shifted up by an insert, down by a remove).
          clearAtArrayIndices(arrayPath, (i) => i >= op.index)
          return
        case 'move': {
          const lo = Math.min(op.from, op.to)
          const hi = Math.max(op.from, op.to)
          clearAtArrayIndices(arrayPath, (i) => i >= lo && i <= hi)
          return
        }
        case 'swap':
          clearAtArrayIndices(arrayPath, (i) => i === op.a || i === op.b)
          return
        case 'replace-at':
          clearAtArrayIndices(arrayPath, (i) => i === op.index)
          return
      }
    },
    recordOutgoing(unionKey: PathKey, discValue: unknown, snapshot: VariantSnapshot): void {
      let perUnion = memory.get(unionKey)
      if (perUnion === undefined) {
        perUnion = new Map<unknown, VariantSnapshot>()
        memory.set(unionKey, perUnion)
      }
      perUnion.set(discValue, snapshot)
    },
    lookupIncoming(unionKey: PathKey, discValue: unknown): VariantSnapshot | undefined {
      return memory.get(unionKey)?.get(discValue)
    },
  }
}

/**
 * Deep-clone a value read out of the live reactive form tree, for the
 * variant-memory snapshot. Calls `toRaw` at every level to bypass
 * Vue's on-demand reactivity wrapping, preserves `BigInt`, `Date`,
 * `Map`, `Set` natively (Zod can validate these at leaves), and
 * recurses through plain arrays + objects. Detached from the form's
 * reactive graph, so a later `form.value = nextForm` doesn't mutate
 * the snapshot.
 */
export function cloneVariantSnapshot(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const raw = toRaw(value as object)
  if (raw instanceof Date) return new Date(raw.getTime())
  if (raw instanceof Map) {
    const out = new Map<unknown, unknown>()
    for (const [k, v] of raw.entries()) out.set(cloneVariantSnapshot(k), cloneVariantSnapshot(v))
    return out
  }
  if (raw instanceof Set) {
    const out = new Set<unknown>()
    for (const v of raw) out.add(cloneVariantSnapshot(v))
    return out
  }
  if (raw instanceof RegExp) return new RegExp(raw.source, raw.flags)
  if (Array.isArray(raw)) {
    const out: unknown[] = new Array(raw.length)
    for (let i = 0; i < raw.length; i++) out[i] = cloneVariantSnapshot(raw[i])
    return out
  }
  const src = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(src)) out[k] = cloneVariantSnapshot(src[k])
  return out
}
