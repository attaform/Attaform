/**
 * Shared webpack/rspack plugin body. Rspack mirrors webpack's plugin API
 * for the resolve hooks attaform taps, so one implementation backs both
 * `attaform/webpack` and `attaform/rspack`; only the diagnostic `tag`
 * differs.
 *
 * The plugin taps `normalModuleFactory.beforeResolve` and rewrites the
 * `attaform` / `attaform/zod` request to the matching adapter subpath, the
 * same effect as webpack's own `NormalModuleReplacementPlugin` but tapping
 * the hook directly so the plugin imports nothing from webpack/rspack
 * (keeping attaform dependency-free). The bundler injects the hook API at
 * the consumer's build, so the minimal structural types below are all the
 * plugin needs to compile.
 *
 * Build-time only: never part of a consumer's browser bundle.
 */
import { isRewritableZodSpecifier, resolveZodAliasTarget } from './detect-zod-major'

export interface WebpackFamilyPluginOptions {
  /**
   * Rewrite `attaform` and `attaform/zod` imports at build time to the
   * matching adapter subpath, based on the consumer's installed Zod major.
   * Default `true`. Set to `false` to keep the runtime-dispatch unified
   * entry (ships both adapters) when a project intentionally mixes Zod
   * versions or resolves Zod in a non-standard way.
   */
  resolveZodAlias?: boolean
  /**
   * Project root to resolve the installed Zod from. Defaults to the
   * compiler's `context`, falling back to `process.cwd()`. Set this when
   * the build runs from a directory other than the project that owns the
   * Zod dependency (some monorepo layouts).
   */
  root?: string
}

interface WebpackTapable<T> {
  tap(name: string, fn: (arg: T) => void): void
}
interface WebpackResolveData {
  request: string
}
interface WebpackNormalModuleFactory {
  hooks: { beforeResolve: WebpackTapable<WebpackResolveData> }
}
interface WebpackCompiler {
  context?: string
  hooks: { normalModuleFactory: WebpackTapable<WebpackNormalModuleFactory> }
}

/** The structural shape webpack/rspack require of a plugin: an object
 * with an `apply(compiler)` method. */
export interface WebpackFamilyPlugin {
  apply(compiler: WebpackCompiler): void
}

const TAP_NAME = 'attaform'

export function createWebpackFamilyPlugin(
  tag: string,
  options: WebpackFamilyPluginOptions
): WebpackFamilyPlugin {
  const resolveZodAlias = options.resolveZodAlias !== false
  const warnState = { warned: false }
  return {
    apply(compiler) {
      const root = compiler.context ?? options.root ?? process.cwd()
      const target = resolveZodAliasTarget(root, tag, resolveZodAlias, warnState)
      if (target === null) return
      compiler.hooks.normalModuleFactory.tap(TAP_NAME, (factory) => {
        factory.hooks.beforeResolve.tap(TAP_NAME, (data) => {
          // Rewrite both the bare `attaform` barrel and the explicit
          // `attaform/zod` (both carry the runtime dispatcher) to the one
          // detected adapter; pinned subpaths pass through untouched.
          if (isRewritableZodSpecifier(data.request)) {
            data.request = target
          }
        })
      })
    },
  }
}
