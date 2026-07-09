import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * The `attaform skill` CLI copies the bundled Agent Skill into a project.
 * These tests run the real bin as a subprocess against throwaway
 * directories and assert the skill tree lands, so a regression in the
 * copy logic (or a bundled file dropping out of `skills/`) is caught
 * before publish. No new dependency: the bin is Node built-ins only.
 */

const repoRoot = join(__dirname, '..', '..')
const binPath = join(repoRoot, 'bin', 'attaform.mjs')
const sourceSkill = join(repoRoot, 'skills', 'attaform', 'SKILL.md')

function runBin(args: string[], cwd: string = repoRoot) {
  return spawnSync(process.execPath, [binPath, ...args], { cwd, encoding: 'utf-8' })
}

let workDir: string

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'attaform-skill-cli-'))
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('attaform skill', () => {
  it('copies the skill tree into an explicit directory', () => {
    const target = join(workDir, 'explicit')
    const result = runBin(['skill', target])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Installed')
    // The main file and a nested reference both land, proving the
    // recursive copy preserves the on-disk shape.
    expect(existsSync(join(target, 'attaform', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(target, 'attaform', 'references', 'wizards.md'))).toBe(true)
    // The copy is byte-for-byte the bundled source.
    expect(readFileSync(join(target, 'attaform', 'SKILL.md'), 'utf-8')).toBe(
      readFileSync(sourceSkill, 'utf-8')
    )
  })

  it('reports an update when the skill already exists', () => {
    const target = join(workDir, 'twice')
    runBin(['skill', target])
    const second = runBin(['skill', target])

    expect(second.status).toBe(0)
    expect(second.stdout).toContain('Updated')
  })

  it('falls back to the vendor-neutral .agents/skills path when no assistant is present', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'attaform-skill-neutral-'))
    const result = runBin(['skill'], cwd)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('vendor-neutral')
    expect(existsSync(join(cwd, '.agents', 'skills', 'attaform', 'SKILL.md'))).toBe(true)
    // No assumption of Claude: the Anthropic-specific path is not written.
    expect(existsSync(join(cwd, '.claude'))).toBe(false)
    rmSync(cwd, { recursive: true, force: true })
  })

  it('installs next to a detected assistant directory', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'attaform-skill-detect-'))
    mkdirSync(join(cwd, '.cursor'))
    const result = runBin(['skill'], cwd)

    expect(result.status).toBe(0)
    expect(existsSync(join(cwd, '.cursor', 'skills', 'attaform', 'SKILL.md'))).toBe(true)
    // Only the detected assistant is targeted; the neutral fallback is skipped.
    expect(existsSync(join(cwd, '.agents'))).toBe(false)
    rmSync(cwd, { recursive: true, force: true })
  })

  it('installs into every detected assistant directory', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'attaform-skill-multi-'))
    mkdirSync(join(cwd, '.claude'))
    mkdirSync(join(cwd, '.codex'))
    const result = runBin(['skill'], cwd)

    expect(result.status).toBe(0)
    expect(existsSync(join(cwd, '.claude', 'skills', 'attaform', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(cwd, '.codex', 'skills', 'attaform', 'SKILL.md'))).toBe(true)
    rmSync(cwd, { recursive: true, force: true })
  })

  it('prints usage and exits cleanly with no command', () => {
    const result = runBin([])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Usage: attaform skill')
  })

  it('rejects an unknown command with a nonzero exit', () => {
    const result = runBin(['bogus'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unknown command')
  })
})
