/**
 * State that must stay identical across duplicate copies of attaform.
 *
 * A bundler is free to compile attaform into more than one module
 * graph, and Nuxt routinely does: a `shared/` module is compiled by
 * Nitro while the page that consumes it comes from the Vite SSR pass,
 * so both ship their own copy of whatever attaform modules they reach.
 * Module-scoped `WeakMap`s / `WeakSet`s then split in two, and a write
 * through one copy is invisible to a read through the other. When the
 * read has a graceful fallback (#577: a registered label falling back
 * to the humanised path) nothing throws and nothing logs, so the only
 * symptom is a quiet behavioural downgrade.
 *
 * Carrying the state on `globalThis` under a `Symbol.for(...)` key
 * makes every copy agree on one instance. Same reasoning as
 * `kAttaformRegistry` and the directive's per-element listener bag,
 * applied where there is no shared carrier object to hang the slot on.
 *
 * A second property falls out of it, and it is load-bearing: a write
 * to a module-scoped `let` whose only reader sits in another graph is
 * a provably dead store, so Rollup drops it (and anything it was the
 * sole referent of). A property on a carrier reached through
 * `globalThis` is opaque to that analysis, so install-style slots
 * survive tree-shaking in a graph that only ever writes them.
 *
 * Use this for state whose correctness depends on there being exactly
 * one instance. Caches that recompute on a miss, dev-warning dedup
 * flags, and frozen lookup tables do not need it.
 */

type Carrier<T> = { [key: symbol]: T | undefined }

/**
 * Read the slot at `key`, creating it with `create` on first touch.
 * `key` must be a `Symbol.for(...)` symbol: a plain `Symbol()` is
 * unique per copy and would defeat the whole point.
 */
export function crossCopyState<T>(key: symbol, create: () => T): T {
  const carrier = globalThis as Carrier<T>
  return (carrier[key] ??= create())
}
