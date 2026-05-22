#!/usr/bin/env node
/**
 * Wrapper that conditionally appends `--no-experimental-webstorage`
 * to NODE_OPTIONS before execing the given command.
 *
 * Why conditional: Node 25 ships native `localStorage` on by default
 * (see test/setup.ts for the jsdom-collision rationale). The flag
 * disables it. But Node 20 rejects `--no-experimental-webstorage` in
 * NODE_OPTIONS because the flag predates that release; passing it
 * crashes the process with "not allowed in NODE_OPTIONS" before any
 * test code runs. The flag enters the NODE_OPTIONS allowlist in Node
 * 22 (when --experimental-webstorage was introduced as opt-in) and
 * becomes load-bearing in Node 25 (when webstorage flips on by
 * default). Gating on >= 22 covers both states with a single check.
 */
import { spawnSync } from 'node:child_process'

const nodeMajor = Number(process.versions.node.split('.')[0])
const env = { ...process.env }
if (nodeMajor >= 22) {
  env.NODE_OPTIONS = [env.NODE_OPTIONS, '--no-experimental-webstorage']
    .filter(Boolean)
    .join(' ')
}

const [cmd, ...args] = process.argv.slice(2)
if (!cmd) {
  console.error('usage: run-with-webstorage-flag.mjs <cmd> [args...]')
  process.exit(2)
}

const { status, signal, error } = spawnSync(cmd, args, {
  stdio: 'inherit',
  env,
  shell: true,
})
if (error) {
  console.error(error)
  process.exit(1)
}
if (signal !== null) {
  process.kill(process.pid, signal)
}
process.exit(status ?? 1)
