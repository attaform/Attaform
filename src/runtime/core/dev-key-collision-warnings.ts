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
 *
 * Because nothing here ships, the sketch below is free to be as
 * thorough as it likes. It is built entirely from the public
 * `AbstractSchema` surface the form itself walks, which is why it
 * replaced a pair of per-adapter structural walkers: a dedicated walker
 * is a second opinion about the schema that can drift from the one the
 * runtime acts on, and this cannot.
 */
import type { AbstractSchema, FormKey } from '../types/types-api'
import type { GenericForm } from '../types/types-core'
import type { Path } from './paths'

/** Bounds on the sketch walk, so a deep or wide schema cannot stall a dev build. */
const MAX_SKETCH_DEPTH = 6
const MAX_SKETCH_NODES = 400

/**
 * Describe one path using only what the form runtime itself asks of a
 * schema: the accepted primitive kinds, whether the path is required,
 * whether it bottoms out, and the fixed arity if it is a tuple. Two
 * schemas that agree on all of this at every reachable path behave
 * identically as far as the runtime is concerned, which is the only
 * agreement a shared store needs.
 */
function describePath(schema: AbstractSchema<GenericForm, GenericForm>, path: Path): string {
  const kinds = [...schema.getSlimPrimitiveTypesAtPath(path)].sort().join('|')
  const arity = schema.arrayShapeAtPath(path)
  return [
    kinds,
    schema.isRequiredAtPath(path) ? 'req' : 'opt',
    schema.isLeafAtPath(path) ? 'leaf' : 'node',
    arity === null ? '' : `[${arity}]`,
  ].join(',')
}

/**
 * Walk the schema's own default shape, describing every path reached.
 *
 * The default shape is the right spine to walk because it is what the
 * form materialises at construction, so the sketch covers exactly the
 * paths a shared store would actually disagree about. Optional subtrees
 * with no default are invisible to it — deliberately. This is a footgun
 * catcher, not a soundness proof, and it was never able to be one:
 * refinement and transform bodies are opaque to every version of this
 * check.
 */
function sketchSchema(schema: AbstractSchema<GenericForm, GenericForm>): string {
  const lines: string[] = []
  let budget = MAX_SKETCH_NODES

  const visit = (value: unknown, path: Path): void => {
    if (budget <= 0) return
    budget -= 1
    lines.push(`${path.join('.')}=${describePath(schema, path)}`)
    if (path.length >= MAX_SKETCH_DEPTH) return
    if (Array.isArray(value)) {
      // One representative element: arrays are homogeneous under a Zod
      // schema, and a tuple's arity already rode in via `arrayShapeAtPath`.
      if (value.length > 0) visit(value[0], [...path, 0])
      return
    }
    if (value === null || typeof value !== 'object') return
    for (const childKey of Object.keys(value).sort()) {
      visit((value as Record<string, unknown>)[childKey], [...path, childKey])
    }
  }

  visit(schema.getDefaultAtPath([]), [])
  return lines.join('\n')
}

/**
 * Dev-only: warn when a second `useForm` lands on the same key with a
 * structurally different schema. Both schemas are sketched over their
 * own default shape and the sketches compared. A schema that throws out
 * of its own walk (a `.default(() => { throw })` factory, say) is caught
 * and surfaced as a `console.error`: the mismatch check is skipped,
 * matching the "allow the inconsistency" failure mode.
 */
export async function warnOnSchemaFingerprintMismatch(
  key: FormKey,
  existing: AbstractSchema<GenericForm, GenericForm>,
  incoming: AbstractSchema<GenericForm, GenericForm>
): Promise<void> {
  // The signature stays async because the call site fires this without
  // awaiting and the previous contract resolved a promise; keeping it
  // means a rejection still lands on the caller's `.then` chain rather
  // than as an unhandled synchronous throw.
  await Promise.resolve()
  if (existing === incoming) return
  let existingSketch: string
  let incomingSketch: string
  try {
    existingSketch = sketchSchema(existing)
    incomingSketch = sketchSchema(incoming)
  } catch (error) {
    console.error(
      `[attaform] could not compare schemas for key "${key}"; skipping mismatch check.`,
      error
    )
    return
  }
  if (existingSketch === incomingSketch) return
  console.warn(
    `[attaform] useForm() calls with key "${key}" use different schemas; first wins, second is ignored. Use identical schemas or unique keys.\n  existing:\n${indent(existingSketch)}\n  incoming:\n${indent(incomingSketch)}`
  )
}

function indent(sketch: string): string {
  return sketch
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')
}
