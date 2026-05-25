<script setup lang="ts">
  import { h, type VNode } from 'vue'
  import type { Element, ElementContent, Root, RootContent, Text } from 'hast'

  // Renders Shiki's `codeToHast` output as a real Vue vnode tree.
  // Uses the hast AST (Shiki's "give me the syntax-highlight tree"
  // entry point) instead of the HTML-string entry point so the result
  // ships through Vue's normal render pipeline. No `v-html`, no
  // string interpolation, just nested `h()` calls.

  const props = defineProps<{ tree: Root | null }>()

  // hast normalises `class` to `className` (array of strings) and
  // keeps everything else as the spec-named property. Vue's `h()`
  // wants `class` (string or array). Everything else passes through.
  function normaliseProps(properties: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(properties)) {
      if (key === 'className') {
        out.class = Array.isArray(value) ? value.join(' ') : value
      } else {
        out[key] = value
      }
    }
    return out
  }

  function render(node: ElementContent | RootContent): VNode | string | null {
    if (node.type === 'text') return (node as Text).value
    if (node.type === 'element') {
      const el = node as Element
      const elProps = el.properties ? normaliseProps(el.properties) : {}
      return h(el.tagName, elProps, el.children.map(render))
    }
    // `raw`, `comment`, `doctype`, MDX nodes, etc. don't appear in
    // Shiki's `lang: 'vue' | 'ts'` output. Skip if one ever does.
    return null
  }

  // Functional component reading `props.tree` from closure. Returns
  // the root's children as siblings; Vue's fragment rendering hands
  // them back to the surrounding `<div>` cleanly.
  const Body = (): (VNode | string | null)[] | null => props.tree?.children.map(render) ?? null
</script>

<template>
  <div>
    <Body />
  </div>
</template>
