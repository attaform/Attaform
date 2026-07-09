#!/usr/bin/env node
/**
 * Attaform CLI.
 *
 * `attaform skill [dir]` copies the bundled Agent Skill (which ships in
 * the package under `skills/attaform/`) into a project so an AI
 * assistant loads it while working on a form. The skill moves in
 * lockstep with the installed Attaform version: run through `npx` in a
 * project that already has Attaform and it copies that version's skill.
 *
 * With no `[dir]`, it places the skill next to whichever assistants the
 * project already uses (`.claude/`, `.cursor/`, `.codex/`, `.agents/`)
 * and falls back to the vendor-neutral `.agents/skills/` when none is
 * present. `SKILL.md` is one portable format, so a single copy is read
 * natively by Claude Code, Cursor, Codex, OpenCode, and the rest.
 *
 * Zero dependencies (Node built-ins only), so it ships verbatim with no
 * build step.
 */
import { cpSync, existsSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The skill directory bundled in the package, resolved relative to this
// file (`bin/attaform.mjs` -> `skills/attaform/`). It ships via the
// package.json `files` entry, so it is present in both the git checkout
// and the installed package.
const SKILL_SOURCE = fileURLToPath(new URL('../skills/attaform/', import.meta.url))

// The vendor-neutral skills directory: read by OpenCode, Cursor, Cline,
// and others, and the destination when a project has not committed to a
// single assistant yet.
const NEUTRAL_SKILLS_DIR = '.agents/skills'

// Marker directory an assistant creates -> the skills directory it reads.
// `SKILL.md` is one portable format, so the same files drop into each.
// Detection is intentionally narrow: only paths a project would not have
// for another reason (unlike `.github/`, which nearly every repo carries).
const ASSISTANT_SKILL_DIRS = [
  { marker: '.claude', skillsDir: '.claude/skills' },
  { marker: '.cursor', skillsDir: '.cursor/skills' },
  { marker: '.codex', skillsDir: '.codex/skills' },
  { marker: '.agents', skillsDir: NEUTRAL_SKILLS_DIR },
]

function usage() {
  console.log(
    [
      'Usage: attaform skill [dir]',
      '',
      "  Copy Attaform's Agent Skill into your project so an AI assistant",
      '  loads it while working on a form.',
      '',
      '  With no [dir], the skill lands next to each assistant the project',
      '  already uses (.claude, .cursor, .codex, .agents), or',
      `  ${NEUTRAL_SKILLS_DIR}/ when none is present.`,
      '',
      '  [dir]   Skills directory to install into, e.g. attaform skill .cursor/skills',
    ].join('\n')
  )
}

function countFiles(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    total += entry.isDirectory() ? countFiles(resolve(dir, entry.name)) : 1
  }
  return total
}

// The skills directories to install into. An explicit arg wins verbatim.
// Otherwise place next to each assistant the project already uses, and
// fall back to the vendor-neutral directory when none is detected.
function resolveTargets(dirArg) {
  if (dirArg !== undefined) return { dirs: [dirArg], detected: true }

  const dirs = ASSISTANT_SKILL_DIRS.filter(({ marker }) =>
    existsSync(resolve(process.cwd(), marker))
  ).map(({ skillsDir }) => skillsDir)

  return dirs.length > 0
    ? { dirs, detected: true }
    : { dirs: [NEUTRAL_SKILLS_DIR], detected: false }
}

function installSkill(skillsDir) {
  const dest = resolve(skillsDir, 'attaform')
  const existed = existsSync(dest)
  cpSync(SKILL_SOURCE, dest, { recursive: true })

  const where = relative(process.cwd(), dest) || dest
  const count = countFiles(dest)
  console.log(
    `${existed ? 'Updated' : 'Installed'} the Attaform skill (${count} file${count === 1 ? '' : 's'}) at ${where}/`
  )
}

const [command, dirArg] = process.argv.slice(2)

if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
  usage()
  process.exit(0)
}

if (command !== 'skill') {
  console.error(`attaform: unknown command "${command}"\n`)
  usage()
  process.exit(1)
}

try {
  const { dirs, detected } = resolveTargets(dirArg)
  for (const dir of dirs) installSkill(dir)
  if (!detected) {
    console.log(
      `No assistant directory found, so the skill went to the vendor-neutral ${NEUTRAL_SKILLS_DIR}/. Pass a path (e.g. attaform skill .claude/skills) to target a specific assistant.`
    )
  }
  console.log('Your assistant will load it while it works on a form in this project.')
} catch (error) {
  console.error(
    `attaform: could not install the skill: ${error instanceof Error ? error.message : String(error)}`
  )
  process.exit(1)
}
