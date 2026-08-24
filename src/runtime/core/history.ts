import { computed, shallowRef } from 'vue'
import type {
  HistoryKernel,
  HistoryModule,
  HistoryPlugin,
  ErrorCell,
  WriteMeta,
} from '../types/types-api'
import { DEFAULT_HISTORY_MAX_SNAPSHOTS, normalizeNumericOption } from './defaults'
import { structuralSnapshot } from './diff-apply'
import type { PathKey } from './paths'

/**
 * Bounded undo/redo history for a form, delivered as the `attaform/history`
 * entry: `useForm({ history: historyPlugin({ max }) })`. The plugin object
 * is the delivery seam — `useForm` calls its `attach(kernel)` against the
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
 * `blankPaths` set, and both error stores' entries — everything `undo()`
 * needs to restore a position without consulting neighbours.
 *
 * `reset()` is treated as an ordinary mutation: `applyFormReplacement`
 * fires `onFormChange`, the post-reset state lands as a new position, and
 * the pre-reset state stays one undo away. Persistence hydration
 * (`meta.hydration === true`) is the floor — the buffer wipes and reseeds
 * from the post-hydration snapshot, so `undo()` can't reach back into a
 * pre-hydration default the consumer never saw.
 *
 * Field record state (touched / focused / blurred / connected) is
 * deliberately NOT snapshotted. Those flags represent UI interaction
 * history and shouldn't rewind when the user hits undo — a field that
 * was touched stays touched.
 */

export type HistoryPluginOptions = {
  /**
   * Cap on total reachable positions (the current one plus everything
   * reachable via `undo()` / `redo()`). Default `128`. When a fresh
   * mutation would exceed it, the oldest position is dropped. `0` keeps
   * no positions beyond the current state — history effectively off,
   * preserved as an explicit override.
   */
  max?: number
}

type ErrorCellEntries = ReadonlyArray<readonly [PathKey, ErrorCell]>

type HistorySnapshot = {
  readonly form: unknown
  readonly blankPaths: ReadonlyArray<PathKey>
  readonly errorCells: ErrorCellEntries
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

  function captureSnapshot(): HistorySnapshot {
    return {
      form: structuralSnapshot(kernel.form.value),
      blankPaths: [...kernel.blankPaths],
      errorCells: captureErrorCells(kernel.errorCells),
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

  const unsubscribeChange = kernel.onFormChange((_next, meta?: WriteMeta) => {
    if (suppressNext) {
      suppressNext = false
      return
    }
    // Persistence hydration is the floor: the transient pre-hydration
    // default (briefly held between mount and hydrate-apply) is library
    // plumbing, not state the user ever saw. Reseed from the
    // post-hydration snapshot so `undo()` can't reach back into a state
    // the consumer never produced. Any in-flight mutations that landed
    // in the race window between mount and hydration are also dropped —
    // pre-hydration writes were operating against stale defaults anyway.
    if (meta?.hydration === true) {
      clear()
      return
    }
    // Drop the redo branch past the cursor, append the new position,
    // evict from the front once over capacity (FIFO — the oldest
    // reachable state falls off, same as the prior delta-chain model).
    const next = positions.value.slice(0, cursor.value + 1)
    next.push(captureSnapshot())
    while (next.length > capacity) next.shift()
    positions.value = next
    cursor.value = next.length - 1
  })

  function restorePosition(snap: HistorySnapshot): void {
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
    cursor.value = nextCursor
    restorePosition(snap)
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
      unsubscribeChange()
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
  // is preserved — equivalent in effect to disabling history (no
  // undo/redo positions retained), but consumers may set it explicitly.
  const max = normalizeNumericOption({
    value: options?.max ?? DEFAULT_HISTORY_MAX_SNAPSHOTS,
    source: 'historyPlugin({ max })',
    allowInfinity: false,
    min: 0,
    defaultValue: DEFAULT_HISTORY_MAX_SNAPSHOTS,
  })
  return {
    attach: (kernel) => createHistoryRuntime(kernel, max),
  }
}
