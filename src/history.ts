/**
 * `attaform/history` — the undo/redo plugin, as a standalone entry so
 * the form core doesn't carry the history runtime for forms that never
 * opt in.
 *
 * Enable it per form:
 *
 * ```ts
 * import { historyPlugin } from 'attaform/history'
 *
 * const form = useForm({ schema, history: historyPlugin({ max: 200 }) })
 * ```
 *
 * One plugin instance is a reusable configuration: hand the same
 * instance to as many forms as you like and each still gets its own
 * independent chain.
 *
 * The consolidated `form.history` namespace (`undo`, `redo`, `clear`,
 * `canUndo`, `canRedo`, `size`) is always present on the form return;
 * without the plugin its methods are no-ops and its flags read
 * `false` / `0`.
 */

export { historyPlugin } from './runtime/core/history'
export type { HistoryPluginOptions } from './runtime/core/history'
export type { HistoryPlugin } from './runtime/types/types-api'
