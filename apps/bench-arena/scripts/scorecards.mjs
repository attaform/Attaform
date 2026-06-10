/**
 * Best-effort OpenSSF Scorecard lookups for the cohort.
 *
 * A published Scorecard (https://scorecard.dev) is a project's opt-in,
 * point-in-time measurement of supply-chain best practices (branch
 * protection, signed releases, pinned dependencies, CI hardening, and so
 * on). The benchmark stamps each library's current score into results.json
 * so the docs can show it alongside the size and runtime figures, since a
 * library's supply-chain posture is part of the honest "what does adopting
 * this cost me" picture, especially for an audited downstream consumer.
 *
 * The lookup is best-effort and never gates a run: a repository that has
 * not published a Scorecard returns 404 (the common case), and a network
 * error or timeout resolves to null. The docs render a null as "not
 * published" and link the repository instead, and the monthly CI run
 * refreshes whatever the API serves that day. The committed score is a
 * snapshot; the viewer link always reflects the live result.
 */
const API = 'https://api.securityscorecards.dev/projects'
const TIMEOUT_MS = 12_000

/** The public viewer URL for a "github.com/owner/repo" slug (always live). */
export function scorecardViewerUrl(slug) {
  return `https://scorecard.dev/viewer/?uri=${slug}`
}

/** Fetch one repository's published score; null on 404, error, or timeout. */
async function fetchOne(slug) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${API}/${slug}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    const body = await res.json()
    if (typeof body?.score !== 'number') return null
    return { score: body.score, date: body.date ?? null }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve published scores for a set of "github.com/owner/repo" slugs in
 * parallel. Returns a slug -> { score, date } | null map; falsy slugs are
 * dropped. Never throws.
 */
export async function fetchScorecards(slugs) {
  const unique = [...new Set(slugs.filter(Boolean))]
  const entries = await Promise.all(unique.map(async (slug) => [slug, await fetchOne(slug)]))
  return Object.fromEntries(entries)
}
