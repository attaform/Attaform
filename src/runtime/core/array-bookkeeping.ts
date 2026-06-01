import type { Ref } from 'vue'
import type { ValidationError } from '../types/types-api'
import {
  changedIndices,
  migrateMapSubtree,
  migrateSetSubtree,
  type IndexRemap,
} from './array-state-migrate'
import type { createArrayIdentity } from './array-identity'
import {
  canonicalizePath,
  isPathPrefix,
  segmentsForPathKey,
  type Path,
  type PathKey,
} from './paths'
import { diffAndApply } from './diff-apply'
import { getAtPath } from './path-walker'
import type { ElementRecord, FieldRecord, OriginalsRecord } from './create-form-store'

/**
 * Per-(field-path) async validation entry. Owns the AbortController +
 * pending-timer for any in-flight or scheduled validation at the path,
 * plus a `settled` flag that prevents double-decrementing the parent
 * counters when a chain's `.finally` has run but its entry is still
 * in the state map awaiting replacement by the next schedule.
 *
 * Re-exported from this module so both the host form-store (which
 * owns the state map and writes new entries) and the array-bookkeeping
 * factory (which aborts entries at vacated indices) share the same
 * structural type.
 */
export type FieldValidationEntry = {
  controller: AbortController
  timer: ReturnType<typeof setTimeout> | null
  settled: boolean
}

/**
 * The state surface the array-bookkeeping factory needs to keep in
 * sync with structural array mutations. Every entry is a reference
 * to one of the form-store's owned maps / refs — the factory holds
 * the references, never owns them, so its lifecycle exactly matches
 * the host store's.
 */
export type ArrayBookkeepingDeps = {
  readonly form: Ref<unknown>
  readonly fields: Map<PathKey, FieldRecord>
  readonly elements: Map<PathKey, ElementRecord>
  readonly userErrors: Map<PathKey, ValidationError[]>
  readonly originals: Map<PathKey, OriginalsRecord>
  readonly blankPaths: Set<PathKey>
  readonly originalBlankPaths: Set<PathKey>
  readonly fieldValidationCounts: Map<PathKey, number>
  readonly fieldValidatingSince: Map<PathKey, number>
  readonly fieldValidationState: Map<PathKey, FieldValidationEntry>
  readonly schemaErrors: Map<PathKey, ValidationError[]>
  readonly activeValidations: Ref<number>
  readonly arrayIdentity: ReturnType<typeof createArrayIdentity>
  readonly touchFieldRecord: (
    pathKey: PathKey,
    path: Path,
    patch: Partial<Omit<FieldRecord, 'path'>>
  ) => void
  readonly decFieldValidation: (key: PathKey) => void
}

export type ArrayBookkeeping = {
  /**
   * Relocate per-element state so it follows an element across a
   * structural mutation rather than bleeding onto the new occupant
   * of the element's old index. Driven by the operation's exact
   * permutation, not by the consumer-facing identity token — the
   * token is a downstream reader, not the source of truth. Every
   * non-derived per-element fact moves:
   *
   *   - `fields`: touched / focused / blurred / connection
   *     bookkeeping, plus the record's embedded `path`.
   *   - `userErrors`: consumer-set errors, plus each error's
   *     embedded `path`.
   *   - `blankPaths`: the cleared-field display flag.
   *   - `originals` / `originalBlankPaths`: the per-element dirty
   *     baseline, so a moved element keeps its OWN dirty verdict
   *     instead of inheriting the slot's. A structural change
   *     (reorder / insert / removal) still dirties the form through
   *     the identity tracker's order comparison
   *     (`hasStructuralChangeUnder`), which the positional baseline
   *     can no longer surface once it travels with the element.
   *
   * Derived state (schema verdicts, validation counts) is not
   * relocated; it is dropped and recomputed by revalidation.
   */
  readonly migrateElementState: (arrayPath: Path, remap: IndexRemap) => void
  /**
   * Register a freshly created element (an insert slot, a replace-at
   * target) the way `applyFormReplacement` registers an appended
   * one: walk its leaves and seed an absence baseline in `originals`
   * (so the new element reads dirty, like an append) plus a field
   * record. Migration has already relocated the prior occupant's
   * state off this slot's keys and deleted them; without this the
   * new element would be invisible to `touch` and read pristine,
   * since `originals` is the leaf registry both consult.
   */
  readonly seedFreshElement: (arrayPath: Path, freshIndex: number) => void
  /**
   * Drop schema verdicts at indices the structural mutation
   * changed. Schema verdicts are derived, not relocated: after a
   * structural mutation the entries at changed indices describe the
   * slots' prior occupants. Drop them synchronously so a stale
   * verdict can't show for the frame before a 'change'-mode
   * revalidation repopulates — and so it doesn't linger at all under
   * a `validateOn` that won't revalidate on this write. The next
   * pass rewrites the whole subtree from the live value.
   */
  readonly dropSchemaErrorsAtChangedIndices: (arrayPath: Path, remap: IndexRemap) => void
  /**
   * Abort any field validation still in flight for leaves of removed
   * elements so a late async resolution can't write a verdict at a
   * dead index, and release the pending counters so `meta.validating`
   * reflects the removal at once. Mirrors the per-entry half of
   * `cancelFieldValidation`, scoped to the vacated indices.
   */
  readonly abortValidationAtVacatedIndices: (arrayPath: Path, remap: IndexRemap) => void
}

export function createArrayBookkeeping(deps: ArrayBookkeepingDeps): ArrayBookkeeping {
  const {
    form,
    fields,
    userErrors,
    originals,
    blankPaths,
    originalBlankPaths,
    fieldValidationCounts,
    fieldValidatingSince,
    fieldValidationState,
    schemaErrors,
    activeValidations,
    arrayIdentity,
    touchFieldRecord,
    decFieldValidation,
  } = deps

  function migrateElementState(arrayPath: Path, remap: IndexRemap): void {
    if (remap.moved.size === 0 && remap.vacated.size === 0) return
    migrateMapSubtree(fields, arrayPath, remap, (record, segments) => ({
      ...record,
      path: segments,
    }))
    migrateMapSubtree(userErrors, arrayPath, remap, (errors, segments) =>
      errors.map((error) => ({ ...error, path: [...segments] }))
    )
    migrateMapSubtree(originals, arrayPath, remap, (record, segments) => ({
      segments,
      value: record.value,
    }))
    migrateSetSubtree(blankPaths, arrayPath, remap)
    migrateSetSubtree(originalBlankPaths, arrayPath, remap)
    // In-flight field-validation counter (`field.validating` mirror).
    // Same identity reasoning as the other path-keyed maps: the spinner
    // belongs to the validating element, not the slot. Self-heals on the
    // next validation pass; this migration just spares the wrong-row
    // visible flicker in between.
    migrateMapSubtree(fieldValidationCounts, arrayPath, remap, (count) => count)
    // The validation-streak anchor travels with the count it parallels, so
    // a moved element's show-delay clock keeps measuring from when ITS
    // streak opened rather than inheriting the slot's.
    migrateMapSubtree(fieldValidatingSince, arrayPath, remap, (since) => since)
    // Nested-array identity: relocate every tracked array sitting under
    // `arrayPath`'s element slots so a nested `v-for :key` stays stable
    // across an outer-array mutation (no token leak, no collision on the
    // new occupant of a vacated slot).
    arrayIdentity.applyRemap(arrayPath, remap)
  }

  function seedFreshElement(arrayPath: Path, freshIndex: number): void {
    const elementPath: Path = [...arrayPath, freshIndex]
    const now = new Date().toISOString()
    diffAndApply(undefined, getAtPath(form.value, elementPath), elementPath, (patch) => {
      if (patch.kind !== 'added') return
      const { key } = canonicalizePath(patch.path)
      if (!originals.has(key)) originals.set(key, { segments: patch.path, value: undefined })
      touchFieldRecord(key, patch.path, { updatedAt: now })
    })
  }

  function dropSchemaErrorsAtChangedIndices(arrayPath: Path, remap: IndexRemap): void {
    const changed = changedIndices(remap)
    if (changed.size === 0) return
    const idxPos = arrayPath.length
    for (const key of [...schemaErrors.keys()]) {
      const segs = segmentsForPathKey(key)
      if (segs === null) continue
      if (!isPathPrefix(arrayPath, segs)) continue
      if (segs.length <= idxPos) continue
      const idx = segs[idxPos]
      if (typeof idx === 'number' && changed.has(idx)) schemaErrors.delete(key)
    }
  }

  function abortValidationAtVacatedIndices(arrayPath: Path, remap: IndexRemap): void {
    if (remap.vacated.size === 0) return
    const idxPos = arrayPath.length
    for (const [key, entry] of [...fieldValidationState]) {
      const segs = segmentsForPathKey(key)
      if (segs === null) continue
      if (!isPathPrefix(arrayPath, segs)) continue
      if (segs.length <= idxPos) continue
      const idx = segs[idxPos]
      if (typeof idx !== 'number' || !remap.vacated.has(idx)) continue
      if (entry.timer !== null) {
        clearTimeout(entry.timer)
      } else if (!entry.settled) {
        activeValidations.value = Math.max(0, activeValidations.value - 1)
        decFieldValidation(key)
      }
      entry.controller.abort()
      fieldValidationState.delete(key)
    }
  }

  return {
    migrateElementState,
    seedFreshElement,
    dropSchemaErrorsAtChangedIndices,
    abortValidationAtVacatedIndices,
  }
}
