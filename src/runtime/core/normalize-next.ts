import { AttaformError } from './errors'
import type { AnyForm, NormalizedNext } from '../types/types-wizard'

/**
 * Thrown when a `next: { pick, forms }` selector returns a form that
 * was not declared in its `forms` tuple. TS narrowing prevents this at
 * compile time; the runtime check fires only when a consumer escapes
 * the narrowing (cast via `as any`, dynamic `forms`, or a JS caller).
 *
 * The forms list is load-bearing for the wizard's static graph
 * analysis — an out-of-list return would mean the walker missed a
 * reachable form during the construction-time BFS.
 */
export class OutOfFormsListError extends AttaformError {
  constructor(formKey: string, declaredKeys: readonly string[]) {
    super(
      `[attaform] \`next.pick\` returned form '${formKey}', which is not declared in ` +
        `\`next.forms\` (declared: ${declaredKeys.length === 0 ? '<empty>' : declaredKeys.map((k) => `'${k}'`).join(', ')}). ` +
        'Add the form to the `forms` array or fix the picker to return only declared forms.'
    )
  }
}

const hasOwn = (obj: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key)

const isBranchingShape = (value: object): boolean => hasOwn(value, 'pick') && hasOwn(value, 'forms')

/**
 * Loose structural input shape — accepts any `NextOption<Parsed, …>`
 * regardless of the consumer's `Parsed` slot. Function parameters are
 * contravariant, so threading the public `NextOption<Parsed>` through
 * a single normalizer would fail variance. The normalizer does not
 * read `parsed`'s shape, so widening to `unknown` at the boundary is
 * safe — the schema-typed `pick` is preserved verbatim.
 */
type NextInput =
  | AnyForm
  | {
      readonly pick: (parsed: never) => AnyForm | undefined
      readonly forms: readonly AnyForm[]
    }

/**
 * Normalize `useForm({ next })` into the uniform `{ pick, forms }`
 * shape stored on `FormStore.next`. Identity refs lift to a single-
 * element forms tuple with a constant `pick`. Branching inputs pass
 * through with an added runtime guard: `pick` returns are validated
 * against the declared `forms` list and a stray return throws
 * `OutOfFormsListError`.
 *
 * Returns `undefined` for terminal forms (no `next` supplied).
 */
export function normalizeNext(next: NextInput | undefined): NormalizedNext | undefined {
  if (next === undefined) return undefined

  if (isBranchingShape(next)) {
    const branching = next as {
      pick: (parsed: unknown) => AnyForm | undefined
      forms: readonly AnyForm[]
    }
    const forms = branching.forms
    const declaredKeys = new Set(forms.map((f) => f.key))
    return {
      forms,
      pick: (parsed: unknown): AnyForm | undefined => {
        const result = branching.pick(parsed)
        if (result === undefined) return undefined
        if (!declaredKeys.has(result.key)) {
          throw new OutOfFormsListError(
            result.key,
            forms.map((f) => f.key)
          )
        }
        return result
      },
    }
  }

  const identity = next as AnyForm
  const forms: readonly AnyForm[] = [identity]
  return {
    forms,
    pick: () => identity,
  }
}
