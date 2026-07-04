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
const DEFAULT_SKILLS_DIR = '.claude/skills'

function usage() {
  console.log(
    [
      'Usage: attaform skill [dir]',
      '',
      "  Copy Attaform's Agent Skill into your project so an AI assistant",
      '  loads it while working on a form.',
      '',
      `  [dir]   Skills directory to install into (default: ${DEFAULT_SKILLS_DIR}).`,
      '          Point it at another runtime, e.g. attaform skill .cursor/skills',
    ].join('\n'),
  )
}

function countFiles(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    total += entry.isDirectory() ? countFiles(resolve(dir, entry.name)) : 1
  }
  return total
}

function installSkill(skillsDir) {
  const dest = resolve(skillsDir, 'attaform')
  const existed = existsSync(dest)
  cpSync(SKILL_SOURCE, dest, { recursive: true })

  const where = relative(process.cwd(), dest) || dest
  const count = countFiles(dest)
  console.log(
    `${existed ? 'Updated' : 'Installed'} the Attaform skill (${count} file${count === 1 ? '' : 's'}) at ${where}/`,
  )
  console.log('Your assistant will load it while it works on a form in this project.')
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
  installSkill(dirArg ?? DEFAULT_SKILLS_DIR)
} catch (error) {
  console.error(`attaform: could not install the skill: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
