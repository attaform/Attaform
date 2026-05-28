import { AttaformError } from '../../core/errors'

/**
 * Thrown when a zod-v3 schema includes a kind the form library cannot
 * represent: `z.promise`, `z.function`, `z.map`, or `z.symbol`.
 *
 * The error message includes the dotted path of the offending node
 * so you can locate it without traversing the whole schema. Mirrors
 * the v4 adapter's `UnsupportedSchemaError` so consumers see the same
 * failure shape across adapters.
 *
 * Recursive `z.lazy(...)` is supported, not unsupported: the
 * construction-time walk stops descending on the second encounter
 * of the same getter, and downstream walks cap their descent via
 * `maxRecursionDepth`.
 */
export class UnsupportedSchemaError extends AttaformError {}
