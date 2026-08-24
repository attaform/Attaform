/**
 * `rewriteDirectiveDelivery` — compile-time delivery of the `v-register`
 * directive for Vite-pipeline consumers (bare Vite and Nuxt).
 *
 * `createAttaform()` registers no directive, so a compiled template's
 * `resolveDirective("register")` would resolve nothing at runtime. This
 * post-compile rewrite binds the directive statically instead: every
 * occurrence of the compiler-emitted call is replaced with a local
 * identifier, and one import of that identifier from
 * `attaform/directive` is appended to the module.
 *
 * Why this shape is safe to match textually: for a directive that is not
 * a `<script setup>` scope binding, `@vue/compiler-core` emits exactly
 * `_resolveDirective("register")` — the `_resolveDirective` alias comes
 * from the compiler's fixed helper-name map and the argument is
 * JSON-stringified (always double quotes) — across script-setup, options
 * API and template-only components, dev and prod, client and SSR
 * codegen (the SSR variant passes the same resolved value through
 * `ssrGetDirectiveProps`). When the author binds `vRegister` in
 * `<script setup>` themselves, the compiler emits no `resolveDirective`
 * at all and this rewrite naturally leaves the module alone.
 *
 * Sourcemap contract: the replacement is padded to the exact length of
 * the call text and the import rides at end-of-file (ESM hoists it), so
 * no original code moves — returning `map: null` from a bundler
 * transform hook is then the documented "positions unchanged" answer.
 *
 * Scope: only modules compiled from a `.vue` file outside
 * `node_modules`. Compiled SFCs shipped inside published packages are
 * skipped so a third-party package's own `register` directive is never
 * captured; a component library that wants Attaform's directive without
 * asking its host app to run this plugin binds it locally instead
 * (`import { vRegister } from 'attaform/directive'` in `<script setup>`).
 *
 * Known narrowing, by design: within this pipeline a template's
 * `v-register` binds to Attaform's directive at build time, so an
 * app-level or component-`directives` registration under the same name
 * no longer intercepts it.
 */

/** The exact call `@vue/compiler-core` emits for an unresolved `v-register`. */
const RESOLVE_CALL = '_resolveDirective("register")'

/**
 * Local identifier the rewrite substitutes for the call, padded with
 * trailing spaces to `RESOLVE_CALL.length` so every later position on
 * the line is preserved. Prefixed to stay clear of compiler-generated
 * and userland names.
 */
const LOCAL_ID = '__attaformVRegister'
const PADDED_LOCAL_ID = LOCAL_ID.padEnd(RESOLVE_CALL.length, ' ')

const IMPORT_LINE = `\nimport { vRegister as ${LOCAL_ID} } from "attaform/directive";\n`

/**
 * Rewrite one compiled module. Returns the rewritten code, or `null`
 * when the module is out of scope or contains no `v-register`
 * resolution — the shape a bundler `transform` hook forwards as-is.
 */
export function rewriteDirectiveDelivery(code: string, id: string): string | null {
  if (id.includes('/node_modules/')) return null
  const file = id.split('?', 1)[0]
  if (file === undefined || !file.endsWith('.vue')) return null
  if (!code.includes(RESOLVE_CALL)) return null
  return code.split(RESOLVE_CALL).join(PADDED_LOCAL_ID) + IMPORT_LINE
}
