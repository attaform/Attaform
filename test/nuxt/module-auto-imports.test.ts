import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttaformModuleOptions } from '../../src/nuxt'
import { attaformAutoImports } from '../../src/runtime/auto-imports'

/**
 * Drives `attaform/nuxt`'s `setup` against a hand-built fake Nuxt to
 * prove the auto-import wiring and its `autoImports` toggle, without
 * standing up a real Nuxt build. `@nuxt/kit`'s `add*` helpers each reach
 * for a live Nuxt context, so they are replaced with spies; the rest of
 * the kit (notably `createResolver`) stays real.
 */
const { addImports, addPlugin, addVitePlugin } = vi.hoisted(() => ({
  addImports: vi.fn(),
  addPlugin: vi.fn(),
  addVitePlugin: vi.fn(),
}))

vi.mock('@nuxt/kit', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    // Return a plain callable that runs `setup` with merged options,
    // skipping Nuxt's option normalization + compatibility checks (which
    // would demand a real Nuxt instance).
    defineNuxtModule: (definition: {
      defaults?: object
      setup: (options: object, nuxt: object) => void
    }) => {
      return (options: object, nuxt: object) =>
        definition.setup({ ...(definition.defaults ?? {}), ...options }, nuxt)
    },
    addImports,
    addPlugin,
    addVitePlugin,
  }
})

// Imported after the mock is registered so the module's `@nuxt/kit`
// bindings resolve to the spies above.
const attaformModule = (await import('../../src/nuxt')).default

// The mocked `defineNuxtModule` returns a bare `(options, nuxt) => void`.
// Cast through the mock's real runtime shape to invoke it with a fake
// Nuxt — a test-harness cast, not a library type gap.
type ModuleInvoke = (options: Partial<AttaformModuleOptions>, nuxt: FakeNuxt) => void
const invokeModule = attaformModule as unknown as ModuleInvoke

interface FakeNuxt {
  options: {
    runtimeConfig: { public: Record<string, unknown> }
    vite: { optimizeDeps?: { include?: string[] } }
    rootDir: string
    dev: boolean
  }
  hook: ReturnType<typeof vi.fn>
}

function makeNuxt(): FakeNuxt {
  return {
    options: {
      runtimeConfig: { public: {} },
      vite: {},
      rootDir: process.cwd(),
      dev: false,
    },
    hook: vi.fn(),
  }
}

describe('attaform/nuxt auto-import wiring', () => {
  beforeEach(() => {
    addImports.mockClear()
    addPlugin.mockClear()
    addVitePlugin.mockClear()
  })

  it('registers the full manifest by default', () => {
    invokeModule({}, makeNuxt())
    expect(addImports).toHaveBeenCalledTimes(1)
    expect(addImports).toHaveBeenCalledWith(attaformAutoImports)
  })

  it('skips registration when autoImports is false', () => {
    invokeModule({ autoImports: false }, makeNuxt())
    expect(addImports).not.toHaveBeenCalled()
  })

  it('still installs the Vite plugin and runtime plugin when auto-imports are off', () => {
    // The toggle must gate only `addImports`, never the SSR-critical Vite
    // transforms or the registry plugin.
    invokeModule({ autoImports: false }, makeNuxt())
    expect(addVitePlugin).toHaveBeenCalledTimes(1)
    expect(addPlugin).toHaveBeenCalledTimes(1)
  })
})
