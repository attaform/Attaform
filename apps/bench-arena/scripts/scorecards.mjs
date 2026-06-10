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
 * A lookup resolves to one of three states, because an absent score has two
 * very different meanings the docs must never conflate:
 *   - 'published'      the API served a score (a fact about the project)
 *   - 'not-published'  the API returned 404: the project has not opted into a
 *                      Scorecard (a choice by the project, not a deficiency)
 *   - 'unavailable'    the lookup did not complete: a timeout, a network
 *                      error, a non-404 response, or a malformed body (a gap
 *                      on our side this run, never a statement about the
 *                      project)
 *
 * The lookup is best-effort and never gates a run. The monthly CI run
 * refreshes whatever the API serves that day; the committed score is a
 * snapshot, and the viewer link always reflects the live result.
 */
const API = 'https://api.securityscorecards.dev/projects'
const TIMEOUT_MS = 12_000

/** The public viewer URL for a "github.com/owner/repo" slug (always live). */
export function scorecardViewerUrl(slug) {
  return `https://scorecard.dev/viewer/?uri=${slug}`
}

/**
 * Look up one repository's Scorecard. Returns a discriminated result:
 * { status: 'published', score, date } when the API serves a score,
 * { status: 'not-published' } on a 404 (the project opted out), or
 * { status: 'unavailable' } on any timeout, network error, non-404 response,
 * or malformed body. Never throws.
 */
async function fetchOne(slug) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${API}/${slug}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (res.status === 404) return { status: 'not-published' }
    if (!res.ok) return { status: 'unavailable' }
    const body = await res.json()
    if (typeof body?.score !== 'number') return { status: 'unavailable' }
    return { status: 'published', score: body.score, date: body.date ?? null }
  } catch {
    return { status: 'unavailable' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve Scorecard results for a set of "github.com/owner/repo" slugs in
 * parallel. Returns a slug -> { status, ... } map (see fetchOne for the per-slug
 * shape); falsy slugs are dropped. Never throws.
 */
export async function fetchScorecards(slugs) {
  const unique = [...new Set(slugs.filter(Boolean))]
  const entries = await Promise.all(unique.map(async (slug) => [slug, await fetchOne(slug)]))
  return Object.fromEntries(entries)
}
