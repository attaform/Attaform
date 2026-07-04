import { describe, expect, it } from 'vitest'
import { isStaticFilePath } from '../apps/site/utils/prose-link'

/*
 * ProseA (apps/site/components/content/ProseA.vue) renders markdown
 * links. A link to a static public file (llms.txt, skill.md, a per-page
 * .md) must NOT go through NuxtLink: Vue Router would try to resolve and
 * prefetch a route that does not exist ("No match found" in dev, a
 * wasted prefetch in prod). This guards the file-vs-route rule the
 * component uses to pick a plain <a> over NuxtLink.
 */

describe('isStaticFilePath', () => {
  it('flags static public files by their extension', () => {
    expect(isStaticFilePath('/llms.txt')).toBe(true)
    expect(isStaticFilePath('/llms-full.txt')).toBe(true)
    expect(isStaticFilePath('/skill.md')).toBe(true)
    expect(isStaticFilePath('/docs/reference/ai-agents.md')).toBe(true)
  })

  it('ignores query and hash when testing the extension', () => {
    expect(isStaticFilePath('/skill.md?v=2')).toBe(true)
    expect(isStaticFilePath('/skill.md#top')).toBe(true)
  })

  it('leaves extensionless in-site routes as routes', () => {
    expect(isStaticFilePath('/docs/reference/ai-agents')).toBe(false)
    expect(isStaticFilePath('/docs/getting-started/installation')).toBe(false)
    expect(isStaticFilePath('/')).toBe(false)
    expect(isStaticFilePath('/play')).toBe(false)
  })

  it('does not treat a dotted mid-path segment as a file', () => {
    expect(isStaticFilePath('/docs/reading-the-form/errors')).toBe(false)
  })

  it('handles an empty or missing href', () => {
    expect(isStaticFilePath('')).toBe(false)
    expect(isStaticFilePath(undefined)).toBe(false)
  })
})
