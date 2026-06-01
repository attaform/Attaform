/**
 * `attaform/rollup` — Rollup plugin that rewrites `attaform/zod` imports
 * to the single matching adapter subpath (`attaform/zod-v3` or
 * `attaform/zod-v4`) at build time, based on the consumer's installed Zod
 * major. Without it, Rollup ships both adapters because the unified
 * `attaform/zod` entry imports both for runtime dispatch.
 *
 * Usage:
 *
 *   // rollup.config.js
 *   import { attaform } from 'attaform/rollup'
 *
 *   export default {
 *     plugins: [attaform()],
 *   }
 *
 * This plugin only does the adapter rewrite. The Vue SFC `v-register`
 * transforms that `attaform/vite` wires (load-bearing for SSR initial
 * render) are `@vitejs/plugin-vue`-specific and do not transfer; a
 * non-Vite consumer that needs them wires `attaform/transforms` into
 * their Vue compiler separately.
 *
 * Zero-dep: the plugin imports nothing from `rollup` (the bundler injects
 * its plugin context at the consumer's build); the structural types below
 * are all it needs to compile.
 */
import { resolveZodAliasTarget, ZOD_UNIFIED_SPECIFIER } from './core/detect-zod-major'

/** Options for the Rollup `attaform()` plugin. */
export interface AttaformRollupPluginOptions {
  /**
   * Rewrite `attaform/zod` imports at build time to the matching adapter
   * subpath. Default `true`. Set to `false` to keep the runtime-dispatch
   * unified entry (ships both adapters).
   */
  resolveZodAlias?: boolean
  /**
   * Project root to resolve the installed Zod from. Defaults to
   * `process.cwd()`. Set this when the build runs from a directory other
   * than the project that owns the Zod dependency.
   */
  root?: string
}

interface RollupResolveContext {
  resolve(
    source: string,
    importer: string | undefined,
    options: { skipSelf: boolean }
  ): Promise<{ id: string; external: boolean | 'absolute' | 'relative' } | null>
}

/** The structural shape Rollup requires of the plugin. */
export interface AttaformRollupPlugin {
  name: string
  buildStart(): void
  resolveId(
    this: RollupResolveContext,
    source: string,
    importer: string | undefined
  ): Promise<{ id: string } | null> | null
}

export function attaform(options: AttaformRollupPluginOptions = {}): AttaformRollupPlugin {
  const resolveZodAlias = options.resolveZodAlias !== false
  const root = options.root ?? process.cwd()
  const warnState = { warned: false }
  let aliasTarget: string | null = null

  return {
    name: 'attaform',
    buildStart() {
      // Detect once at build start (fail fast on missing zod). `buildStart`
      // is guaranteed to run before any `resolveId`, so the target is set
      // before the rewrite hook fires.
      aliasTarget = resolveZodAliasTarget(root, 'attaform/rollup', resolveZodAlias, warnState)
    },
    resolveId(source, importer) {
      if (aliasTarget === null) return null
      if (source !== ZOD_UNIFIED_SPECIFIER) return null
      // Re-run the rewritten specifier through the resolver chain so the
      // matching subpath export lands as a real module. `skipSelf` keeps
      // the hook reentrant (our source check rejects the rewritten target
      // anyway, since it is no longer the bare unified specifier).
      return this.resolve(aliasTarget, importer, { skipSelf: true })
    },
  }
}
