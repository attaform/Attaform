/**
 * Parametric form builders for the runtime-performance matrix bench.
 *
 * These are NOT the behavior-lock scenarios. Those freeze a fixed
 * representative shape per class so a refactor can be proven
 * behavior-preserving. These instead sweep ONE axis at a time (field count,
 * nesting depth, array length) so the SLOPE of ops/sec vs the swept dimension
 * confirms or refutes the complexity-ledger predictions:
 *
 *   - flat(F)      -> T2: full-tree diff on a single scalar write, O(F)?
 *   - deep(D)      -> T1: cross-variant DU guard on every write, O(D^2) even
 *                    with ZERO unions present in the schema?
 *   - wideArray(N) -> T2 at array scale + list/key bookkeeping, O(N)?
 *   - flatRefined(F) -> T4: a container/root refine forces a whole-form parse
 *                    on every keystroke (the subtree scope is unavailable), so
 *                    every unchanged sibling leaf is re-validated, O(F)?
 *
 * Every builder takes the adapter's `z`, so the identical shape runs against
 * zod v3 and v4 (parity, plus the T6 adapter-asymmetry probe on init).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type MatrixForm = {
  /** The adapter-built schema passed straight to `useForm({ schema })`. */
  schema: unknown
  /** Seed tree so the swept structure exists before the first write. */
  defaultValues: Record<string, unknown>
  /** Dotted path of the leaf the keystroke bench writes to. */
  keystrokePath: string
  /** Fresh value per iteration so every write is a real change (no dedup). */
  keystrokeValue: (iteration: number) => unknown
}

/** F flat string scalars at depth 1. Sweeps field count for the T2 diff. */
export function flat(z: any, fieldCount: number): MatrixForm {
  const shape: Record<string, unknown> = {}
  const defaultValues: Record<string, unknown> = {}
  for (let i = 0; i < fieldCount; i++) {
    shape[`f${i}`] = z.string()
    defaultValues[`f${i}`] = ''
  }
  return {
    schema: z.object(shape),
    defaultValues,
    // The last field. For a flat object the single-scalar diff is O(F)
    // wherever it lands, and a fixed key keeps path resolution constant.
    keystrokePath: `f${Math.max(0, fieldCount - 1)}`,
    keystrokeValue: (i) => `v${i}`,
  }
}

/**
 * F flat string scalars PLUS one root-level `.refine` (a cross-field check
 * reading two fields). The refine makes `hasContainerOrRootRefine()` return
 * true, which denies the validation scheduler its subtree scope
 * (create-form-store.ts:2651): every keystroke runs a WHOLE-FORM parse
 * (`validateAtPath(form.value, undefined)`) that re-validates every unchanged
 * sibling leaf. Sweeps field count for T4 — the redundant sibling re-parse.
 *
 * The predicate is kept O(1) (reads f0/f1 only) so the measured cost is the
 * sibling leaf-parses, NOT the refine's own work; an aggregate refine that
 * genuinely reads all F fields keeps an irreducible O(F) floor (the verdict
 * depends on every field), so T4's prize there is constant-factor, not
 * asymptotic. f0/f1 are seeded equal so the refine PASSES on the baseline
 * tree — a failing root refine aborts before the full successful parse we
 * want to time.
 */
export function flatRefined(z: any, fieldCount: number): MatrixForm {
  const shape: Record<string, unknown> = {}
  const defaultValues: Record<string, unknown> = {}
  for (let i = 0; i < fieldCount; i++) {
    shape[`f${i}`] = z.string()
    defaultValues[`f${i}`] = 's' // valid + non-empty so leaves pass and the refine runs
  }
  defaultValues['f0'] = 'eq'
  defaultValues['f1'] = 'eq'
  return {
    schema: z
      .object(shape)
      .refine((o: Record<string, unknown>) => o['f0'] === o['f1'], { message: 'f0 must equal f1' }),
    defaultValues,
    keystrokePath: `f${Math.max(0, fieldCount - 1)}`,
    keystrokeValue: (i) => `v${i}`,
  }
}

/** A full schema paired with its Variant A'' refines-only reduction. */
export type RefinedPair = {
  /** Full: F leaves each carrying built-in format/range checks + a root refine. */
  full: unknown
  /** A'': each leaf reduced to base type (built-ins dropped), the refine KEPT. */
  refinesOnly: unknown
  /** Valid tree so the full parse succeeds and the root refine actually runs. */
  defaultValues: Record<string, unknown>
}

/**
 * F leaves, each with TWO built-in checks (`.min(2).regex(/^[a-z]+$/)`), plus one
 * O(1) root refine — paired with its Variant A'' refines-only reduction (each leaf
 * stripped to base `z.string()`, built-ins dropped, the refine kept).
 *
 * This measures what the byte-identical T4 decomposition actually BUYS. A'' keeps
 * base types + coercion + custom refines (it reproduces zod's abort short-circuit
 * structurally rather than detecting fatal/abort flags — which differ by adapter and
 * hide in a closure on v3), so it can shed ONLY the per-leaf built-in checks. Its
 * parse floor is therefore the base-type whole-form parse, NOT the O(1) subtree branch
 * a refine-free form enjoys. Plain `z.string()` leaves (`flatRefined`) would show no
 * A'' win at all; the built-in checks here are exactly the sheddable cost. The
 * `refinesOnly` schema is hand-built to match what a `getRefinesOnlySchema` walker
 * would emit (the reduction proven byte-identical in the T4 equivalence harness).
 */
export function flatRefinedFormatHeavy(z: any, fieldCount: number): RefinedPair {
  const fullShape: Record<string, unknown> = {}
  const baseShape: Record<string, unknown> = {}
  const defaultValues: Record<string, unknown> = {}
  for (let i = 0; i < fieldCount; i++) {
    fullShape[`f${i}`] = z
      .string()
      .min(2)
      .regex(/^[a-z]+$/)
    baseShape[`f${i}`] = z.string()
    defaultValues[`f${i}`] = 'ab' // len>=2, lowercase: passes both built-ins
  }
  defaultValues['f0'] = 'eq' // f0===f1 so the root refine passes on the baseline tree
  defaultValues['f1'] = 'eq'
  const predicate = (o: Record<string, unknown>) => o['f0'] === o['f1']
  const params = { message: 'f0 must equal f1' }
  return {
    full: z.object(fullShape).refine(predicate, params),
    refinesOnly: z.object(baseShape).refine(predicate, params),
    defaultValues,
  }
}

/**
 * A single nesting chain l0.l1.....l{D-1}.leaf, depth D. Sweeps depth with
 * ZERO discriminated unions present, isolating the T1 guard's UNCONDITIONAL
 * per-write cost (the ledger predicts O(D^2) even here).
 */
export function deep(z: any, depth: number): MatrixForm {
  let schema: any = z.object({ leaf: z.string() })
  let defaultValues: Record<string, unknown> = { leaf: '' }
  const segments: string[] = ['leaf']
  for (let d = depth - 1; d >= 0; d--) {
    schema = z.object({ [`l${d}`]: schema })
    defaultValues = { [`l${d}`]: defaultValues }
    segments.unshift(`l${d}`)
  }
  return {
    schema,
    defaultValues,
    keystrokePath: segments.join('.'),
    keystrokeValue: (i) => `v${i}`,
  }
}

/** One array of N rows ({ name, qty }). Sweeps array length for T2 at scale. */
export function wideArray(z: any, rows: number): MatrixForm {
  const defaultRows: Array<{ name: string; qty: number }> = []
  for (let i = 0; i < rows; i++) defaultRows.push({ name: '', qty: 0 })
  return {
    schema: z.object({
      rows: z.array(z.object({ name: z.string(), qty: z.number() })),
    }),
    defaultValues: { rows: defaultRows },
    // Last row: worst-case index resolution; the single-scalar write still
    // forces the full-tree diff across ~2N leaves.
    keystrokePath: `rows.${Math.max(0, rows - 1)}.name`,
    keystrokeValue: (i) => `v${i}`,
  }
}
