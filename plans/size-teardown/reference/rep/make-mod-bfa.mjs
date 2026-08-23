// Generate build-form-api-mod.ts: the two hand-written getter forests
// replaced by loops over one canonical key list. Line ranges verified
// against main @ fb532ad9: getFormMetaBase body 156-293, formMeta 711-876.
import { readFileSync, writeFileSync } from 'node:fs'

const SRC = '/Users/ozzy/Projects/attaform/src/runtime/core/build-form-api.ts'
const OUT = new URL('./build-form-api-mod.ts', import.meta.url).pathname

const lines = readFileSync(SRC, 'utf8').split('\n')

const KEYS_DECL = `
const FIELD_STATE_KEYS_ALL = [
  'value', 'original', 'pristine', 'dirty', 'focused', 'blurred', 'touched', 'interacted',
  'blurredAfterInteraction', 'connected', 'element', 'elements', 'updatedAt', 'errors',
  'ownErrors', 'validating', 'valid', 'transforming', 'busy', 'transformError', 'displayState',
  'showErrors', 'showPending', 'showSuccess', 'showIdle', 'firstError', 'firstOwnError', 'path',
  'id', 'aria', 'key', 'blank', 'disabled', 'label', 'description', 'placeholder', 'meta',
] as const
const DISPLAY_DERIVED = new Set(['displayState', 'showErrors', 'showPending', 'showSuccess', 'showIdle', 'firstError', 'firstOwnError'])
const META_SPECIAL = new Set(['errors', 'validating', 'valid', 'transforming', 'busy'])
const ROLLUP_MIRROR_KEYS = FIELD_STATE_KEYS_ALL.filter((k) => !DISPLAY_DERIVED.has(k))
const META_MIRROR_KEYS = FIELD_STATE_KEYS_ALL.filter((k) => !META_SPECIAL.has(k))
`

const GET_FORM_META_BASE = `  const getFormMetaBase = (): FormMetaBase => {
    let rollup: FieldStateBase | undefined
    const rootBase = (): FieldStateBase =>
      (rollup ??= buildContainerFieldStateBase(state, ROOT_PATH, ROOT_PATH_KEY, formInstanceId).base)
    const o: Record<string, unknown> = {
      submitting: state.submitting.value,
      submissionAttempts: state.submissionAttempts.value,
      departAttempts: state.departAttempts.value,
      submitError: state.submitError.value,
      submitted: state.submitted.value,
      instanceId: formInstanceId,
    }
    for (const k of ROLLUP_MIRROR_KEYS) {
      Object.defineProperty(o, k, {
        get: () => (rootBase() as unknown as Record<string, unknown>)[k],
        enumerable: true,
        configurable: true,
      })
    }
    Object.defineProperty(o, 'errorCount', {
      get: () => rootBase().errors.length,
      enumerable: true,
      configurable: true,
    })
    return o as unknown as FormMetaBase
  }`

const FORM_META = `  const metaTarget: Record<string, unknown> = {
    validating: computed(() => state.activeValidations.value > 0 || rootFieldState.value.validating),
    valid,
    errors: metaErrors,
    transforming: computed(() => state.activeTransforms.value > 0 || rootFieldState.value.transforming),
    busy: computed(
      () =>
        state.activeValidations.value > 0 ||
        state.activeTransforms.value > 0 ||
        rootFieldState.value.validating ||
        rootFieldState.value.transforming
    ),
    submitting,
    submissionAttempts,
    departAttempts,
    submitError,
    submitted,
    instanceId: formInstanceId,
  }
  for (const k of META_MIRROR_KEYS) {
    Object.defineProperty(metaTarget, k, {
      get: () => (rootFieldState.value as unknown as Record<string, unknown>)[k],
      enumerable: true,
      configurable: true,
    })
  }
  Object.defineProperty(metaTarget, 'errorCount', {
    get: () => metaErrors.value.length,
    enumerable: true,
    configurable: true,
  })
  const formMeta = readonly(reactive(metaTarget)) as FormMeta<Form>`

// Sanity-check boundaries before splicing.
const expect = (n, frag) => {
  if (!lines[n - 1].includes(frag)) throw new Error(`line ${n} mismatch: ${lines[n - 1]}`)
}
expect(156, 'const getFormMetaBase = (): FormMetaBase => {')
expect(293, '}')
expect(711, 'const formMeta = readonly(')
expect(876, ') as FormMeta<Form>')

const out = [
  ...lines.slice(0, 155),
  GET_FORM_META_BASE,
  ...lines.slice(293, 710),
  FORM_META,
  ...lines.slice(876),
]
// Prepend key-list decls after the import block (imports end before line 57 'export ...').
const text = out.join('\n')
const marker = "import { buildValuesProxy } from './values-proxy'"
if (!text.includes(marker)) throw new Error('import marker missing')
writeFileSync(OUT, text.replace(marker, marker + '\n' + KEYS_DECL))
console.log('wrote', OUT)
