/**
 * Typed error classes thrown by the form library. Each one signals a
 * distinct misuse so calling code can branch on `instanceof` instead
 * of pattern-matching error messages.
 *
 * Every class extends `AttaformError`, so consumers can write a single
 * polymorphic catch (`catch (e) { if (e instanceof AttaformError) ... }`)
 * instead of OR-chaining checks for each subclass. `AttaformError` itself
 * extends the standard `Error`, so existing `instanceof Error` usage
 * keeps working.
 */

import type { ErrorCell, ErrorInput, ValidationError } from '../types/types-api'
import { canonicalizePath, type Path, type PathKey } from './paths'

/**
 * Base for every error class thrown by `attaform`. Sets
 * `this.name` from the constructor's `new.target.name`, so subclasses
 * don't have to redeclare their own name override.
 */
export class AttaformError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

/**
 * Thrown when a path string is malformed — typically a dotted path
 * with empty segments (e.g. `'a..b'`, leading or trailing dots).
 * Use array form (`['a', 'b']`) for keys that contain literal dots.
 */
export class InvalidPathError extends AttaformError {}

/**
 * Thrown when `useForm` receives an invalid configuration — most often
 * a schema passed directly as the first argument, or no argument at
 * all. The configuration is an options bag; the schema is one of
 * several fields, even when it's the only one in use.
 *
 * ```ts
 * // ✗ Crashes deep inside the validator with an opaque message:
 * const form = useForm(z.object({ ... }))
 * // ✗ Same:
 * const form = useForm()
 * // ✓ Pass the schema as the `schema` field:
 * const form = useForm({ schema: z.object({ ... }) })
 * ```
 *
 * The same shape applies to every entry point: `attaform/zod`,
 * `attaform/zod-v3`, `attaform/zod-v4`, and the schema-agnostic
 * `attaform` root.
 */
export class InvalidUseFormConfigError extends AttaformError {
  constructor() {
    super(
      '[attaform] useForm received an invalid configuration (a schema directly, no argument, ' +
        'or no `schema` field). Pass it as `useForm({ schema })` — the schema is one of several ' +
        'configuration options. See https://attaform.dev/docs/reading-the-form/the-form for the full ' +
        'configuration shape.'
    )
  }
}

/**
 * Thrown when a `handleSubmit`-supplied `onError` callback itself
 * throws or rejects. Wraps the inner failure so both the original
 * cause (via `error.cause`) and the propagation site are visible.
 */
export class SubmitErrorHandlerError extends AttaformError {}

/**
 * Coerce an unknown thrown value into an `Error`. A real `Error`
 * (including any `AttaformError` subclass) passes through untouched, so
 * its message, stack, name, and `cause` chain survive. A non-`Error`
 * throw (a string, a plain object, a rejected primitive) is wrapped in a
 * fresh `Error` whose `cause` preserves the original value.
 *
 * `handleSubmit` routes everything its `onSubmit` / `onError` callbacks
 * throw through here before parking it on `form.meta.submitError`, so
 * that slot is always a clean `Error | null` rather than `unknown` —
 * consumers can read `.message` and `.cause` without a type guard.
 */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value
  const message =
    typeof value === 'string' && value.length > 0
      ? value
      : `Submit callback threw a non-Error value (${typeof value})`
  return new Error(message, { cause: value })
}

/**
 * Coerce one lenient `ErrorInput` (a real `Error`, or a partial
 * `{ message?, path?, code?, data? }`) into a firm `ValidationError`.
 * A missing or empty `message` coerces to `"Unknown error"` and a
 * missing or empty `code` to `defaultCode`, so the result is always
 * well-formed — library code never throws into the consumer app over a
 * malformed error input.
 *
 * `scope` pins the path: pass the canonical segments for a path-scoped
 * write (`setErrors(path, …)`), or `undefined` to honor the input's own
 * `path` (which defaults to the form-level `[]`).
 *
 * Shared by `form.setErrors` (default code `atta:user-error`) and the
 * `handleSubmit` throw-surfacing path (default code `atta:submit-error`).
 */
export function normalizeErrorInput(
  item: ErrorInput,
  scope: Path | undefined,
  defaultCode: string
): ValidationError {
  if (item instanceof Error) {
    return {
      message: item.message.length > 0 ? item.message : 'Unknown error',
      path: scope !== undefined ? [...scope] : [],
      code: defaultCode,
    }
  }
  const entry: ValidationError = {
    message:
      typeof item.message === 'string' && item.message.length > 0 ? item.message : 'Unknown error',
    path: scope !== undefined ? [...scope] : Array.isArray(item.path) ? [...item.path] : [],
    code: typeof item.code === 'string' && item.code.length > 0 ? item.code : defaultCode,
  }
  if (item.data !== undefined) entry.data = item.data
  return entry
}

/**
 * Normalize a single `ErrorInput` or an array of them into a
 * `ValidationError[]`, applying `normalizeErrorInput` to each. See it
 * for the `scope` / `defaultCode` semantics.
 */
export function normalizeErrorInputs(
  input: ErrorInput | ErrorInput[],
  scope: Path | undefined,
  defaultCode: string
): ValidationError[] {
  const items = Array.isArray(input) ? input : [input]
  return items.map((item) => normalizeErrorInput(item, scope, defaultCode))
}

/**
 * Iterate one side of the tagged error store: yields `[key, entries]`
 * for every cell whose `side` is non-empty, in the map's insertion
 * order. The uniform per-source view the enumeration walks, aggregate
 * collectors, and serialization all read through.
 */
export function* cellEntriesFor(
  cells: ReadonlyMap<PathKey, ErrorCell>,
  side: 'schema' | 'user'
): IterableIterator<readonly [PathKey, readonly ValidationError[]]> {
  for (const [key, cell] of cells) {
    const list = cell[side]
    if (list.length > 0) yield [key, list] as const
  }
}

/**
 * Thrown when an `attaform` API needs the registry attached to a Vue
 * app but it isn't there yet. Component-level entry points (`useForm`,
 * `injectForm`, `useRegister`) lazy-install the registry on first use,
 * so this error is mostly reached by SSR helpers — `renderAttaformState`
 * and `hydrateAttaformState` — which run outside a setup context and
 * have no current instance to install against.
 *
 * Fix: add `app.use(createAttaform())` (or `app.use(createAttaform({
 * ssr: true }))` on the server) to your SSR entry, before
 * `renderToString` / hydration. Under Nuxt, `attaform/nuxt` already
 * does this; the error usually points at a non-Nuxt SSR setup that
 * hasn't installed explicitly.
 */
export class RegistryNotInstalledError extends AttaformError {
  constructor() {
    super(
      '[attaform] No registry attached to this Vue app. Component-level useForm / injectForm / ' +
        'useRegister auto-install the registry, but SSR helpers (renderAttaformState, ' +
        'hydrateAttaformState) run outside setup and require an explicit ' +
        '`app.use(createAttaform())` at server-render time. Add it to your SSR entry, before ' +
        '`renderToString`.'
    )
  }
}

/**
 * Thrown when `useForm` / `injectForm` is called outside of a
 * Vue `setup()` function — typically from an event handler, watcher,
 * or async callback that runs after mount.
 *
 * Fix: move the call into `setup()`, or trigger it from a child
 * component whose `setup()` runs the composable.
 */
export class OutsideSetupError extends AttaformError {
  constructor() {
    super(
      '[attaform] useForm / injectForm called outside Vue setup(). ' +
        'Move into setup or mount a child component to trigger from an event.'
    )
  }
}

/**
 * Thrown when a `useForm({ key })` call uses a key starting with
 * `__atta:`. That prefix is reserved for keys the library generates
 * internally (e.g. for anonymous `useForm()` calls without an
 * explicit key). Pick a different prefix for your form.
 */
export class ReservedFormKeyError extends AttaformError {
  constructor(key: string) {
    super(
      `[attaform] Form key "${key}" uses the reserved "__atta:" namespace. ` +
        `Use a different prefix — "__atta:" is for library-internal synthetic keys ` +
        `(anonymous useForm() calls without an explicit key).`
    )
  }
}

/**
 * Group `entries` by each error's own canonical storage key, preserving
 * entry order within a key (adapter ordering for multiple issues at the
 * same leaf). Form-level (global) errors arrive with `err.path: []` and
 * group under the root key `'[]'` directly, no rerouting: aggregate
 * reads (`errors()`, `meta.errors`) surface them, `errors([])` returns
 * the root bucket alone, while `errors('')` reads the unrelated literal
 * `''` field at key `'[""]'`. Shared by the store's channel writers and
 * the submit-throw path grouping.
 */
export function groupErrorsByKey(
  entries: readonly ValidationError[]
): Map<PathKey, ValidationError[]> {
  const grouped = new Map<PathKey, ValidationError[]>()
  for (const raw of entries) {
    const { key } = canonicalizePath(raw.path as Path)
    const list = grouped.get(key)
    if (list === undefined) grouped.set(key, [raw])
    else list.push(raw)
  }
  return grouped
}
