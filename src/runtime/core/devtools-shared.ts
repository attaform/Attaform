/**
 * Shared building blocks for Attaform's two devtools surfaces — the Vue
 * DevTools (Chrome-extension) inspector wired up in `./devtools.ts`, and
 * the Nuxt DevTools (overlay) panel wired up via `../../nuxt.ts` +
 * `../pages/_attaform_devtools.vue`.
 *
 * Houses the window-bridge contract both surfaces consume so a new
 * bridge field lands in one file. Both surfaces render RAW form values
 * by design — DevTools is a dev-only surface, and redaction across every
 * place a value surfaces is impractical security theater rather than a
 * real safeguard.
 */
import type { AttaformRegistry } from './registry'

/**
 * Property key on `window` that the Nuxt-side dev plugin attaches the
 * bridge object to. The iframe-mounted overlay panel reads
 * `window.parent[DEVTOOLS_WINDOW_KEY]` to reach the host app's registry.
 *
 * Underscored + namespaced to make accidental collision with consumer
 * globals vanishingly unlikely. Stable across versions — bumping it
 * would silently disconnect older library builds from newer overlay
 * panels in the same browser tab during a library upgrade.
 */
export const DEVTOOLS_WINDOW_KEY = '__attaform_devtools__'

/**
 * Shape of the object the host plugin attaches to `window` in dev mode.
 * The iframe overlay panel reads this to discover the live registry and
 * render its forms.
 *
 * Single-registry assumption: the latest `createAttaform()` install
 * wins. Multi-app pages (rare; typically only seen in micro-frontend
 * setups) will only see one app's forms in the panel. Documented but
 * not actively supported — the alternative (a Set of registries with
 * union-rendering) is a future call if a real consumer hits it.
 */
export interface AttaformDevtoolsBridge {
  registry: AttaformRegistry
  /**
   * The library version, surfaced in the panel's footer for support /
   * bug-report context. Read from `package.json` at host-plugin init.
   */
  version: string
}

declare global {
  interface Window {
    [DEVTOOLS_WINDOW_KEY]?: AttaformDevtoolsBridge
  }
}
