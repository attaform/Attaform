/**
 * Dev-only shared-key collision diagnostics for `useForm`. When two
 * `useForm({ key })` calls land on the same key, they resolve to one
 * `FormStore` by design (the shared-store semantic), and the second
 * call's schema is silently dropped in favour of the first's wiring.
 * The warnings here surface that divergence so a genuine collision (two
 * unrelated call sites that happen to agree on a key) is diagnosable
 * rather than silent.
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
import type { AbstractSchema, FormKey } from '../types/types-api'
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
