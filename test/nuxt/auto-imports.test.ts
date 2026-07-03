import { describe, expect, it } from 'vitest'
import { attaformAutoImports, attaformAutoImportsMap } from '../../src/runtime/auto-imports'
import * as zodEntry from '../../src/zod'

/**
 * Standing diagnostic for the auto-import manifest. It is the single
 * source of truth behind both the Nuxt module's `addImports` call and
 * the `attaform/vite` preset re-export, so drift here silently changes
 * what lands in every consumer's global component scope.
 */
describe('attaformAutoImports manifest', () => {
  const names = attaformAutoImports.map((entry) => entry.name)

  it('surfaces exactly the intended component-scope composables', () => {
    expect([...names].sort()).toEqual(
      ['fieldMeta', 'injectForm', 'injectWizard', 'lazy', 'useForm', 'useWizard', 'withMeta'].sort()
    )
  })

  it('routes every binding through attaform/zod for the build-time single-adapter rewrite', () => {
    for (const entry of attaformAutoImports) {
      expect(entry.from).toBe('attaform/zod')
    }
  })

  it('only names bindings that attaform/zod actually exports', () => {
    // Catches a typo or a rename that leaves the manifest pointing at a
    // symbol the entry no longer ships — unimport would inject a dead
    // import that fails at build time in the consumer, not here.
    for (const entry of attaformAutoImports) {
      expect(zodEntry).toHaveProperty(entry.name)
    }
  })

  it('keeps setup-level and escape-hatch surface out of component scope', () => {
    // Auto-importing any of these would drop names into every
    // `<script setup>` that only make sense at plugin-install or
    // advanced-adapter level.
    for (const excluded of ['createAttaform', 'useRegister', 'useAbstractForm']) {
      expect(names).not.toContain(excluded)
    }
  })

  it('declares each name once', () => {
    expect(new Set(names).size).toBe(names.length)
  })

  it('derives the unplugin-auto-import map without dropping or duplicating a name', () => {
    // attaformAutoImportsMap groups the flat list by module for
    // unplugin-auto-import's ImportsMap shape. Round-trip it back to a
    // flat name set and confirm nothing was lost in the grouping.
    const flattened = Object.values(attaformAutoImportsMap).flat()
    expect([...flattened].sort()).toEqual([...names].sort())
    expect(attaformAutoImportsMap['attaform/zod']).toEqual(names)
  })
})
