/**
 * Attaform's auto-import manifest: the single source of truth for the
 * composables a form author reaches for inside `<script setup>` without
 * writing an `import`. One declaration, two consumers:
 *
 *   - `attaform/nuxt` feeds `attaformAutoImports` to Nuxt's `addImports`
 *     (gated behind the module's `autoImports` option, default on).
 *   - `attaform/vite` re-exports both this flat list and the derived
 *     `attaformAutoImportsMap` so a plain-Vite project registers the same
 *     set through `unplugin-auto-import`.
 *
 * Every entry resolves from `attaform/zod`, not the bare `attaform`
 * barrel. The reason is the build-time adapter rewrite: the Vite and
 * bundler plugins intercept the exact `attaform/zod` specifier and
 * collapse it to the one installed Zod major, so a consumer's bundle
 * ships a single adapter instead of the runtime dispatcher. The two
 * surfaces are byte-identical after the schema-entry re-partition
 * (`attaform` re-exports exactly what `attaform/zod` does), so pointing
 * the auto-imports at `/zod` costs the consumer nothing and earns the
 * lean bundle for free.
 *
 * The bar for a slot: a form author calls it directly from inside a
 * component's `setup`. That is why `useRegister` is here. It is the only
 * way to write a custom input wrapper, and it opens with
 * `getCurrentInstance()`, so a component's `setup` is the one place it
 * can be called at all.
 *
 * Deliberately absent (reach for these with an explicit import):
 *   - `useAbstractForm` — the schema-agnostic escape hatch on
 *     `attaform/abstract`, an advanced surface, not the default form.
 *   - `createAttaform` — the plugin install, a setup-level one-liner that
 *     belongs beside the app bootstrap, not in every component's scope.
 *   - `unset` / `isUnset` and the serialize helpers: plain values and
 *     functions with no component affinity, equally at home in a store, a
 *     util module, or a server route. `unset` is also too generic a name
 *     to spend on every app's global scope.
 *
 * The manifest test pins the set so a casual addition of a setup-level
 * symbol to the global scope fails loudly, and `auto-import-docs.test.ts`
 * pins the prose that enumerates it.
 */

/**
 * One auto-imported binding: the exported `name` and the module it is
 * imported `from`. This is the minimal shape of unimport's `Import`,
 * which is exactly what Nuxt's `addImports` accepts.
 */
export interface AttaformAutoImport {
  readonly name: string
  readonly from: string
}

/**
 * The flat manifest, ready to hand to `addImports` (Nuxt) verbatim.
 */
export const attaformAutoImports: AttaformAutoImport[] = [
  { name: 'useForm', from: 'attaform/zod' },
  { name: 'useWizard', from: 'attaform/zod' },
  { name: 'injectForm', from: 'attaform/zod' },
  { name: 'injectWizard', from: 'attaform/zod' },
  { name: 'fieldMeta', from: 'attaform/zod' },
  { name: 'withMeta', from: 'attaform/zod' },
  { name: 'lazy', from: 'attaform/zod' },
  { name: 'gate', from: 'attaform/zod' },
  { name: 'useRegister', from: 'attaform/zod' },
]

/**
 * The same set grouped by module, i.e. `{ 'attaform/zod': ['useForm',
 * ...] }`. This is `unplugin-auto-import`'s `ImportsMap` shape, a drop-in
 * for its `imports` array (which does not accept a flat `Import[]`).
 * Derived from `attaformAutoImports` so the two never drift.
 */
export const attaformAutoImportsMap: Record<string, string[]> = attaformAutoImports.reduce<
  Record<string, string[]>
>((map, entry) => {
  const names = map[entry.from] ?? []
  names.push(entry.name)
  map[entry.from] = names
  return map
}, {})
