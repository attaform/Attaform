import { defineCollection, defineContentConfig, z } from '@nuxt/content'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))

export default defineContentConfig({
  collections: {
    docs: defineCollection({
      type: 'page',
      source: {
        cwd: resolve(here, '../../docs'),
        include: '**/*.md',
        // The error-code pages live under docs/e/ but serve from the
        // short /e prefix (the URL every production AF## message
        // embeds), via the `errors` collection below. Excluding them
        // here keeps each file on exactly one route.
        exclude: ['e/**'],
        prefix: '/docs',
      },
      // Frontmatter contract for every doc page. The `description`
      // field flows into <meta name="description"> + og:description +
      // twitter:description through the docs/[...slug] page (which
      // reads `page.description` and threads it into useSeoMeta).
      // Empty descriptions ship empty meta tags; Google then
      // auto-generates SERP snippets from page body, often poorly.
      // Keeping the field required (and minimum-length) means the
      // build fails the moment a new doc lands without an SEO blurb,
      // before that empty snippet ever reaches a user.
      //
      // Bounds:
      //   - 80 char min keeps the description from collapsing to a
      //     headline; Google's snippet display starts around 110.
      //   - 200 char max gives a soft cap before truncation. The
      //     classic "160" cutoff is desktop-SERP-only — mobile +
      //     featured snippets show more, and over-budget is just
      //     cosmetic.
      //
      // `title` is optional: by default the page title comes from the
      // markdown H1. Override only when the H1 isn't a great <title>
      // (contains backticks rendered as <code>, em-dashes that look
      // weird in a browser tab, or is too cryptic for a SERP entry).
      // `metaRows` and `source` feed the metadata strip and
      // source-link button rendered through the `docsPageMeta` /
      // `docsPageSource` injections in pages/docs/[...slug].vue.
      // The strip's rendering is uniform across the five page types
      // (Option / Return / Module / Directive / Reference);
      // editorial variation lives in which rows each page declares.
      //
      // The field is named `metaRows` (not bare `meta`) because
      // `meta` is a reserved Nuxt Content frontmatter key — it gets
      // mapped onto SEO meta tags by @nuxtjs/seo and never reaches
      // the page object. A custom name keeps the rows intact.
      //
      // Both fields stay optional so non-reference pages (the
      // narrative spine of Getting Started, the conceptual openers
      // of each category) can ship without a metadata strip when
      // the page has nothing structured to expose.
      schema: z.object({
        title: z.string().optional(),
        description: z
          .string()
          .min(80, 'description must be at least 80 characters for a useful SERP snippet')
          .max(200, 'description over 200 characters will get truncated in most SERPs'),
        metaRows: z
          .array(
            z.object({
              label: z.string(),
              value: z.string(),
              kind: z.enum(['text', 'code', 'link']).optional(),
            })
          )
          .optional(),
        source: z.string().url().optional(),
      }),
    }),
    // The AF## error-code reference: one page per code plus the /e
    // index. Sourced from docs/e/ (excluded from the docs collection
    // above) and served from the short /e prefix so the URL inside
    // every production `[attaform] AF## attaform.dev/e/af##` message
    // stays compact. Rendered by pages/e/[...slug].vue; the same
    // description bounds as the docs collection keep SERP snippets
    // healthy for people who search a code instead of clicking it.
    errors: defineCollection({
      type: 'page',
      source: {
        cwd: resolve(here, '../../docs/e'),
        include: '**/*.md',
        prefix: '/e',
      },
      schema: z.object({
        title: z.string().optional(),
        description: z
          .string()
          .min(80, 'description must be at least 80 characters for a useful SERP snippet')
          .max(200, 'description over 200 characters will get truncated in most SERPs'),
      }),
    }),
  },
})
