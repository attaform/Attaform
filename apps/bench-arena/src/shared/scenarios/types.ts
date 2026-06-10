import type { ScenarioParams } from '../../adapters/contract'

/**
 * The library-agnostic shape of a scenario at given params: the ordered leaf
 * paths (one per rendered input), a valid seed tree, and which leaf the
 * keystroke dimension drives. Every adapter renders this identically and binds
 * its own validation engine behind it, so the DOM is held constant and only
 * the engine differs.
 */
export interface ScenarioShape {
  /**
   * Ordered dotted leaf paths; array index === rendered input index. Nested
   * scenarios use dot segments (`l0.l1.leaf`) and array scenarios numeric ones
   * (`rows.3.qty`); every adapter resolves these against its own model.
   */
  readonly paths: readonly string[]
  /**
   * The valid seed tree (all leaves pass) passed verbatim to a form-state
   * library's `defaultValues` / `initialValues` and to the harness-owned
   * reactive state the validation-only libraries bind. For flat scenarios it is
   * a flat object; for nested/array scenarios it is the real nested tree, so
   * read an individual leaf via `leafSeed`, never `defaultValues[path]`.
   */
  readonly defaultValues: Record<string, unknown>
  /** Index into `paths` that the keystroke dimension types into. */
  readonly keystrokeIndex: number
}

/**
 * A field's validation as native (non-schema) rules, so the
 * headless-validation-only libraries (Regle rules mode, Vuelidate) can mirror
 * the exact constraint the zod and valibot entries express. Each adapter maps
 * these to its own rule helpers.
 */
export interface NativeRule {
  /** Minimum string length; an empty string fails it (mirrors `.min(n)`). */
  readonly minLength?: number
}

/** Field count for flat-like scenarios, defaulted defensively. */
export function fieldCount(params: ScenarioParams, fallback = 10): number {
  return params.fields ?? fallback
}

/** Coerce an all-digits path segment to an array index, else keep the key. */
function segKey(seg: string): string | number {
  return /^\d+$/.test(seg) ? Number(seg) : seg
}

/**
 * Read a single leaf's seed value out of a nested default tree by dotted path,
 * coercing numeric segments to array indices. The adapters that need a per-leaf
 * initial value (FormKit, which seeds each rendered input) read it here rather
 * than indexing the tree by the dotted string, which only works when flat.
 */
export function leafSeed(tree: Record<string, unknown>, dottedPath: string): unknown {
  let node: unknown = tree
  for (const seg of dottedPath.split('.')) {
    if (node == null || typeof node !== 'object') return undefined
    node = (node as Record<string | number, unknown>)[segKey(seg)]
  }
  return node
}

/**
 * De-flatten the scenario's flat dotted native-rule map into a nested rules
 * object mirroring the value tree, applying `map` to each leaf rule. The
 * headless-validation libraries (Regle rules mode, Vuelidate) take rules nested
 * to match the state they validate, so they build their engine-specific rules
 * from the scenario's flat description through this one helper. Object segments
 * only; array scenarios validate per item through each engine's own primitive.
 */
export function nestRules<T>(
  flat: Record<string, NativeRule>,
  map: (rule: NativeRule) => T
): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  for (const [dotted, rule] of Object.entries(flat)) {
    const segs = dotted.split('.')
    const leaf = segs.pop()
    if (leaf === undefined) continue
    let node = root
    for (const seg of segs) {
      node[seg] ??= {}
      node = node[seg] as Record<string, unknown>
    }
    node[leaf] = map(rule)
  }
  return root
}
