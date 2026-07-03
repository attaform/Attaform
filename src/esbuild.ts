/**
 * `attaform/esbuild` — esbuild plugin that rewrites `attaform` and
 * `attaform/zod` imports to the single matching adapter subpath
 * (`attaform/zod-v3` or `attaform/zod-v4`) at build time, based on the
 * consumer's installed Zod major. Without it, esbuild ships both adapters
 * because those entries import both for runtime dispatch.
 *
 * Usage:
 *
 *   // build.mjs
 *   import { build } from 'esbuild'
 *   import { attaform } from 'attaform/esbuild'
 *
 *   await build({
 *     entryPoints: ['src/main.ts'],
 *     bundle: true,
 *     plugins: [attaform()],
 *   })
 *
 * This plugin only does the adapter rewrite. The Vue SFC `v-register`
 * transforms that `attaform/vite` wires (load-bearing for SSR initial
 * render) are `@vitejs/plugin-vue`-specific and do not transfer; a
 * non-Vite consumer that needs them wires `attaform/transforms` into
 * their Vue compiler separately.
 *
 * Zero-dep: the plugin imports nothing from `esbuild` (the bundler injects
 * its plugin API at the consumer's build); the structural types below are
 * all it needs to compile.
 */
import { resolveZodAliasTarget, REWRITABLE_ZOD_SPECIFIER_FILTER } from './core/detect-zod-major'

/** Options for the esbuild `attaform()` plugin. */
export interface AttaformEsbuildPluginOptions {
  /**
   * Rewrite `attaform` and `attaform/zod` imports at build time to the
   * matching adapter subpath. Default `true`. Set to `false` to keep the
   * runtime-dispatch unified entry (ships both adapters).
   */
  resolveZodAlias?: boolean
  /**
   * Project root to resolve the installed Zod from. Defaults to the
   * build's `absWorkingDir`, falling back to `process.cwd()`. Set this
   * when the build runs from a directory other than the project that owns
   * the Zod dependency.
   */
  root?: string
}

interface EsbuildOnResolveArgs {
  path: string
  importer: string
  resolveDir: string
  kind: string
}
interface EsbuildResolveResult {
  path: string
  external: boolean
  namespace: string
  errors: unknown[]
}
interface EsbuildOnResolveResult {
  path?: string
  external?: boolean
  namespace?: string
  errors?: unknown[]
}
interface EsbuildPluginBuild {
  initialOptions: { absWorkingDir?: string }
  onResolve(
    options: { filter: RegExp },
    callback: (args: EsbuildOnResolveArgs) => Promise<EsbuildOnResolveResult>
  ): void
  resolve(
    path: string,
    options: { kind: string; importer?: string; resolveDir?: string }
  ): Promise<EsbuildResolveResult>
}

/** The structural shape esbuild requires of the plugin. */
export interface AttaformEsbuildPlugin {
  name: string
  setup(build: EsbuildPluginBuild): void
}

export function attaform(options: AttaformEsbuildPluginOptions = {}): AttaformEsbuildPlugin {
  const resolveZodAlias = options.resolveZodAlias !== false
  const warnState = { warned: false }
  return {
    name: 'attaform',
    setup(build) {
      const root = build.initialOptions.absWorkingDir ?? options.root ?? process.cwd()
      const target = resolveZodAliasTarget(root, 'attaform/esbuild', resolveZodAlias, warnState)
      // Nothing to rewrite (opt-out, or unclassifiable version): leave the
      // unified entry in place and register no hook.
      if (target === null) return
      build.onResolve({ filter: REWRITABLE_ZOD_SPECIFIER_FILTER }, async (args) => {
        // Re-resolve the rewritten specifier so esbuild returns a real
        // path. Both matched specifiers (bare `attaform` and
        // `attaform/zod`) rewrite to the same detected adapter; the filter
        // is anchored so resolving `attaform/zod-v4` does not re-enter
        // this callback.
        const result = await build.resolve(target, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
        })
        if (result.errors.length > 0) return { errors: result.errors }
        return { path: result.path, external: result.external, namespace: result.namespace }
      })
    },
  }
}
