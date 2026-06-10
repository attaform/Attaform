/**
 * Init-decomposition bench (P4): where does cold-construction wall-clock go,
 * and how much of it is DEFERRABLE-to-first-interaction?
 *
 * The matrix bench measures init END-TO-END (the `init flat` group). This
 * decomposes that number into the eager O(F.D) primitives construction runs,
 * each measured in isolation on the SAME schema, so P4's one deferral candidate
 * can be sized against the irreducible remainder.
 *
 * Construction's eager O(F.D) work (create-form-store.ts:1228-1819), classified:
 *
 *   parse     getDefaultValues({useDefaultSchemaValues:true})  NON-deferrable
 *             produces schemaInitialData, i.e. form.value, which SSR renders
 *             immediately. T6 lives here (v4 safeParse > v3).
 *   clone     structuralSnapshot(schemaInitialData)            NON-deferrable
 *             per-instance isolation before form.value is exposed.
 *   walk      diffAndApply({}, schemaInitialData)              load-bearing
 *             seeds `originals` (the dirty baseline) AND `pathOrdinals` in
 *             schema-declaration order in ONE pass (create-form-store.ts:1814).
 *             pathOrdinals drives form.meta.errors SORT order, so deferring this
 *             walk would reorder meta.errors (observable) — non-deferrable
 *             without a separate O(F) ordinal walk (no net win).
 *   baseline  getEmptyValueAtPath([])                          DEFERRABLE
 *             the blank value tree fed to walkAuthoredFromSchemaDiff to derive
 *             `authoredPaths`, which is consumed ONLY by filterAuthoredErrors
 *             (create-form-store.ts:2701) — at field-VALIDATION time, never at
 *             mount. Construction-time validation is gated to async-strict,
 *             non-SSR schemas (:1904), so for the common sync form the FIRST
 *             filterAuthoredErrors call is the first keystroke. authoredPaths
 *             derivation is therefore dead init work until first interaction.
 *
 * DEFERRAL CEILING (what lazy-authoredPaths could remove from the sync init
 * path) = baseline + walkAuthoredFromSchemaDiff. That walk is module-local (not
 * exported), but it is an O(F) two-tree diff bounded by the `walk` cell, so
 * ceiling <= baseline + walk — both measured. Read that against the eager total
 * (parse + clone + walk + baseline) for the deferrable FRACTION of init. A
 * `defaultValues` argument (not passed here) adds mergeStructural +
 * walkAuthoredFromConstraints, both O(defaultValues) and proportional — they do
 * not move the fraction. See PERF-ANALYSIS.md "P4".
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { bench, describe } from 'vitest'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { zodAdapter as zodV4Adapter } from '../src/runtime/adapters/zod-v4'
import { zodAdapter as zodV3Adapter } from '../src/runtime/adapters/zod-v3'
import { structuralSnapshot, diffAndApply } from '../src/runtime/core/diff-apply'
import { flat } from './lib/matrix-forms'

type Adapter = { tag: string; z: any; build: any }
const ADAPTERS: Adapter[] = [
  { tag: 'v4', z: zV4, build: zodV4Adapter },
  { tag: 'v3', z: zV3 as any, build: zodV3Adapter },
]

const FIELD_COUNTS = [5, 50, 500]
const NOOP = (): void => {}

describe('init decomposition: eager O(F) primitives, deferrable vs not (P4)', () => {
  for (const a of ADAPTERS) {
    for (const F of FIELD_COUNTS) {
      const form = flat(a.z, F)
      const schema = a.build(form.schema)('init-decomp-probe', { maxRecursionDepth: 64 })
      // The with-defaults tree the clone + originals walk consume. Built once;
      // the cells below read it (clone) or diff a fresh {} against it (walk).
      const schemaInitialData = schema.getDefaultValues({
        useDefaultSchemaValues: true,
        constraints: undefined,
        strict: true,
      }).data

      // NON-deferrable: produces form.value (SSR renders it). T6 lives here.
      bench(`parse getDefaultValues F=${F} [${a.tag}]`, () => {
        schema.getDefaultValues({
          useDefaultSchemaValues: true,
          constraints: undefined,
          strict: true,
        })
      })
      // DEFERRABLE: blank baseline -> authoredPaths (consumed at validation only).
      bench(`baseline getEmptyValueAtPath F=${F} [${a.tag}]`, () => {
        schema.getEmptyValueAtPath([])
      })
      // NON-deferrable: per-instance isolation clone.
      bench(`clone structuralSnapshot F=${F} [${a.tag}]`, () => {
        structuralSnapshot(schemaInitialData)
      })
      // Load-bearing: seeds originals + declaration-order pathOrdinals in one
      // pass. Fresh {} target each iteration so every leaf is an 'added' patch
      // (the seed), and the walk upper-bounds the authored two-tree diff.
      bench(`walk diffAndApply originals+ordinals F=${F} [${a.tag}]`, () => {
        diffAndApply({}, schemaInitialData, [], NOOP)
      })
    }
  }
})
