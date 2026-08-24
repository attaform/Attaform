<script setup lang="ts">
  import { computed, ref } from 'vue'
  import { ArrowRight, Search, X } from 'lucide-vue-next'
  import type { MinimarkNode } from '@nuxt/content'

  // The AF## error-code index. One row per page in the `errors`
  // collection (docs/e/af##.md), so a new code page lists itself here
  // without extra wiring: the code is the page title, the row text is
  // the `condition` frontmatter field, and the search haystack is the
  // page's full text. Production builds emit these codes as
  // `[attaform] AF## attaform.dev/e/af##`, and someone holding such a
  // message often searches a fragment of it rather than clicking the
  // link, so the filter matches deep into each page's body and shows
  // the matching excerpt on the row.

  type ErrorRow = {
    code: string
    path: string
    condition: string
    text: string
  }

  // Flatten a minimark subtree to its visible text. Element nodes are
  // `[tag, props, ...children]`; rest-destructuring keeps the child
  // list typed.
  function flattenText(nodes: MinimarkNode[]): string {
    let out = ''
    for (const node of nodes) {
      if (typeof node === 'string') {
        out += `${node} `
      } else {
        const [, , ...children] = node
        out += flattenText(children)
      }
    }
    return out
  }

  const { data: rows } = await useAsyncData('errors-index', async () => {
    const pages = await queryCollection('errors').order('path', 'ASC').all()
    return pages.map(
      (page): ErrorRow => ({
        code: page.title ?? page.path.slice('/e/'.length).toUpperCase(),
        path: page.path,
        condition: page.condition,
        text: `${page.description} ${flattenText(page.body.value)}`.replace(/\s+/g, ' ').trim(),
      })
    )
  })

  const { attaformVersion } = useRuntimeConfig().public

  useHead({ title: 'Error codes' })
  useSeoMeta({
    description:
      'Every AF code an Attaform production build can emit, decoded. Each page carries the full development message, the cause, and the way out.',
  })

  const query = ref('')

  type ExcerptSegments = { pre: string; match: string; post: string }
  type Hit = { row: ErrorRow; excerpt: ExcerptSegments | null }

  // ±56 characters of context around the first match keeps the
  // excerpt to roughly one rendered line at the list's width.
  const EXCERPT_RADIUS = 56

  function buildExcerpt(text: string, at: number, length: number): ExcerptSegments {
    const start = Math.max(0, at - EXCERPT_RADIUS)
    const end = Math.min(text.length, at + length + EXCERPT_RADIUS)
    return {
      pre: `${start > 0 ? '…' : ''}${text.slice(start, at)}`,
      match: text.slice(at, at + length),
      post: `${text.slice(at + length, end)}${end < text.length ? '…' : ''}`,
    }
  }

  const hits = computed<Hit[]>(() => {
    const all = rows.value ?? []
    const q = query.value.trim().toLowerCase()
    if (!q) return all.map((row) => ({ row, excerpt: null }))
    const out: Hit[] = []
    for (const row of all) {
      const visibleMatch =
        row.code.toLowerCase().includes(q) ||
        row.condition.replaceAll('`', '').toLowerCase().includes(q)
      const at = row.text.toLowerCase().indexOf(q)
      if (!visibleMatch && at === -1) continue
      // An excerpt renders only when the row itself doesn't show why
      // it matched — a hit inside the page body.
      out.push({
        row,
        excerpt: !visibleMatch && at >= 0 ? buildExcerpt(row.text, at, q.length) : null,
      })
    }
    return out
  })

  const countLabel = computed(() => {
    const total = rows.value?.length ?? 0
    if (!query.value.trim()) return `${total} codes`
    const n = hits.value.length
    return n === 1 ? `1 of ${total} codes matches` : `${n} of ${total} codes match`
  })

  type ConditionSegment = { code: boolean; text: string }

  // Condition strings author inline code with backticks; odd segments
  // of the split are the code spans, rendered with the same
  // `inline-code` chip the docs prose uses.
  function conditionSegments(condition: string): ConditionSegment[] {
    return condition
      .split('`')
      .map((text, index) => ({ code: index % 2 === 1, text }))
      .filter((segment) => segment.text.length > 0)
  }
</script>

<template>
  <div class="mx-auto w-full max-w-3xl px-6 py-16">
    <p class="text-sm font-semibold tracking-wide text-accent uppercase">Production diagnostics</p>
    <h1 class="mt-3 text-display-md font-semibold text-fg">Error codes</h1>
    <p class="mt-4 text-base text-fg-muted">
      Attaform keeps production diagnostics compact: each condition throws or logs as a stable code
      in the shape <UiInlineCode>[attaform] AF10 attaform.dev/e/af10</UiInlineCode>, and the link in
      the message lands here. Development builds carry the full explanation inline instead, so the
      fastest way to a rich message is running the same interaction on a dev build.
    </p>
    <p class="mt-3 text-sm text-fg-muted">
      Codes are stable identifiers. A retired code is never reassigned, and the message text around
      a code can evolve without notice; branch on the error class or the code, never on the prose.
      Each page describes the current release, v{{ attaformVersion }}: the code's meaning holds
      across versions, while the quoted development message and the fix guidance track the latest
      code.
    </p>

    <div class="sticky top-16 z-30 mt-6 bg-bg/85 py-3 backdrop-blur">
      <div class="relative">
        <Search
          class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-subtle"
          :stroke-width="2"
        />
        <input
          v-model="query"
          type="text"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          aria-label="Search error codes"
          placeholder="Search by code or message text…"
          class="w-full rounded-md border border-border bg-bg py-2 pr-9 pl-9 text-sm text-fg shadow-xs transition-colors duration-(--duration-fast) placeholder:text-fg-subtle focus:border-accent focus:ring-4 focus:ring-accent-ring focus:outline-none"
        />
        <button
          v-if="query"
          type="button"
          aria-label="Clear search"
          class="absolute top-1/2 right-2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-fg-subtle transition-colors duration-(--duration-fast) hover:bg-surface hover:text-fg"
          @click="query = ''"
        >
          <X class="h-4 w-4" :stroke-width="2" />
        </button>
      </div>
      <p class="mt-2.5 text-xs text-fg-subtle" aria-live="polite">{{ countLabel }}</p>
    </div>

    <ul
      v-if="hits.length > 0"
      class="mt-2 divide-y divide-border overflow-hidden rounded-xl border bg-bg shadow-xs"
    >
      <li v-for="hit in hits" :key="hit.row.path">
        <NuxtLink
          :to="hit.row.path"
          class="group flex items-start gap-4 px-4 py-3.5 transition-colors duration-(--duration-fast) hover:bg-surface/50 focus-visible:ring-4 focus-visible:ring-accent-ring focus-visible:ring-inset focus-visible:outline-none sm:px-5"
        >
          <span
            class="mt-px inline-flex h-6 shrink-0 items-center rounded-md border border-border bg-surface px-2 font-mono text-xs font-semibold text-fg"
          >
            {{ hit.row.code }}
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium text-fg group-hover:text-accent">
              <template v-for="(segment, i) in conditionSegments(hit.row.condition)" :key="i">
                <code v-if="segment.code" class="inline-code">{{ segment.text }}</code>
                <template v-else>{{ segment.text }}</template>
              </template>
            </span>
            <span v-if="hit.excerpt" class="mt-1 block text-xs text-fg-muted">
              {{ hit.excerpt.pre
              }}<mark class="bg-transparent font-semibold text-accent">{{ hit.excerpt.match }}</mark
              >{{ hit.excerpt.post }}
            </span>
          </span>
          <ArrowRight
            class="mt-1 h-4 w-4 shrink-0 text-fg-subtle opacity-0 transition-opacity duration-(--duration-fast) group-hover:text-accent group-hover:opacity-100"
            :stroke-width="2.25"
          />
        </NuxtLink>
      </li>
    </ul>

    <div
      v-else
      class="mt-4 rounded-xl border border-dashed border-border bg-surface/30 p-10 text-center"
    >
      <p class="text-fg-muted">
        No codes match
        <code class="rounded bg-surface px-1.5 py-0.5 font-mono text-[0.8125rem] text-fg">{{
          query
        }}</code
        >.
      </p>
      <button type="button" class="mt-3 text-sm text-accent hover:underline" @click="query = ''">
        Clear search
      </button>
    </div>
  </div>
</template>
