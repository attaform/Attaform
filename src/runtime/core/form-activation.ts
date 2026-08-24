import { toRaw } from 'vue'
import type { ValidationError } from '../types/types-api'
import type { GenericForm } from '../types/types-core'
import type { FormState } from './create-form-store'
import { walkAuthoredFromConstraints } from './unset-walker'
import { AttaformErrorCode } from './error-codes'
import { mergeSparseHydration } from './merge-hydration'
import { ROOT_PATH, ROOT_PATH_KEY } from './paths'

/**
 * The async-defaults orchestrator — the heavy half of `activate()` /
 * `rehydrate()`. The gating flips (`activated`, `hydrating`,
 * `activationPromise`) are published synchronously by the kernel's
 * `fireFactory` BEFORE this runs, so gated readers and
 * `onServerPrefetch` observe a consistent in-flight state; this module
 * owns everything after: running the factory, marking its leaves
 * authored, sparse-merging the resolved value over the live form,
 * kicking the post-hydration validation sweep, and settling the
 * error / resolved flags.
 */
export async function runFactoryAndApply<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  factory: () => unknown | Promise<unknown>
): Promise<void> {
  // Stale-while-revalidate: keep any prior `HydrationFailed` entry
  // visible until the new attempt settles. Same contract field
  // errors follow under `field.validating === true` — the surface
  // shouldn't flicker to empty during the retry. The entry is
  // replaced on failure or cleared on success in the branches
  // below. (`hydrating` was already flipped true, synchronously, by
  // `fireFactory`.)
  try {
    const value = await factory()
    // The factory's resolved value is the consumer's late-bound
    // `defaultValues`. Mark every leaf inside it as authored so the
    // schema-error filter surfaces verdicts at preprocess / coerce
    // paths the factory named with explicit undefined (same contract
    // as the sync `defaultValues` argument applied at construction).
    walkAuthoredFromConstraints(value, [], st.authoredPaths)
    const full = mergeSparseHydration(
      toRaw(st.form.value) as F,
      value,
      st.schema as unknown as Parameters<typeof mergeSparseHydration>[2]
    )
    st.applyFormReplacement(full, { hydration: true })
    st.scheduleFieldValidation([], true /* immediate */)
    // Success: drop the previous attempt's error (if any) from both
    // surfaces. New attempt's verdict has landed; the stale entry
    // would now mis-narrate the state.
    clearHydrationFailedEntry(st)
    st.hydrateError.value = null
    st.defaultsResolved.value = true
  } catch (error) {
    // Failure: replace (clear-then-append) so a repeat failure
    // produces a single fresh entry rather than accumulating dupes.
    // Single ValidationError covers both surfaces: the dedicated
    // `hydrateError` ref AND the standard schema-side channel
    // that feeds `form.meta.errors`. SSR factory rejections cross
    // the wire through the schema side; the local `hydrateError`
    // ref points to the same entry so the shape is identical at
    // every read site.
    clearHydrationFailedEntry(st)
    st.hydrateError.value = appendHydrationFailedEntry(st, error)
  } finally {
    st.hydrating.value = false
  }
}

function clearHydrationFailedEntry<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>
): void {
  const existing = st.errorCells.get(ROOT_PATH_KEY)?.schema
  if (existing === undefined || existing.length === 0) return
  const filtered = existing.filter((e) => e.code !== AttaformErrorCode.HydrationFailed)
  if (filtered.length !== existing.length) {
    st.setSchemaErrorsForPath([...ROOT_PATH], [...filtered])
  }
}

function appendHydrationFailedEntry<F extends GenericForm, G extends GenericForm = F>(
  st: FormState<F, G>,
  error: unknown
): ValidationError {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Hydration failed'
  const entry: ValidationError = {
    message,
    path: [...ROOT_PATH],
    code: AttaformErrorCode.HydrationFailed,
  }
  const existing = st.errorCells.get(ROOT_PATH_KEY)?.schema ?? []
  st.setSchemaErrorsForPath([...ROOT_PATH], [...existing, entry])
  return entry
}
