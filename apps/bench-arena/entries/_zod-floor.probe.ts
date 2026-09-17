import { z } from 'zod'

/**
 * NOT a cohort row. The shared-validator floor: the exact schema every Zod
 * entry in `entries/` declares, plus the `safeParse` call each of their
 * adapters makes, and nothing else.
 *
 * Weighed with the identical esbuild config as the cohort rows, it answers
 * what part of a Zod row is not the form library at all. It is a floor rather
 * than an exact per-row figure because an adapter that reaches further into
 * Zod (async parsing, issue introspection) pulls a little more; none pulls
 * less, since all of them build this schema and parse against it.
 */
const schema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
})

export function validate(input: unknown): boolean {
  return schema.safeParse(input).success
}
