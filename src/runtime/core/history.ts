/**
 * Bounded undo/redo history for a form, delivered as the `attaform/history`
 * entry: `useForm({ history: historyPlugin({ max }) })`. The plugin object
 * is the delivery seam: `useForm` calls its `attach(kernel)` against the
 * form's store, so the runtime here rides the consumer's own import instead
 * of every form's eager path.
 *
 * Storage is a snapshot ring buffer: `positions` holds one full
 * `HistorySnapshot` per reachable state (oldest → newest) and `cursor`
 * points at the current one. Every form change appends a snapshot (dropping
 * any redo branch past the cursor); `undo()` / `redo()` move the cursor and
 * restore that position's snapshot wholesale. When the buffer exceeds the
 * capacity cap, the oldest position falls off the front (FIFO eviction).
 *
 * Each snapshot carries the form value (deep structural clone), the
 * `blankPaths` set, both error stores' entries, and the per-element
 * bookkeeping a typed array op moves with its elements (identity orders,
 * the baselines that travel with them, the removed-baseline set):
 * everything `undo()` needs to restore a position without consulting
 * neighbours. That bookkeeping is read against the baseline the position
 * was taken under, so a `reset()` starts a new generation, and a position
 * from an earlier one restores its value alone, by position.
 *
 * `reset()` is treated as an ordinary mutation: `applyFormReplacement`
 * fires `onFormChange`, the post-reset state lands as a new position, and
 * the pre-reset state stays one undo away. Persistence hydration
 * (`meta.hydration === true`) is the floor: the buffer wipes and reseeds
 * from the post-hydration snapshot, so `undo()` can't reach back into a
 * pre-hydration default the consumer never saw. The reseed runs once the
 * hydration step has adopted its value as the baseline.
 *
 * Interaction state does not rewind: a field that was touched stays
 * touched. Its records follow their rows instead, the way the typed array
 * ops move them. A restore moves each row present on both sides with its own
 * records, hands the history of a row it takes away to the array, and gives
 * a row it brings back the records it had. So each position keeps the
 * flagged records under its rows: taken with it, joined by those the next
 * write releases, and taken again whenever an undo or redo leaves it.
 */
import { computed, shallowRef, toRaw } from 'vue'
import type {
  HistoryKernel,
  HistoryModule,
  HistoryPlugin,
  ErrorCell,
  WriteMeta,
} from '../types/types-api'
import { migrateMapSubtree, type IndexRemap } from './array-engine'
import { DEFAULT_HISTORY_MAX_SNAPSHOTS, normalizeNumericOption } from './defaults'
import { structuralSnapshot } from './diff-apply'
import { getAtPath } from './path-walker'
import { canonicalizePath, segmentsForPathKey, type Path, type PathKey } from './paths'
import type { FieldRecord, IdentityOrders, StructureSnapshot } from './store-records'

/** Options for `historyPlugin()`, passed as `useForm({ history })`. */
export type HistoryPluginOptions = {
  /**
   * Cap on total reachable positions (the current one plus everything
   * reachable via `undo()` / `redo()`). Default `128`. When a fresh
   * mutation would exceed it, the oldest position is dropped. `0` keeps
   * no positions beyond the current state, so history is effectively off,
   * preserved as an explicit override.
   */
  max?: number
}

type ErrorCellEntries = ReadonlyArray<readonly [PathKey, ErrorCell]>

type HistorySnapshot = {
  readonly form: unknown
  readonly blankPaths: ReadonlyArray<PathKey>
  readonly errorCells: ErrorCellEntries
  readonly structure: StructureSnapshot
  /**
   * Every record under an array element with an interaction flag set, at its
   * path in this position, for a row a restore brings back.
   */
  readonly records: ReadonlyArray<FieldRecord>
  /** The baseline generation `structure` and `records` were taken under. */
  readonly generation: number
}

const flagged = (record: FieldRecord): boolean =>
  record.touched || record.interacted || record.blurredAfterInteraction

// Read raw, so a write made from inside an effect subscribes it to nothing.
function captureRecords(fields: ReadonlyMap<PathKey, FieldRecord>): FieldRecord[] {
  const out: FieldRecord[] = []
  for (const record of toRaw(fields).values()) {
    if (flagged(record) && record.path.some((segment) => typeof segment === 'number')) {
      out.push(record)
    }
  }
  return out
}

// Whether `path` sits under an element of an array `indices` names, at one of
// the indices it holds for that array.
function underIndexIn(path: Path, indices: ReadonlyMap<PathKey, ReadonlySet<number>>): boolean {
  for (let i = 0; i < path.length; i++) {
    const segment = path[i]
    if (
      typeof segment === 'number' &&
      indices.get(canonicalizePath(path.slice(0, i)).key)?.has(segment) === true
    ) {
      return true
    }
  }
  return false
}

/**
 * The row order a restore puts back, planned from the live `current` orders
 * and the `target` orders a position holds, with how each tracked array's
 * elements move from their live slots to the target's, by token, outermost
 * array first. A nested array is looked up at the slot its row lands at,
 * which is where its remap's path points.
 *
 * An array the target does not track was not tracked yet when the position
 * was taken. A typed op tracks an array before it moves anything, and a
 * write with no op keeps its tokens by position, so the position held the
 * elements in their baseline order: the array keeps its baseline and takes
 * that order, with its own tokens, while `holdsList` says the restored value
 * holds it there. Otherwise it goes untracked.
 */
function planOrders(
  current: IdentityOrders,
  target: IdentityOrders,
  holdsList: (arraySegs: Path) => boolean
): { readonly orders: IdentityOrders; readonly remaps: Array<readonly [Path, IndexRemap]> } {
  // The live lists, relocated as each outer array's remap is replayed.
  const live = new Map(current.tokens)
  const liveBaselines = new Map(current.baselines)
  const tokens = new Map(target.tokens)
  const baselines = new Map(target.baselines)
  const remaps: Array<readonly [Path, IndexRemap]> = []
  const depths = new Set<number>()
  for (const key of live.keys()) depths.add(segmentsForPathKey(key)?.length ?? 0)
  for (const depth of [...depths].sort((a, b) => a - b)) {
    for (const [key, ids] of [...live]) {
      const segs = segmentsForPathKey(key)
      if (segs?.length !== depth) continue
      let order = tokens.get(key)
      const baseline = liveBaselines.get(key)
      if (order === undefined) {
        if (baseline === undefined || !holdsList(segs)) continue
        order = baseline
        tokens.set(key, order)
        baselines.set(key, baseline)
      }
      const remap = remapBetween(ids, order)
      if (remap === null) continue
      remaps.push([segs, remap])
      migrateMapSubtree(live, segs, remap, (value) => value)
      migrateMapSubtree(liveBaselines, segs, remap, (value) => value)
    }
  }
  return { orders: { tokens, baselines }, remaps }
}

// The remap taking each element of `from` to the slot its token holds in
// `to`, or null when every element keeps its slot.
function remapBetween(from: readonly string[], to: readonly string[]): IndexRemap | null {
  const slots = new Map(to.map((id, i) => [id, i]))
  const kept = new Set(from)
  const moved = new Map<number, number>()
  const vacated = new Set<number>()
  const fresh = new Set<number>()
  from.forEach((id, i) => {
    const at = slots.get(id)
    if (at === undefined) vacated.add(i)
    else if (at !== i) moved.set(i, at)
  })
  to.forEach((id, i) => {
    if (!kept.has(id)) fresh.add(i)
  })
  if (moved.size === 0 && vacated.size === 0 && fresh.size === 0) return null
  return { moved, vacated, fresh, oldLen: from.length, newLen: to.length }
}

function captureErrorCells(map: Map<PathKey, ErrorCell>): ErrorCellEntries {
  const out: Array<readonly [PathKey, ErrorCell]> = []
  for (const [k, cell] of map) {
    out.push([k, { schema: [...cell.schema], user: [...cell.user] }] as const)
  }
  return out
}

function createHistoryRuntime(kernel: HistoryKernel, max: number): HistoryModule {
  // The ring always holds the current position, so the effective
  // capacity floors at 1: `max: 0` (and `max: 1`) retain no undo/redo
  // positions while `historySize` still reads 1, matching the
  // "current state is always reachable" contract.
  const capacity = Math.max(1, max)
  // Bumped by every `reset()`, which re-anchors the baselines.
  let generation = 0

  function captureSnapshot(): HistorySnapshot {
    return {
      form: structuralSnapshot(kernel.form.value),
      blankPaths: [...kernel.blankPaths],
      errorCells: captureErrorCells(kernel.errorCells()),
      structure: kernel.captureStructure(),
      records: captureRecords(kernel.fields),
      generation,
    }
  }

  // shallowRef: the positions array is replaced wholesale on every
  // mutation, so deep reactivity would only add overhead (and the
  // snapshots must stay detached from Vue's reactive graph anyway).
  const positions = shallowRef<HistorySnapshot[]>([captureSnapshot()])
  const cursor = shallowRef(0)

  // When `undo()` / `redo()` calls `applyFormReplacement`, the
  // resulting `onFormChange` must NOT record a new position (that would
  // duplicate the restored state and truncate the redo branch). This
  // flag suppresses the next change event.
  let suppressNext = false
  let disposed = false

  // The flagged records the write in progress released. The position before
  // the write keeps them, so an undo to it brings their rows back with them.
  let released: FieldRecord[] = []
  kernel.noteReleased = (records) => {
    for (const record of records) if (flagged(record)) released.push(record)
  }

  const unsubscribeChange = kernel.onFormChange((_next, meta?: WriteMeta) => {
    const left = released
    released = []
    if (suppressNext) {
      suppressNext = false
      return
    }
    // Persistence hydration is the floor: the transient pre-hydration
    // default (briefly held between mount and hydrate-apply) is library
    // plumbing, not state the user ever saw. Reseed from the
    // post-hydration snapshot so `undo()` can't reach back into a state
    // the consumer never produced. Any in-flight mutations that landed
    // in the race window between mount and hydration are also dropped:
    // pre-hydration writes were operating against stale defaults anyway.
    // The reseed waits for the hydration step to finish, which adopts the
    // resolved value as the baseline right after this write, so the floor
    // holds that baseline.
    if (meta?.hydration === true) {
      queueMicrotask(() => {
        if (!disposed) clear()
      })
      return
    }
    // Drop the redo branch past the cursor, append the new position,
    // evict from the front once over capacity (FIFO: the oldest
    // reachable state falls off).
    const next = positions.value.slice(0, cursor.value + 1)
    const before = next[next.length - 1]
    if (left.length > 0 && before !== undefined) {
      next[next.length - 1] = { ...before, records: [...before.records, ...left] }
    }
    next.push(captureSnapshot())
    while (next.length > capacity) next.shift()
    positions.value = next
    cursor.value = next.length - 1
  })

  // The current position takes the bookkeeping and the records as they stand
  // now, under the current generation. Returns the bookkeeping.
  function retake(): StructureSnapshot {
    const structure = kernel.captureStructure()
    const current = positions.value[cursor.value]
    if (current !== undefined) {
      const next = [...positions.value]
      next[cursor.value] = {
        ...current,
        structure,
        records: captureRecords(kernel.fields),
        generation,
      }
      positions.value = next
    }
    return structure
  }

  // A reset lands as an ordinary position, captured mid-reset, before the
  // baselines re-anchor. Once they have, the current position takes the
  // bookkeeping as it now stands, under a new generation; the positions
  // before it keep theirs, which no longer applies.
  const unsubscribeReset = kernel.onReset(() => {
    generation += 1
    retake()
  })

  // `live` is the bookkeeping as it stands before the restore.
  function restorePosition(snap: HistorySnapshot, live: StructureSnapshot): void {
    // The per-element bookkeeping goes back first, so the value write below
    // compares each restored row against its own baseline, and the records
    // move with it.
    if (snap.generation === generation) {
      const { orders, remaps } = planOrders(live.identity, snap.structure.identity, (segments) =>
        Array.isArray(getAtPath(snap.form, segments))
      )
      const fresh = new Map<PathKey, ReadonlySet<number>>()
      for (const [segments, remap] of remaps) {
        if (remap.fresh.size > 0) fresh.set(canonicalizePath(segments).key, remap.fresh)
      }
      const returning =
        fresh.size === 0 ? [] : snap.records.filter((record) => underIndexIn(record.path, fresh))
      kernel.restoreStructure({ ...snap.structure, identity: orders }, remaps, returning)
    }
    suppressNext = true
    // Re-seed `blankPaths` BEFORE the form replacement fires. Listeners
    // on `onFormChange` (devtools, the user's own subscriptions) read
    // the form alongside `blankPaths` when deciding what to surface;
    // updating both before the listener loop runs keeps the pair
    // consistent. If blankPaths landed AFTER applyFormReplacement, the
    // listeners would see new form + stale blank set for one tick.
    kernel.blankPaths.clear()
    for (const key of snap.blankPaths) kernel.blankPaths.add(key)
    // Hand the store a fresh clone: `applyFormReplacement` reconciles
    // into the live form in place, and a shared reference would let a
    // later mutation silently rewrite the stored position.
    kernel.applyFormReplacement(structuralSnapshot(snap.form))
    // Rebuild the tagged store from the snapshot. The restore writer
    // clones the entry arrays in, so the ring stays detached; the two
    // sources stay isolated inside each cell.
    kernel.restoreErrorCells(snap.errorCells)
  }

  function stepTo(nextCursor: number): boolean {
    const snap = positions.value[nextCursor]
    if (snap === undefined) return false
    // The position being left takes the history its rows gathered while it
    // was current, so a step back to it brings a row back with all of it.
    const live = retake()
    cursor.value = nextCursor
    restorePosition(snap, live)
    released = []
    return true
  }

  function undo(): boolean {
    return cursor.value > 0 && stepTo(cursor.value - 1)
  }

  function redo(): boolean {
    return cursor.value < positions.value.length - 1 && stepTo(cursor.value + 1)
  }

  function clear(): void {
    positions.value = [captureSnapshot()]
    cursor.value = 0
  }

  return {
    undo,
    redo,
    clear,
    canUndo: computed(() => cursor.value > 0),
    canRedo: computed(() => cursor.value < positions.value.length - 1),
    historySize: computed(() => positions.value.length),
    dispose() {
      disposed = true
      kernel.noteReleased = undefined
      unsubscribeChange()
      unsubscribeReset()
      // Keep only the current position: post-dispose reads stay
      // coherent (`canUndo` / `canRedo` false, `historySize` 1) while
      // the rest of the buffer is released.
      positions.value = positions.value.slice(cursor.value, cursor.value + 1)
      cursor.value = 0
    },
  }
}

/**
 * Create the undo/redo plugin for `useForm({ history })`. See
 * {@link HistoryPlugin} for the full behaviour contract.
 *
 * ```ts
 * import { historyPlugin } from 'attaform/history'
 *
 * const form = useForm({ schema, history: historyPlugin() })
 * // or tune the position cap:
 * const audited = useForm({ schema, history: historyPlugin({ max: 200 }) })
 * ```
 */
export function historyPlugin(options?: HistoryPluginOptions): HistoryPlugin {
  // Sanitise the capacity cap once, at plugin creation (next to the
  // consumer code that supplied it). `NaN` would make the eviction
  // comparison always false (unbounded memory growth); `Infinity`
  // likewise; negatives and non-integers produce confusing eviction
  // behaviour. Falls back to the library default on garbage. `max: 0`
  // is preserved, equivalent in effect to disabling history (no
  // undo/redo positions retained), but consumers may set it explicitly.
  const max = normalizeNumericOption({
    value: options?.max ?? DEFAULT_HISTORY_MAX_SNAPSHOTS,
    source: 'historyPlugin({ max })',
    min: 0,
    defaultValue: DEFAULT_HISTORY_MAX_SNAPSHOTS,
  })
  return {
    attach: (kernel) => createHistoryRuntime(kernel, max),
  }
}
