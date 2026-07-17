import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * Standing guard for the release-pr "Classify dispatch state" step.
 *
 * That step probes whether `release/v<next>` exists and routes the
 * dispatch (fresh / noop / orphan) off the HTTP status. A GitHub API
 * incident once broke it two ways at once (run 29541965084): a ~55KB
 * 5xx error body tripped a broken pipe in `echo "$RAW" | head` under
 * pipefail, and a 5xx fell through the case to the fatal catch-all.
 *
 * This test extracts the step's real `run:` script from the workflow and
 * runs it verbatim against a mocked `gh`, asserting the routing for every
 * status class. Because it executes the shipped block (not a copy), the
 * guard cannot drift from what CI runs: any future edit that drops the
 * retry, reintroduces the `echo | head` parse, or treats a 5xx as fatal
 * fails here. `gh`, `sleep`, and `jq` are shimmed; bash, awk, git, and
 * seq are the real tools. The suite skips where bash is absent (Windows);
 * the CI matrix runs on ubuntu.
 */

const repoRoot = join(__dirname, '..', '..')
const workflowPath = join(repoRoot, '.github', 'workflows', 'release-pr.yml')

const hasBash = spawnSync('bash', ['-c', 'echo ok']).status === 0

/** Pull one step's `run:` block out of the workflow YAML, dedented. */
function extractRunBlock(yamlText: string, stepName: string): string {
  const lines = yamlText.split('\n')
  const nameIdx = lines.findIndex((l) => new RegExp(`^\\s*- name: ${stepName}\\s*$`).test(l))
  if (nameIdx === -1) throw new Error(`step not found: ${stepName}`)

  let runIdx = -1
  let runIndent = 0
  for (let i = nameIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const m = line.match(/^(\s*)run: \|-?\s*$/)
    if (m) {
      runIdx = i
      runIndent = m[1]?.length ?? 0
      break
    }
    if (/^\s*- name: /.test(line)) break // a new step began before `run:`
  }
  if (runIdx === -1) throw new Error(`no run block for step: ${stepName}`)

  const body: string[] = []
  for (let i = runIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const indent = line.length - line.trimStart().length
    if (line.trim() !== '' && indent <= runIndent) break // next key or step
    body.push(line)
  }
  const minIndent = Math.min(
    ...body.filter((l) => l.trim() !== '').map((l) => l.length - l.trimStart().length)
  )
  return body.map((l) => l.slice(minIndent)).join('\n')
}

/** A minimal `gh api -i` response: status line, one header, blank, body. */
function httpResponse(status: string, body = '{}'): string {
  return [`HTTP/2.0 ${status}`, 'content-type: application/json', '', body].join('\r\n')
}

// Larger than the 64KB pipe buffer: this is the size class that tripped
// the original `echo "$RAW" | head` broken pipe on the Linux runner.
const bigBody = 'x'.repeat(120_000)

interface RunOpts {
  response?: string
  apiExit?: number
  prNumber?: string
}

let workDir: string
let binDir: string
let scriptPath: string
let runBlock: string

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'attaform-release-classify-'))
  binDir = join(workDir, 'bin')
  mkdirSync(binDir)

  // gh mock: serve the canned probe response, log every invocation, and
  // answer `pr list` / `api -X DELETE` for the downstream split.
  const ghMock = [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> "$MOCK_GH_LOG"',
    'case "$*" in',
    '  *"api -i"*"branches/"*)',
    '    if [ -f "${MOCK_GH_RESPONSE_FILE:-}" ]; then cat "$MOCK_GH_RESPONSE_FILE"; fi',
    '    exit "${MOCK_GH_API_EXIT:-0}"',
    '    ;;',
    '  *"pr list"*) printf "%s" "${MOCK_PR_NUMBER:-}"; exit 0 ;;',
    '  *"api -X DELETE"*) exit 0 ;;',
    '  *) exit 0 ;;',
    'esac',
    '',
  ].join('\n')
  writeFileSync(join(binDir, 'gh'), ghMock)
  chmodSync(join(binDir, 'gh'), 0o755)

  // Instant backoff so the retry scenarios do not actually wait ~50s.
  writeFileSync(join(binDir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n')
  chmodSync(join(binDir, 'sleep'), 0o755)

  // The orphan path feeds the branch body to `jq -r .commit.sha`; the
  // value is only logged, so a fixed sha satisfies the routing.
  writeFileSync(
    join(binDir, 'jq'),
    '#!/usr/bin/env bash\ncat >/dev/null 2>&1 || true\nprintf "mocksha"\n'
  )
  chmodSync(join(binDir, 'jq'), 0o755)

  runBlock = extractRunBlock(readFileSync(workflowPath, 'utf-8'), 'Classify dispatch state')
  scriptPath = join(workDir, 'classify.sh')
  writeFileSync(scriptPath, runBlock)
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function runClassify(opts: RunOpts) {
  const responseFile = join(workDir, 'response.txt')
  const ghLog = join(workDir, 'gh.log')
  const outputFile = join(workDir, 'github_output.txt')
  writeFileSync(responseFile, opts.response ?? '')
  writeFileSync(ghLog, '')
  writeFileSync(outputFile, '')

  const res = spawnSync('bash', [scriptPath], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
      GITHUB_OUTPUT: outputFile,
      GH_REPOSITORY: 'attaform/Attaform',
      GH_SERVER_URL: 'https://github.com',
      NEXT_VERSION: '0.27.2',
      GH_TOKEN: 'mock-token',
      MOCK_GH_RESPONSE_FILE: responseFile,
      MOCK_GH_API_EXIT: String(opts.apiExit ?? 0),
      MOCK_PR_NUMBER: opts.prNumber ?? '',
      MOCK_GH_LOG: ghLog,
    },
  })

  const output: Record<string, string> = {}
  for (const line of readFileSync(outputFile, 'utf-8').split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) output[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    output,
    ghLog: readFileSync(ghLog, 'utf-8'),
  }
}

describe.skipIf(!hasBash)('release-pr classify dispatch routing', () => {
  it('keeps the SIGPIPE-safe parse and drops the echo | head anti-pattern', () => {
    // Source-level lock that holds on every platform, including where the
    // Linux-only broken pipe would not reproduce at runtime. Assert on the
    // code with full-line comments stripped, since the comment that
    // explains the fix names the old `echo "$RAW" | head` on purpose.
    const code = runBlock
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
    expect(code).toContain('read -r _ HTTP_STATUS _ <<<')
    expect(code).not.toContain('echo "$RAW" | head')
    expect(code).toContain('case "${HTTP_STATUS:-}"')
  })

  it('routes an existing branch with an open PR to noop', () => {
    const r = runClassify({
      response: httpResponse('200 OK', '{"commit":{"sha":"abc123"}}'),
      prNumber: '42',
    })
    expect(r.status).toBe(0)
    expect(r.output['mode']).toBe('noop')
    expect(r.stdout).toContain('Release PR already open')
  })

  it('parses a 200 with a body past the pipe buffer without a broken pipe', () => {
    // The original bug: a large body made `echo | head` take EPIPE under
    // pipefail. Old code would exit 1 here (mode never set) on Linux.
    const r = runClassify({ response: httpResponse('200 OK', bigBody), prNumber: '42' })
    expect(r.status).toBe(0)
    expect(r.output['mode']).toBe('noop')
    expect(r.stdout).not.toContain('Broken pipe')
  })

  it('cleans up an orphan branch (exists, no open PR) and routes to fresh', () => {
    const r = runClassify({
      response: httpResponse('200 OK', '{"commit":{"sha":"abc123"}}'),
      prNumber: '',
    })
    expect(r.status).toBe(0)
    expect(r.output['mode']).toBe('fresh')
    expect(r.ghLog).toContain('api -X DELETE')
  })

  it('routes an absent branch (404) to fresh', () => {
    const r = runClassify({
      response: httpResponse('404 Not Found', '{"message":"Branch not found"}'),
    })
    expect(r.status).toBe(0)
    expect(r.output['mode']).toBe('fresh')
    expect(r.stdout).toContain('Fresh dispatch')
  })

  it('retries a 5xx with a large error body, then fails with an actionable message', () => {
    const r = runClassify({ response: httpResponse('503 Service Unavailable', bigBody) })
    expect(r.status).toBe(1)
    expect(r.output['mode']).toBeUndefined()
    expect(r.stdout).toContain('Attempt 1/5')
    expect(r.stdout).toContain('still failing after 5 attempts')
    expect(r.stdout).not.toContain('Broken pipe')
  })

  it('retries a 500 before failing', () => {
    const r = runClassify({ response: httpResponse('500 Internal Server Error') })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('still failing after 5 attempts')
  })

  it('retries a 429 rate limit before failing', () => {
    const r = runClassify({ response: httpResponse('429 Too Many Requests') })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('still failing after 5 attempts')
  })

  it('retries an empty body from a dropped connection before failing', () => {
    const r = runClassify({ response: '', apiExit: 1 })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('still failing after 5 attempts')
  })

  it('fails fast on an unexpected 4xx without retrying', () => {
    const r = runClassify({
      response: httpResponse('401 Unauthorized', '{"message":"Bad credentials"}'),
    })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('Unexpected HTTP status')
    expect(r.stdout).not.toContain('Attempt 1/5')
  })
})
