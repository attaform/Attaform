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
  /**
   * Dotted path of the array under test, present only for array-shaped
   * scenarios (arrays, grid). The arrayOp dimension reorders this array, and
   * the native-validator adapters build their collection rule against it.
   */
  readonly arrayPath?: string
  /**
   * Per-item field rules for an array scenario, keyed by the item's own field
   * name (`{ v: { minLength: 2 } }`). The schema-based libraries express arrays
   * through their schema; the native-validator libraries (Regle rules, Vuelidate)
   * build their `$each` collection rule from this.
   */
  readonly arrayItemRules?: Record<string, NativeRule>
  /**
   * The field name(s) within each array row (`['v']`), present only for
   * array-shaped scenarios. The adapters render a row reactively through their
   * own array primitive and build each leaf path as `${arrayPath}.${i}.${field}`,
   * so a reorder rebinds the moved row to its new positional path.
   */
  readonly arrayItemFields?: readonly string[]
  /**
   * Build a fresh valid row for the append op (arrays/grid scenarios). It
   * returns the same shape as a seed row, so an appended row validates
   * immediately and the add/remove rotation never churns error state.
   */
  readonly newRow?: () => Record<string, unknown>
  /**
   * Non-array leaf paths rendered alongside the rows, present only for the
   * composite massive scenario (flat + nested leaves; the array cells travel on
   * `paths` ahead of these). An array scenario renders the rows through its
   * array primitive and then these object leaves through its plain field
   * binding, each at an index continuing past the last array cell
   * (`paths.length - objectPaths.length + position`). Absent for the
   * single-shape scenarios, where the array branch renders only rows.
   */
  readonly objectPaths?: readonly string[]
  /**
   * Discriminated-union descriptor, present only for the discriminated-union
   * scenario. Adapters render only the ACTIVE variant's fields (the one the
   * current discriminant selects), and the variantFlip dimension cycles the
   * discriminant, replacing the whole value at `unionPath` with the target
   * variant's `value`. The default active variant is the first in `variants`,
   * so its `fieldPaths` are what the keystroke and re-render dimensions drive.
   */
  readonly union?: {
    /** Dotted path of the object the union occupies; a flip writes here. */
    readonly unionPath: string
    /** Dotted path of the discriminant leaf (`event.kind`). */
    readonly discriminantPath: string
    /** The variants, keyed by their discriminant value. */
    readonly variants: ReadonlyArray<{
      /** The discriminant value (`click`). */
      readonly tag: string
      /** This variant's non-discriminant leaf paths, rendered as inputs. */
      readonly fieldPaths: readonly string[]
      /** A full valid value for this variant, written verbatim on a flip. */
      readonly value: Record<string, unknown>
    }>
  }
  /**
   * Multi-step wizard descriptor, present only for the wizard scenario. The
   * steps partition `paths` in order (`steps[i]` holds step i's leaf paths), and
   * only the active step's fields are rendered. The stepTransition dimension
   * advances through them: a library with a wizard primitive (Attaform's
   * useWizard) makes each step its own form, so a gated advance validates only
   * that step; a library without one hand-composes the flow off a step signal.
   * `stepKeys` names each step's object key (`step0`), so an adapter that builds
   * a form per step slices the per-step schema and defaults out of the root by
   * key.
   */
  readonly wizard?: {
    /** Each step's object key (`step0`, `step1`, ...), in step order. */
    readonly stepKeys: readonly string[]
    /** Each step's leaf paths (`['step0.f0', ...]`), partitioning `paths`. */
    readonly steps: readonly (readonly string[])[]
  }
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
