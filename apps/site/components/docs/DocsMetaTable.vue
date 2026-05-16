<script setup lang="ts">
  // Per-page metadata strip. Renders the compact label/value grid that
  // sits between the H1 + definition and the demo / prose body on
  // every doc page that has frontmatter `meta:` declared.
  //
  // The five page types (option, return method/prop, module,
  // directive/binding, reference) vary in *which* labels they expose,
  // but the rendering is uniform — editorial variation belongs in
  // frontmatter, not the component.
  //
  // Two access patterns:
  //
  //   1. Plain `<DocsMetaTable />` inside markdown — auto-reads
  //      `meta:` from the page frontmatter via the `docsPageMeta`
  //      injection provided by `pages/docs/[...slug].vue`. Recommended:
  //      keeps the markdown body uncluttered.
  //
  //   2. `<DocsMetaTable :rows="[...]" />` — explicit override. Used
  //      when the meta rows are computed (rare) or when rendering
  //      outside the docs-page injection context.
  //
  // `kind` controls value rendering:
  //   - 'text' (default): plain prose
  //   - 'code': monospace chip — for signatures, default values, enum
  //             members, type identifiers
  //   - 'link': hyperlink — values pointing at related docs or
  //             external references
  import { computed, inject, type Ref } from 'vue'

  type MetaRow = {
    label: string
    value: string
    kind?: 'text' | 'code' | 'link'
  }
  const props = defineProps<{ rows?: MetaRow[] }>()

  const injectedMeta = inject<Ref<MetaRow[] | undefined>>('docsPageMeta')
  const resolvedRows = computed<MetaRow[]>(() => props.rows ?? injectedMeta?.value ?? [])
</script>

<template>
  <dl
    v-if="resolvedRows.length > 0"
    class="not-prose my-6 grid grid-cols-1 gap-x-6 gap-y-3 rounded-xl border border-border bg-surface/40 p-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4"
  >
    <div v-for="row in resolvedRows" :key="row.label" class="min-w-0">
      <dt class="text-xs font-semibold tracking-wide text-fg-subtle uppercase">{{ row.label }}</dt>
      <dd class="mt-1 text-sm text-fg">
        <code
          v-if="row.kind === 'code'"
          class="inline-block max-w-full truncate rounded border border-border bg-bg px-1.5 py-0.5 align-middle font-mono text-xs"
        >
          {{ row.value }}
        </code>
        <a
          v-else-if="row.kind === 'link'"
          :href="row.value"
          target="_blank"
          rel="noopener noreferrer"
          class="text-accent hover:underline"
        >
          {{ row.value }}
        </a>
        <span v-else>{{ row.value }}</span>
      </dd>
    </div>
  </dl>
</template>
