// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import { installVRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import { getRegistryFromApp } from '../../src/runtime/core/registry'

describe('createAttaform', () => {
  it('installs a registry on the Vue app', () => {
    const app = createApp({ render: () => null })
    app.use(createAttaform())
    expect(getRegistryFromApp(app)).toBeDefined()
  })

  it('registers no app-level directive (delivery is compile-time or installVRegister)', () => {
    const app = createApp({ render: () => null })
    app.use(createAttaform())
    // Vue exposes directive lookup via app._context.directives (stable internal).
    // Mount a throwaway root so _context is populated.
    const host = document.createElement('div')
    app.mount(host)
    // _context is the public-ish AppContext that holds directives/components/mixins.
    // Stable across Vue 3 versions; used here as the most direct lookup.
    const ctx = app._context as unknown as { directives: Record<string, unknown> }
    // The plugin deliberately registers NO app-level directive: v-register
    // is delivered by the Vite/Nuxt compile-time binding, or by an explicit
    // installVRegister(app). An app-level registration here would weld the
    // directive cluster into every consumer's eager bundle.
    expect(ctx.directives['register']).toBeUndefined()
    app.unmount()
  })

  it('installVRegister registers the directive; idempotent; user shadow wins', () => {
    const app = createApp({ render: () => null })
    installVRegister(app)
    const ctx = app._context as unknown as { directives: Record<string, unknown> }
    expect(ctx.directives['register']).toEqual(
      expect.objectContaining({ created: expect.any(Function) })
    )
    const first = ctx.directives['register']
    // Second call is a no-op (no Vue "already registered" warn path).
    installVRegister(app)
    expect(ctx.directives['register']).toBe(first)
    // A directive the consumer registered under the same name before the
    // install is left in place.
    const shadowApp = createApp({ render: () => null })
    const shadow = { created: () => {} }
    shadowApp.directive('register', shadow)
    installVRegister(shadowApp)
    const shadowCtx = shadowApp._context as unknown as { directives: Record<string, unknown> }
    expect(shadowCtx.directives['register']).toBe(shadow)
  })

  it('passes the ssr option through to the registry', () => {
    const app = createApp({ render: () => null })
    app.use(createAttaform({ ssr: true }))
    expect(getRegistryFromApp(app).ssr).toBe(true)
  })

  it('multiple apps in the same process get independent registries', () => {
    // Bare Vue + SSR ships one module across many requests. This test proves
    // that `createAttaform()` does not rely on module-scoped state.
    const a = createApp({ render: () => null })
    const b = createApp({ render: () => null })
    a.use(createAttaform())
    b.use(createAttaform())
    expect(getRegistryFromApp(a)).not.toBe(getRegistryFromApp(b))
  })

  // D1 — installing twice on the same app is a no-op (idempotent).
  // Pre-fix, the second install overwrote `app._attaform`, orphaning
  // every form the first registry had built.
  it('a second install on the same app is a no-op and warns in dev', () => {
    const app = createApp({ render: () => null })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      app.use(createAttaform())
      const firstRegistry = getRegistryFromApp(app)
      // Second install with a fresh factory call (Vue's Plugin dedupe
      // only catches identical plugin objects).
      app.use(createAttaform())
      const secondRegistry = getRegistryFromApp(app)
      // Same registry — no overwrite.
      expect(secondRegistry).toBe(firstRegistry)
      // Single dev warning fired.
      const matched = warnSpy.mock.calls.filter((c: unknown[]) =>
        String(c[0]).includes('createAttaform() install was called twice')
      )
      expect(matched.length).toBe(1)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
