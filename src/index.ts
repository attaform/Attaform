/**
 * `attaform` — framework-agnostic core entry.
 *
 * Consumers under bare Vue 3:
 *
 *   import { createApp } from 'vue'
 *   import { createAttaform, useForm } from 'attaform'
 *   import { attaform as attaformVite } from 'attaform/vite'
 *
 *   createApp(App).use(createAttaform()).mount('#app')
 *
 * Consumers under Nuxt don't touch this file — the Nuxt module (`./nuxt`
 * subpath) installs everything automatically.
 *
 * For schema-library integrations (Zod v3 today; Valibot / ArkType /
 * custom later), import from the matching subpath:
 *
 *   import { useForm, zodAdapter } from 'attaform/zod-v3'
 */

// The plugin, registry, serialization helpers
export { createAttaform } from './runtime/core/plugin'
export type { AttaformPluginOptions } from './runtime/core/plugin'
export {
  createRegistry,
  getRegistryFromApp,
  kAttaformRegistry,
  useRegistry,
} from './runtime/core/registry'
export type { AttaformRegistry, SerializedFormData } from './runtime/core/registry'
export { hydrateAttaformState, renderAttaformState } from './runtime/core/serialize'
export type { SerializedAttaformState } from './runtime/core/serialize'
export { escapeForInlineScript } from './runtime/core/serialize-script'

// The abstract useForm — works against any AbstractSchema implementation.
// Zod-typed wrappers live at `/zod` (v4) and `/zod-v3`; this entry is the
// schema-agnostic core.
export { useAbstractForm as useForm } from './runtime/composables/use-abstract-form'

// Shared wizard / register / error-code / unset / injectForm surface —
// single source under `runtime/_shared-exports.ts`, re-exported
// verbatim from every entry.
export * from './runtime/_shared-exports'

// The v-register directive (registered automatically by createAttaform,
// but exported for advanced consumers who install directives themselves).
export { vRegister, isRegisterValue, assignKey } from './runtime/core/directive'
export { defaultCoercionRules, defineCoercion } from './runtime/core/schema-coerce'

// Public types
export type {
  AbstractSchema,
  ApiErrorDetails,
  ApiErrorEntry,
  ApiErrorEnvelope,
  AttaformDefaults,
  CoercionEntry,
  CoercionRegistry,
  CoercionResult,
  CustomDirectiveRegisterAssignerFn,
  DefaultValuesResponse,
  DisplayCtx,
  DisplayMachine,
  DisplayState,
  ErrorsProxyShape,
  FieldMetaPayload,
  FieldState,
  FieldStateMap,
  FieldStateMapEntry,
  FormErrorRecord,
  FormErrorsSurface,
  FormKey,
  FormMeta,
  FormStorage,
  FormStorageKind,
  GetDisplayState,
  HandleSubmit,
  HistoryConfig,
  MetaTrackerValue,
  OnError,
  OnInvalidSubmitPolicy,
  OnSubmit,
  PendingValidationStatus,
  PersistConfig,
  PersistConfigOptions,
  PersistIncludeMode,
  ReactiveValidationStatus,
  RegisterDirective,
  RegisterFlatPath,
  RegisterOptions,
  RegisterSelectModifier,
  RegisterTextModifier,
  RegisterTransform,
  RegisterValue,
  SetValueCallback,
  SetValuePayload,
  SettledValidationStatus,
  SlimPrimitiveKind,
  SlimRuntimeOf,
  SubmitHandler,
  ValidateOn,
  ValidateOnConfig,
  UseFormReturnType,
  UseFormConfiguration,
  ValidationError,
  ValidationResponse,
  ValidationResponseWithoutValue,
  WriteMeta,
} from './runtime/types/types-api'

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
  ValueOfUnion,
  WriteShape,
} from './runtime/types/types-core'

// Path primitives — exposed for consumers writing custom adapters that
// need to canonicalise user-provided paths.
export {
  canonicalizePath,
  isPathPrefix,
  parseDottedPath,
  ROOT_PATH,
  ROOT_PATH_KEY,
} from './runtime/core/paths'
export type { Path, PathKey, Segment } from './runtime/core/paths'

// DevTools window-bridge contract the Nuxt overlay panel + iframe page
// consume at runtime. Exposed so the panel components (shipped as `.vue`
// files under `dist/runtime/`) can `import { … } from 'attaform'`
// without brittle relative paths into the bundled chunk layout.
export { DEVTOOLS_WINDOW_KEY } from './runtime/core/devtools-shared'
export type { AttaformDevtoolsBridge } from './runtime/core/devtools-shared'

// Error classes — every library-emitted error extends `AttaformError`, so
// consumers can write a single polymorphic catch (`catch (e) { if (e
// instanceof AttaformError) ... }`) instead of OR-chaining instanceof
// checks for each subclass.
export {
  AnonPersistError,
  AttaformError,
  InvalidPathError,
  InvalidUseFormConfigError,
  OutsideSetupError,
  RegistryNotInstalledError,
  ReservedFormKeyError,
  SubmitErrorHandlerError,
} from './runtime/core/errors'

// Library-default reducer for `getDisplayState`. Public so adopter
// reducers can compose with it (a layered reducer that defers to the
// library default for the unhandled cases). `makeDefaultDisplayState`
// rebuilds it with custom anti-flash timing; `DEFAULT_TIMINGS` is the
// shipped `{ showDelay, minVisible }`.
export {
  DEFAULT_TIMINGS,
  defaultDisplayState,
  makeDefaultDisplayState,
} from './runtime/core/display-state'
export type { DisplayTimings } from './runtime/core/display-state'

// Library-default list of identifier name stems flagged as sensitive
// (password, ssn, cvv, token, etc.). Compose with `sensitiveNames` at
// the global or per-form level to extend:
//
//   useForm({ sensitiveNames: [...DEFAULT_SENSITIVE_NAMES, 'mrn'] })
//
// The resolved list gates persistence writes and multi-tab sync
// broadcasts — one configurable source of truth for "what counts as
// sensitive" across those surfaces. (DevTools renders raw values by
// design; it does not redact.)
export { DEFAULT_SENSITIVE_NAMES } from './runtime/core/persistence/sensitive-names'

// API-error parser. Pure transformation: takes a server response in
// the common shapes (wrapped envelope, raw details record) and returns
// `ValidationError[]` + an `ok` discriminator for malformed payloads.
// Pair with `form.setFieldErrors` (or `addFieldErrors`) to apply the
// result. The form API has no `setFieldErrorsFromApi` shortcut by
// design — keeping the parse step explicit is the consolidation move
// that lets the form's setter surface stay narrow.
export { parseApiErrors, PARSE_API_ERRORS_DEFAULTS } from './runtime/core/parse-api-errors'
export type { ParseApiErrorsOptions, ParseApiErrorsResult } from './runtime/core/parse-api-errors'
