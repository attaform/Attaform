import { AttaformError } from './errors'
import type { FormKey } from '../types/types-api'
import type { AnyForm, NormalizedNext, WizardTreeNode, WizardWarning } from '../types/types-wizard'

/**
 * Framework-free wizard-graph utilities. Walks the static graph
 * described by per-form `next` declarations, detects cycles, builds a
 * tree for sitemap rendering, and offers a runtime-path walker that
 * consults `next.pick(parsed)` to pick a branch at navigation /
 * submission time.
 *
 * The module is intentionally Vue-free — `useWizard` (the composable)
 * orchestrates lifecycle and reactivity; this module describes shape.
 * Same separation as `paths.ts` vs `register-api.ts`.
 */

/**
 * Thrown by `buildWizardGraph` when the form graph contains a cycle —
 * a form's `next` chain eventually leads back to itself. Hard throw at
 * construction so the cycle surfaces before any navigation; consumers
 * who want intentional revisits use `wizard.goTo(key)` instead.
 *
 * `cyclePath` is the ordered list of keys forming the cycle, opened at
 * the first key encountered twice. For `a → b → c → a`, the path is
 * `['a', 'b', 'c', 'a']`.
 */
export class WizardCycleError extends AttaformError {
  readonly cyclePath: readonly FormKey[]
  constructor(cyclePath: readonly FormKey[]) {
    super(
      `[attaform] useWizard: cycle detected in the form graph ` +
        `(${cyclePath.map((k) => `'${k}'`).join(' → ')}). ` +
        `Forms cannot reach themselves through their \`next\` declarations. ` +
        `Use \`wizard.goTo(key)\` for intentional revisit patterns.`
    )
    this.cyclePath = cyclePath
  }
}

/**
 * Static description of the wizard's reachable graph. Produced once
 * at `useWizard(entry)` construction; immutable for the wizard's
 * lifetime (the graph topology is declared in code, not data).
 *
 *  - `entry` — the input form. Identity-equal to the argument.
 *  - `allForms` — BFS-ordered, deduped list of reachable forms.
 *  - `tree` — recursive structure for sitemap rendering. Convergent
 *    paths produce duplicated subtrees (intentional; see
 *    `WizardTreeNode`'s docblock).
 *  - `byKey` — O(1) lookup map keyed by form key. Mirrors `allForms`
 *    as a Map.
 *  - `warnings` — construction-time diagnostic warnings. Empty when
 *    the graph is clean. Cycles throw rather than warn; this list
 *    carries soft signals (empty-forms, single-step).
 */
export type WizardGraph = {
  readonly entry: AnyForm
  readonly allForms: readonly AnyForm[]
  readonly tree: WizardTreeNode
  readonly byKey: ReadonlyMap<FormKey, AnyForm>
  readonly warnings: readonly WizardWarning[]
}

const WHITE = 0
const GRAY = 1
const BLACK = 2

/**
 * Build the static wizard graph by walking from `entry`. Detects
 * cycles (throws `WizardCycleError`), collects empty-forms and
 * single-step diagnostic warnings, and produces a BFS-ordered
 * reachability list, an O(1) byKey lookup map, and a recursive tree
 * structure for sitemap rendering.
 *
 * Implementation is two passes:
 *   1. DFS with three-color marking for cycle detection. The DFS
 *      stack tracks the active path; encountering a `GRAY` node means
 *      a back-edge — i.e., a cycle.
 *   2. BFS enumeration to produce a deterministic, deduped
 *      reachability list. Tree construction runs as a third recursive
 *      pass over the now-known-acyclic graph; convergent subtrees
 *      duplicate by design.
 */
export function buildWizardGraph(entry: AnyForm): WizardGraph {
  detectCycles(entry)

  const allForms: AnyForm[] = []
  const byKey = new Map<FormKey, AnyForm>()
  const visited = new Set<FormKey>()
  const warnings: WizardWarning[] = []
  const queue: AnyForm[] = [entry]

  while (queue.length > 0) {
    const form = queue.shift() as AnyForm
    if (visited.has(form.key)) continue
    visited.add(form.key)
    byKey.set(form.key, form)
    allForms.push(form)

    const next = form.next
    if (next === undefined) continue
    if (next.forms.length === 0) {
      warnings.push({
        kind: 'empty-forms',
        severity: 'warn',
        key: form.key,
        message:
          `[attaform] useWizard: form '${form.key}' declares ` +
          `\`next: { pick, forms: [] }\`. An empty \`forms\` tuple is treated as a ` +
          `terminal; if intentional, omit \`next\` entirely.`,
      })
    }
    for (const child of next.forms) {
      if (!visited.has(child.key)) queue.push(child)
    }
  }

  if (allForms.length === 1 && entry.next === undefined) {
    warnings.push({
      kind: 'single-step',
      severity: 'warn',
      key: entry.key,
      message:
        `[attaform] useWizard: entry form '${entry.key}' has no \`next\` declared — ` +
        `this is a single-step wizard. The navigation surface (\`next\` / \`back\`) is ` +
        `degenerate; use a plain \`useForm\` if no orchestration is needed.`,
    })
  }

  const tree = buildTree(entry)

  return { entry, allForms, tree, byKey, warnings }
}

function detectCycles(entry: AnyForm): void {
  const color = new Map<FormKey, number>()
  const stack: FormKey[] = []
  dfs(entry, color, stack)
}

function dfs(form: AnyForm, color: Map<FormKey, number>, stack: FormKey[]): void {
  color.set(form.key, GRAY)
  stack.push(form.key)
  const next = form.next
  if (next !== undefined) {
    for (const child of next.forms) {
      const childColor = color.get(child.key) ?? WHITE
      if (childColor === GRAY) {
        const cycleStart = stack.indexOf(child.key)
        const cyclePath = [...stack.slice(cycleStart), child.key]
        throw new WizardCycleError(cyclePath)
      }
      if (childColor === WHITE) dfs(child, color, stack)
    }
  }
  color.set(form.key, BLACK)
  stack.pop()
}

function buildTree(form: AnyForm): WizardTreeNode {
  const next = form.next
  return {
    key: form.key,
    next: next === undefined ? [] : next.forms.map(buildTree),
  }
}

/**
 * Walk the runtime submission / navigation path starting from `entry`,
 * consulting each form's `next.pick(parsed)` to select the successor.
 * Returns the ordered path through the live graph. Stops at a static
 * terminal (`next === undefined`) or a dynamic terminal (`pick`
 * returns `undefined`).
 *
 * `getParsed(form)` is invoked once per non-terminal step, when the
 * walker needs the form's parsed output to feed `pick`. Terminal
 * forms are not queried — the walker has no successor to choose. The
 * caller's `getParsed` implementation is responsible for any
 * validation / activation it needs (in Phase 4, the wizard's
 * `handleSubmit` walker awaits `validateAsync(form)` before reading
 * the parsed data here).
 *
 * Out-of-forms `pick` returns are guarded by `normalize-next.ts`'s
 * wrapper (throws `OutOfFormsListError`); the walker propagates that
 * throw rather than swallowing it. The graph is assumed acyclic —
 * `buildWizardGraph` enforces that at construction.
 */
export function walkRuntimePath(
  entry: AnyForm,
  getParsed: (form: AnyForm) => unknown
): readonly AnyForm[] {
  const path: AnyForm[] = []
  let current: AnyForm | undefined = entry
  while (current !== undefined) {
    path.push(current)
    const next: NormalizedNext | undefined = current.next
    if (next === undefined) break
    current = next.pick(getParsed(current))
  }
  return path
}
