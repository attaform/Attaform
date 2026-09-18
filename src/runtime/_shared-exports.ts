/**
 * Re-export barrel for everything schema-agnostic: the surface every
 * public entry file ships verbatim. Two bands live here:
 *
 * 1. The composable surface: the wizard orchestrator, the per-field
 *    registration helpers, the form-context injection helpers, the
 *    stable error-code identifiers, and the displayed-empty sentinel.
 * 2. The framework-agnostic core: the plugin + registry, the
 *    serialization helpers, the `v-register` directive, the coercion
 *    surface, the path primitives, the devtools bridge, the error
 *    classes, the display-state reducer, and all schema-agnostic
 *    public types.
 *
 * Every public entry file (`attaform`, `attaform/zod`,
 * `attaform/zod-v3`, `attaform/zod-v4` and `attaform/abstract`) does
 * `export *` from this module. Routing the whole schema-agnostic
 * surface through one source is what makes each entry self-sufficient:
 * the barrel and the zod entries no longer diverge on core (they carry
 * the same core), so the only thing an entry adds on top is its ONE
 * schema binding.
 *
 * Tree-shaking: `sideEffects: false` in package.json + the per-entry
 * Rollup builds keep the barrel from defeating per-entry pruning. A
 * consumer importing only `useForm` from `attaform/zod-v4` still gets
 * a bundle carrying nothing else from this barrel, because the unused
 * names are eliminated at build time. The standing gate is the set of
 * `import:` tripwires in `.size-limit.js` (the `{ useForm } only`,
 * `{ injectForm } only`, `{ useRegister } only`, and
 * `{ createAttaform } only` caps), which bundle a single named import
 * and tree-shake the rest. The whole-entry caps there cannot see a
 * single-import regression; these can.
 *
 * Names that stay per-entry (do NOT add them here):
 * - `useForm`, whose source differs per entry (unified dispatcher,
 *   v3-typed, v4-typed), and `useAbstractForm` on `attaform/abstract`.
 * - `fieldMeta`, `withMeta` and `FieldMetaPayload`, re-exported per
 *   entry because the Zod major decides `withMeta`'s cloning strategy.
 * - Adapter-specific symbols (`zodAdapter`, `assertZodVersion`,
 *   `kindOf`, `ZodKind`) and per-adapter types, which diverge between
 *   v3 and v4.
 * - The `useForm`-adjacent projection types (`UseFormConfig`,
 *   `UseFormReturn` and their per-major variants), per entry for the
 *   same reason. The BASE types they are built from
 *   (`UseFormConfiguration`, `UseFormReturnType`) do live here.
 * - `AbstractSchema`, the multi-schema-lib surface exclusive to
 *   `attaform/abstract`.
 */

// Re-export for nested components that want to reach the nearest
// ancestor form (or an arbitrary form by key) without prop-threading.
// The consumer supplies the `Form` generic; the composable's docblock
// carries the type-erasure reasoning.
export { injectForm } from './composables/use-form-context'

// Ambient bridge for components that wrap a single field and want to
// re-bind v-register onto an inner native element. For wrappers that
// bind multiple fields (compound forms), prefer `injectForm`.
export { useRegister } from './composables/use-register'
export type { UseRegisterOptions, UseRegisterReturn } from './composables/use-register'

// Multistep-form orchestrator. Composes existing `useForm` instances
// into a wizard with navigation, status aggregation, and activation
// lifecycle. See the composable's docblock for invariants.
export { useWizard } from './composables/use-wizard'
export { injectWizard } from './composables/inject-wizard'
export type { InjectWizardInput } from './composables/inject-wizard'
export { lazy } from './core/wizard-lazy'
export { gate } from './core/wizard-gate'
export type {
  WizardAggregateError,
  AnyForm,
  CompiledStep,
  FormStatus,
  FormStatusSeed,
  GateMarker,
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

// The `unset` sentinel. Pass it in `defaultValues`, `setValue` or
// `reset` to mark a primitive leaf displayed-empty while storage holds
// the slim default; `src/runtime/core/unset.ts` has the full docblock.
export { unset, isUnset } from './core/unset'
export type { Unset } from './core/unset'

// ── Framework-agnostic core ────────────────────────────────────────
// Relocated from `src/index.ts` so every entry (not just the barrel)
// is self-sufficient. All schema-agnostic; additive to the zod entries.

// The plugin, registry, serialization helpers.
export { createAttaform } from './core/plugin'
export type { AttaformPluginOptions } from './core/plugin'
export { createRegistry, getRegistryFromApp, kAttaformRegistry, useRegistry } from './core/registry'
export type { AttaformRegistry, SerializedFormData } from './core/registry'
export { hydrateAttaformState, renderAttaformState } from './core/serialize'
export type { SerializedAttaformState } from './core/serialize'
export { escapeForInlineScript } from './core/serialize-script'

// The v-register directive (delivered by the Vite / Nuxt plugin's
// compile-time binding or by installVRegister from attaform/directive;
// exported here for advanced consumers who install directives themselves).
export { vRegister, assignKey } from './core/directive'
export { isRegisterValue } from './core/register-protocol'

// Path primitives, exposed for a consumer writing a custom adapter that
// has to canonicalise user-provided paths.
export {
  canonicalizePath,
  isPathPrefix,
  parseDottedPath,
  ROOT_PATH,
  ROOT_PATH_KEY,
} from './core/paths'
export type { Path, PathKey, Segment } from './core/paths'

// DevTools window-bridge contract the Nuxt overlay panel + iframe page
// consume at runtime. Exposed so the panel components (shipped as `.vue`
// files under `dist/runtime/`) can `import { … } from 'attaform'`
// without brittle relative paths into the bundled chunk layout.
export { DEVTOOLS_WINDOW_KEY } from './core/devtools-shared'
export type { AttaformDevtoolsBridge } from './core/devtools-shared'

// Error classes. Every Attaform-emitted error extends `AttaformError`,
// so a consumer writes one polymorphic catch
// (`catch (e) { if (e instanceof AttaformError) ... }`) rather than
// OR-chaining an instanceof check per subclass.
export {
  AttaformError,
  InvalidPathError,
  InvalidUseFormConfigError,
  OutsideSetupError,
  RegistryNotInstalledError,
  ReservedFormKeyError,
  SubmitErrorHandlerError,
} from './core/errors'

// Schema-agnostic public types. `AbstractSchema` and `FieldMetaPayload`
// are deliberately NOT here; the docblock's per-entry note says why.
export type {
  CustomDirectiveRegisterAssignerFn,
  DisplayState,
  ErrorInput,
  ErrorsProxyShape,
  FieldState,
  FieldStateMap,
  FieldStateMapEntry,
  FormErrorRecord,
  FormErrorsSurface,
  FormKey,
  FormMeta,
  HandleSubmit,
  HistoryPlugin,
  Json,
  MetaTrackerValue,
  OnError,
  OnSubmit,
  PendingValidationStatus,
  ReactiveValidationStatus,
  RegisterDirective,
  RegisterFlatPath,
  RegisterOptions,
  RegisterSelectModifier,
  RegisterTextModifier,
  RegisterTransform,
  RegisterValue,
  SchemaDefaultsResult,
  SchemaParseErrorWithData,
  SchemaParseErrorWithoutData,
  SchemaParseResult,
  SchemaParseSuccess,
  SetValueCallback,
  SetValuePayload,
  SettledValidationStatus,
  SlimPrimitiveKind,
  SubmitHandler,
  ValidateOn,
  ValidateOnConfig,
  UseFormReturnType,
  UseFormConfiguration,
  ValidationError,
  ValidationResponse,
  ValidationResponseWithoutValue,
  ParseOptions,
  WriteMeta,
} from './types/types-api'

export type {
  ArrayItem,
  ArrayPath,
  DeepPartial,
  DefaultValuesInput,
  DefaultValuesShape,
  FlatPath,
  GenericForm,
  IsTuple,
  IsUnion,
  JoinSegments,
  KeyofUnion,
  LiftedValueShape,
  NestedReadType,
  NestedType,
  PartialFlatPath,
  Primitive,
  RecordPath,
  RecordValue,
  ValueOfUnion,
  WriteShape,
} from './types/types-core'
