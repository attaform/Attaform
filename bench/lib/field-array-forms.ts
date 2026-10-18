/**
 * The schema and operations for the typed array helper measurements:
 * `bench/field-arrays.bench.ts` (vitest, dev build, trends only) and the
 * array-op modes of `scripts/construction-ab.mjs` (production builds,
 * interleaved A/B). Both import this file, so the two tools measure the same
 * shape.
 *
 * Like `construction-forms.ts`, it has no runtime imports and is erasable
 * TypeScript only, so the plain-node A/B script reads it through Node's
 * built-in type stripping. The schema builder takes the adapter's `z`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { z as zod } from 'zod'

export type Post = { title: string; body: string; tags: string[] }

/**
 * A list of posts, each with two leaves and an empty list of its own. Typed
 * against zod v4's `z`, which the bench passes, so its form is typed; the A/B
 * script passes either adapter's, both building it with the same calls.
 */
export function fieldArraySchema(z: typeof zod) {
  return z.object({
    posts: z.array(
      z.object({
        title: z.string(),
        body: z.string(),
        tags: z.array(z.string()),
      })
    ),
  })
}

export function newPost(i: number): Post {
  return { title: `post-${i}`, body: 'x', tags: [] }
}

export type FieldArrayOp = 'append' | 'remove' | 'insert' | 'swap' | 'move' | 'replace'

/**
 * One call of each typed helper on a form seeded with `rows` posts, as the
 * `i`th call of a batch. Each targets a slot that stays in range for the
 * batch: `remove` and `insert` the middle of the list as it shrinks or
 * grows, `swap` and `move` the two ends, `replace` the middle row.
 */
export const FIELD_ARRAY_OPS: Record<FieldArrayOp, (form: any, rows: number, i: number) => void> = {
  append: (form, _rows, i) => form.append('posts', newPost(i)),
  remove: (form, rows, i) => form.remove('posts', (rows - i) >> 1),
  insert: (form, rows, i) => form.insert('posts', (rows + i) >> 1, newPost(i)),
  swap: (form, rows) => form.swap('posts', 0, rows - 1),
  move: (form, rows) => form.move('posts', 0, rows - 1),
  replace: (form, rows, i) => form.replace('posts', rows >> 1, newPost(i)),
}
