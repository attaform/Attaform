/**
 * Re-export barrel for the names every public entry file ships
 * verbatim: the wizard surface, the per-field registration helpers,
 * the form-context injection helper, the stable error-code identifiers,
 * and the displayed-empty sentinel. Four entry files —
 * `attaform`, `attaform/zod`, `attaform/zod-v3`, `attaform/zod-v4` —
 * each `export *` this module to drop ~28 LOC of duplicated re-exports
 * per file (~90 LOC overall) and route the explanatory docblocks
 * through one source.
 *
 * Tree-shaking: `sideEffects: false` in package.json + the per-entry
 * Rollup builds keep the barrel from defeating per-entry pruning. A
 * consumer importing only `useForm` from `attaform/zod-v4` still gets
 * a bundle that includes nothing else from this barrel — the unused
 * names are eliminated at build time. `useWizard` shares a chunk with
 * `useAbstractForm`, so that elimination is intra-chunk; the standing
 * gate is the set of `import:` tripwires in `.size-limit.js` (the
 * `{ useForm } only`, `{ injectForm } only`, and `{ useRegister }
 * only` caps), which bundle a single named import and tree-shake the
 * rest. The whole-entry caps there cannot see a single-import
 * regression; these can.
 *
 * Names that stay per-entry (do NOT add them here):
 * - `useForm` — different source per entry (abstract / unified
 *   dispatcher / v3-typed / v4-typed).
 * - `fieldMeta`, `withMeta`, `FieldMetaPayload` — adapter-specific
 *   re-exports per entry (Zod major matters for `withMeta`'s cloning
 *   strategy).
 * - Adapter-specific symbols (`zodAdapter`, `assertZodVersion`,
 *   `kindOf`, `ZodKind`, `UnsupportedSchemaError`, etc.) and per-
 *   adapter types — they diverge between v3 and v4.
 * - `useForm`-adjacent config / return types — different per entry
 *   for the same divergence reason.
 *
 * Names that stay only on `attaform` (the framework-agnostic core):
 * - `createAttaform`, `createRegistry`, `useRegistry`, the
 *   serialisation helpers, the directive, the schema-coerce surface,
 *   the path primitives, error classes, devtools bridge.
 */

// Re-export for nested components that want to reach the nearest
// ancestor form (or an arbitrary form by key) without prop-threading.
// The consumer supplies the `Form` generic — see the composable's
// docblock for the type-erasure reasoning.
export { injectForm } from './composables/use-form-context'

// Ambient bridge for components that wrap a single field and want to
// re-bind v-register onto an inner native element. For wrappers that
// bind multiple fields (compound forms), prefer `injectForm`.
export { useRegister } from './composables/use-register'
export type { UseRegisterReturn } from './composables/use-register'

// Multistep-form orchestrator. Composes existing `useForm` instances
// into a wizard with navigation, status aggregation, and activation
// lifecycle. See the composable's docblock for invariants.
export { useWizard } from './composables/use-wizard'
export { injectWizard } from './composables/inject-wizard'
export type { InjectWizardInput } from './composables/inject-wizard'
export { lazy } from './core/wizard-lazy'
export type {
  WizardAggregateError,
  AnyForm,
  CompiledStep,
  FormStatus,
  LazyMarker,
  StepSlot,
  UseWizardReturnType,
  WizardCtx,
  WizardCtxForm,
  WizardOnError,
  WizardOnSubmit,
  WizardOptions,
  WizardPersistFn,
  WizardRestoreFn,
  WizardRestoreState,
  WizardStatusesProxy,
  WizardSubmitContext,
} from './types/types-wizard'

// Stable error-code identifiers for library-emitted ValidationErrors.
// Use in tests and error-routing UI in place of brittle message-string
// matching. `atta:` prefix denotes the framework-agnostic core; the Zod
// adapter emits `zod:` codes (computed from `issue.code`) and consumer
// codes use whatever prefix the consumer picks (`api:`, `auth:`, etc.).
export { AttaformErrorCode } from './core/error-codes'

// The `unset` sentinel — pass in `defaultValues`, `setValue`, or `reset`
// to mark a primitive leaf as displayed-empty while storage holds the
// slim default. See `src/runtime/core/unset.ts` for the full docblock.
export { unset, isUnset } from './core/unset'
export type { Unset } from './core/unset'
