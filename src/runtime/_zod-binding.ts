/**
 * The unified Zod binding — the one schema binding shared by the two
 * entries that default to Zod: `attaform/zod` and the bare `attaform`
 * barrel. Pairs with `_shared-exports.ts` (the schema-agnostic core):
 * an entry that wants the Zod-default surface is exactly
 * `export * from './_shared-exports'` + `export * from './_zod-binding'`.
 *
 * What lives here (everything that is Zod-specific but major-agnostic):
 * - `useForm` — the runtime dispatcher that inspects the schema's shape
 *   and routes to the v3 or v4 adapter. Build-time plugins rewrite the
 *   `attaform/zod` specifier to a single major so the dispatcher and the
 *   unused adapter tree-shake away; the runtime path is the no-plugin
 *   fallback.
 * - `fieldMeta` / `withMeta` — backed by a shared cross-adapter store so
 *   writes are visible at lookup whichever adapter runs; `withMeta`
 *   runtime-branches on schema shape for the right cloning strategy.
 * - `FieldMetaPayload` — the augmentable metadata interface, kept
 *   adjacent to `fieldMeta` / `withMeta`.
 * - The `useForm` projection types (`UseFormConfig` / `UseFormReturn`
 *   and their per-major variants) and the v4 `PathInput` / `PathOutput`
 *   helpers.
 *
 * The disjoint-name contract with `_shared-exports.ts` (so a consuming
 * entry can `export *` from both without a collision): the shared module
 * ships the BASE types `UseFormConfiguration` / `UseFormReturnType`;
 * this module ships the Zod PROJECTIONS built from them
 * (`UseFormConfig` / `UseFormReturn`). Distinct names, no overlap.
 */

export { useForm } from './adapters/unified/use-form'
export type {
  UseFormConfig,
  UseFormConfigV3,
  UseFormConfigV4,
  UseFormReturn,
  UseFormReturnV3,
  UseFormReturnV4,
} from './adapters/unified/types-unified'
export type { PathInput, PathOutput } from './adapters/zod-v4'
export { fieldMeta, withMeta } from './adapters/unified/field-meta'
export type { FieldMetaPayload } from './core/field-meta'
