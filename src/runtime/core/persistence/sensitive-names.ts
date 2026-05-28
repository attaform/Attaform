import { __DEV__ } from '../dev'
import type { Path, PathKey, Segment } from '../paths'

/**
 * The library's built-in conservative set of identifier name stems that
 * flag a path segment as "this looks like data the consumer almost
 * certainly does not want serialised to client-side storage or
 * broadcast across tabs."
 *
 * Each entry is a NAME STEM, not a regex. Matching is case-insensitive
 * and tolerant of separator variants — `'card_number'` matches the
 * segments `'card_number'`, `'card-number'`, `'cardNumber'`, and
 * `'cardnumber'`. Short stems (compact length ≤ 5) get word-boundary
 * anchors to avoid common false positives — `'pin'` matches `'pin'`
 * and `'user_pin'` but not `'pinned'`; `'token'` matches `'token'` but
 * not `'tokenizer'`. Longer stems match anywhere (`'password'` matches
 * `'password'`, `'passwords'`, `'userPassword'`).
 *
 * Consumers extend or replace via per-form or global config:
 *
 * ```ts
 * createAttaform({
 *   defaults: { sensitiveNames: [...DEFAULT_SENSITIVE_NAMES, 'mrn', 'tax_id'] }
 * })
 * ```
 *
 * The same resolved predicate gates persistence writes and multi-tab
 * sync broadcasts — one source of truth for "what counts as sensitive"
 * across those surfaces. (DevTools renders raw values by design.)
 *
 * **Non-goals.** This is not a soundness guarantee. Adversarial paths
 * (`'sensitive_data'`, `'CCV'` instead of `'CVV'`) can slip through.
 * The intent is a code-review trigger for the common-case footgun
 * plus a defense-in-depth filter on the cross-tab and DevTools
 * surfaces.
 */
export const DEFAULT_SENSITIVE_NAMES: readonly string[] = Object.freeze([
  // Passwords + PIN-like
  'password',
  'passwd',
  'pwd',
  'pin',
  // Card / payment
  'cvv',
  'cvc',
  'card_number',
  'card_num',
  'card',
  'iban',
  'routing_number',
  'account_number',
  // Government / identity
  'ssn',
  'social_security',
  'dob',
  'date_of_birth',
  'passport',
  'driver_license',
  // Tax IDs
  'tin',
  'ein',
  'itin',
  'tax_id',
  // Tokens / secrets / API auth
  'token',
  'tokens',
  'secret',
  'secrets',
  'api_key',
  'api_secret',
  'api_token',
  'private_key',
  'bearer',
  'oauth',
  'auth_token',
  'access_token',
  'refresh_token',
  'session_id',
  'session_key',
  'session_token',
  // MFA / OTP
  'otp',
  'one_time_password',
  'one_time_code',
  'mfa_secret',
  'mfa_seed',
  'mfa_code',
  'mfa_token',
  'two_factor_code',
  'two_factor_token',
  '2fa',
  '2fa_code',
  '2fa_token',
  'recovery_code',
  'backup_code',
])

/**
 * Compact-length threshold below which a stem gets word-boundary
 * anchors. Tuned so `'pin'`, `'card'`, `'token'` get boundary
 * protection (avoiding `'pinned'`, `'cards'`, `'tokenizer'`) while
 * `'passwd'`, `'secret'`, `'tokens'` match as substring (catching
 * camelCase variants like `'userPassword'`).
 */
const WORD_BOUNDARY_THRESHOLD = 5

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build a single case-insensitive regex from a name stem. Underscores,
 * hyphens, and spaces in the input become `[_\s-]?` (optional
 * separator) so `'card_number'` tolerates `'cardNumber'`,
 * `'card-number'`, `'cardnumber'`, and `'card number'` alike.
 */
function nameToRegex(name: string): RegExp {
  const parts = name.split(/[_\s-]/).filter((p) => p.length > 0)
  if (parts.length === 0) {
    // Pathological input (empty / all-separator); produce a regex that
    // matches nothing rather than throwing — keeps the caller's
    // composition surface forgiving.
    return /(?!)/
  }
  const escaped = parts.map(escapeRegex).join('[_\\s-]?')
  const compactLength = parts.reduce((sum, p) => sum + p.length, 0)
  const useBoundary = compactLength <= WORD_BOUNDARY_THRESHOLD
  const source = useBoundary ? `\\b${escaped}\\b` : escaped
  return new RegExp(source, 'i')
}

function namesToPatterns(names: readonly string[]): readonly RegExp[] {
  const patterns: RegExp[] = []
  for (const name of names) {
    if (typeof name !== 'string' || name.length === 0) continue
    patterns.push(nameToRegex(name))
  }
  return patterns
}

const DEFAULT_PATTERNS = namesToPatterns(DEFAULT_SENSITIVE_NAMES)

/**
 * Factory: returns a closure that tests a single Segment against the
 * resolved name list. `createIsSensitivePath` composes it to test the
 * segments of a full path.
 *
 * Pass an empty array to disable the heuristic entirely (no segment
 * counts as sensitive). Omitting the argument uses the library
 * default list.
 */
export function createSegmentMatchesSensitive(
  names: readonly string[] = DEFAULT_SENSITIVE_NAMES
): (segment: Segment) => boolean {
  const patterns = names === DEFAULT_SENSITIVE_NAMES ? DEFAULT_PATTERNS : namesToPatterns(names)
  return (segment: Segment) => {
    if (typeof segment !== 'string') return false
    for (const p of patterns) {
      if (p.test(segment)) return true
    }
    return false
  }
}

/**
 * Factory: returns a closure that tests a path (structured `Path`,
 * dotted-string, or canonical JSON `PathKey`) against the resolved
 * name list. True iff ANY segment matches.
 *
 * Same predicate gates persistence writes, multi-tab broadcasts, AND
 * the DevTools edit-rejection check — consumers configure once via
 * `sensitiveNames` and every surface respects it.
 */
export function createIsSensitivePath(
  names: readonly string[] = DEFAULT_SENSITIVE_NAMES
): (path: Path | PathKey | string) => boolean {
  const segmentMatches = createSegmentMatchesSensitive(names)
  return (path: Path | PathKey | string) => {
    if (typeof path !== 'string') {
      for (const segment of path) {
        if (segmentMatches(segment)) return true
      }
      return false
    }
    // String input: try JSON-array first (PathKey), fall back to dotted.
    if (path.startsWith('[')) {
      try {
        const parsed = JSON.parse(path) as unknown[]
        if (Array.isArray(parsed)) {
          for (const segment of parsed) {
            if (segmentMatches(segment as Segment)) return true
          }
          return false
        }
      } catch {
        // fall through to dotted parse
      }
    }
    for (const segment of path.split('.')) {
      if (segmentMatches(segment)) return true
    }
    return false
  }
}

const defaultSegmentMatches = createSegmentMatchesSensitive()
const defaultIsSensitivePath = createIsSensitivePath()

/**
 * True iff `segment` itself matches the LIBRARY DEFAULT sensitive-name
 * list. For consumer-configurable matching, use
 * `createSegmentMatchesSensitive(list)` to build a per-form closure.
 */
export function segmentMatchesSensitive(segment: Segment): boolean {
  return defaultSegmentMatches(segment)
}

/**
 * True iff any segment of the path matches the LIBRARY DEFAULT
 * sensitive-name list. For consumer-configurable matching, use
 * `createIsSensitivePath(list)` to build a per-form closure.
 */
export function isSensitivePath(path: Path | PathKey | string): boolean {
  return defaultIsSensitivePath(path)
}

/**
 * Dev-only dedup for the sensitive-persist warning. The directive's
 * opt-in sync re-runs on every render, so without this a static
 * sensitive field would warn on every re-render. `null` in production so
 * the Set allocation tree-shakes out.
 */
const warnedSensitivePersist: Set<string> | null = __DEV__ ? new Set<string>() : null

/**
 * Decide whether `path` may be opted into persistence. A sensitive-named
 * path opted in WITHOUT `acknowledgeSensitive: true` is refused — the
 * opt-in is skipped and a one-shot dev warning is logged. The library
 * never throws here: a misconfigured persist flag must not take down the
 * consumer's app, and the safe fallback (not persisting the secret) is
 * exactly the secure default. Returns `true` when the path may persist,
 * `false` when it was blocked.
 *
 * The optional `isSensitive` predicate lets call sites pass the per-form
 * resolved closure; omit to use the library default list.
 */
export function allowSensitivePersist(
  path: Path | PathKey | string,
  acknowledged: boolean,
  isSensitive: (p: Path | PathKey | string) => boolean = defaultIsSensitivePath
): boolean {
  if (acknowledged) return true
  if (!isSensitive(path)) return true
  if (warnedSensitivePersist !== null) {
    const display = Array.isArray(path) ? path.join('.') : String(path)
    if (!warnedSensitivePersist.has(display)) {
      warnedSensitivePersist.add(display)
      console.warn(
        `[attaform] Not persisting "${display}" — it matches a sensitive-name pattern ` +
          `(password / cvv / ssn / token / etc.) and was opted into persistence without ` +
          '`acknowledgeSensitive: true`. Storing sensitive data in client-side storage is a ' +
          'compliance risk (PII / PCI-DSS / HIPAA / SOC2). Persist it server-side, or pass ' +
          '`acknowledgeSensitive: true` to register() / form.persist() if this is intentional.'
      )
    }
  }
  return false
}

/**
 * Test-only: reset the one-shot dedup so subsequent
 * `allowSensitivePersist` calls warn fresh. Mirrors
 * `resetInsecureContextWarnDedup`.
 */
export function resetSensitivePersistWarnDedup(): void {
  warnedSensitivePersist?.clear()
}
