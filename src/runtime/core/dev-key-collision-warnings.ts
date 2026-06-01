/**
 * Dev-only shared-key collision diagnostics for `useForm`. When two
 * `useForm({ key })` calls land on the same key, they resolve to one
 * `FormStore` by design (the shared-store semantic), and the second
 * call's schema and `persist:` config are silently dropped in favour of
 * the first's wiring. The warnings here surface that divergence so a
 * genuine collision (two unrelated call sites that happen to agree on a
 * key) is diagnosable rather than silent.
 *
 * This whole module is loaded behind a `__DEV__`-gated dynamic import in
 * `use-abstract-form.ts`. A production build folds that gate to `false`,
 * dead-code-eliminates the `import()` call, and leaves this module an
 * unreferenced chunk the consumer's bundler drops. Keeping the warnings
 * here (rather than as plain functions called from the gated block)
 * matters because esbuild removes the inline dead branch but NOT a
 * top-level function it is the sole caller of: tree-shaking runs before
 * the define-fold, so the function survives. A separately-imported
 * module sidesteps that and keeps the cluster out of every consumer's
 * production bundle.
 */
import { normalizePersistConfig, PERSISTENCE_MODULE_KEY } from './persistence'
import type { PersistenceHandle } from './persistence'
import type { FormStore } from './create-form-store'
import type {
  AbstractSchema,
  FormKey,
  PersistConfig,
  PersistConfigOptions,
} from '../types/types-api'
import type { GenericForm } from '../types/types-core'

/**
 * Dev-only: warn when a second `useForm` lands on the same key with
 * a structurally-different schema. Two schemas resolve their own
 * fingerprints; we compare the strings and flag mismatches. An adapter
 * `fingerprint()` that rejects is caught (never crashes the form) and
 * surfaced as a `console.error` in dev: the mismatch check is skipped,
 * matching the "allow the inconsistency" failure mode. See
 * `AbstractSchema.fingerprint()` in types-api.ts for the contract.
 */
export async function warnOnSchemaFingerprintMismatch(
  key: FormKey,
  existing: AbstractSchema<GenericForm, GenericForm>,
  incoming: AbstractSchema<GenericForm, GenericForm>
): Promise<void> {
  let existingFp: string
  let incomingFp: string
  try {
    existingFp = await existing.fingerprint()
    incomingFp = await incoming.fingerprint()
  } catch (error) {
    console.error(
      `[attaform] fingerprint() rejected for key "${key}"; skipping mismatch check.`,
      error
    )
    return
  }
  if (existingFp === incomingFp) return
  console.warn(
    `[attaform] useForm() calls with key "${key}" use different schemas; first wins, second is ignored. Use identical schemas or unique keys.\n  existing: ${existingFp}\n  incoming: ${incomingFp}`
  )
}

/**
 * Dev-only: warn when a second `useForm` lands on the same key with a
 * `persist:` config that diverges from what the first call wired. The
 * persist channel is single-IO (one storage key, one debounce timer);
 * silent drop is a high-stakes footgun ("I configured persist but
 * sessionStorage is empty"). Skipped when the second call passes no
 * persist config (intentional inheritance), and when the comparison
 * is deemed equivalent (same `storage` reference / kind, same `key`,
 * same `debounceMs`). Custom adapter functions compare by reference
 * — distinct closures look distinct, which is conservative but
 * correct: distinct closures may persist to different backends.
 */
export function warnOnPersistDivergence<F extends GenericForm>(
  key: FormKey,
  existing: FormStore<F, GenericForm>,
  incomingPersist: PersistConfig | undefined
): void {
  if (incomingPersist === undefined) return
  const wired = existing.modules.get(PERSISTENCE_MODULE_KEY) as PersistenceHandle | undefined
  const incomingNormalized = normalizePersistConfig(incomingPersist)
  if (wired === undefined) {
    console.warn(
      `[attaform] useForm({ key: "${key}" }) passed a persist config but the first useForm({ key }) call didn't wire persistence; the new config is silently dropped. Pass persist on the first call, or remove persist here to make the inheritance explicit.`
    )
    return
  }
  if (persistConfigsEquivalent(wired.config, incomingNormalized)) return
  console.warn(
    `[attaform] useForm({ key: "${key}" }) passed a persist config that differs from the first useForm({ key }) call's; first wins, this one is ignored.\n  wired:    ${describePersist(wired.config)}\n  incoming: ${describePersist(incomingNormalized)}`
  )
}

function persistConfigsEquivalent(a: PersistConfigOptions, b: PersistConfigOptions): boolean {
  if (a.storage !== b.storage) return false
  if ((a.key ?? undefined) !== (b.key ?? undefined)) return false
  if ((a.debounceMs ?? undefined) !== (b.debounceMs ?? undefined)) return false
  return true
}

function describePersist(config: PersistConfigOptions): string {
  const storage = typeof config.storage === 'string' ? config.storage : 'custom-adapter'
  const parts = [`storage=${storage}`]
  if (config.key !== undefined) parts.push(`key=${config.key}`)
  if (config.debounceMs !== undefined) parts.push(`debounceMs=${config.debounceMs}`)
  return `{ ${parts.join(', ')} }`
}
