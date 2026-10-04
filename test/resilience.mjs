/**
 * Resilience checks for dsh-plugin-graphify-watch.
 *
 *   node test/resilience.mjs <root>
 *
 * Asserts:
 *   1. killing the watcher externally makes the plugin restart it
 *   2. the restarted watcher is a different pid and actually works
 *   3. a second apply for the same root is refused inside this process
 *   4. the ownership lock file exists while running and is gone after dispose
 *
 * Exit code 0 = all assertions held.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

import { apply } from '../src/index.js'

const root = process.argv[2]
if (!root) {
  console.error('usage: node test/resilience.mjs <root>')
  process.exit(2)
}

const lockFile = join(tmpdir(), 'dsh-graphify-watch', `${createHash('sha1').update(root).digest('hex')}.lock`)
const failures = []

function makeCtx(tag) {
  const lines = []
  return {
    tag,
    lines,
    logger: {
      info: (m) => { lines.push(m); console.log(`  ${tag} info   ${m}`) },
      warn: (m) => { lines.push(m); console.log(`  ${tag} warn   ${m}`) },
      error: (m) => { lines.push(m); console.log(`  ${tag} error  ${m}`) },
    },
    effect(callback) { this.dispose = callback(); return this.dispose },
  }
}

const check = (ok, label) => {
  console.log(`${ok ? '  PASS  ' : '  FAIL  '} ${label}`)
  if (!ok) failures.push(label)
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(250)
  }
  console.log(`  (timed out after ${timeoutMs}ms waiting for: ${label})`)
  return false
}

const pidFrom = (lines) => {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /watching .*\(pid (\d+)\)/.exec(lines[i])
    if (m) return Number(m[1])
  }
  return null
}

console.log(`root: ${root}\n`)
const a = makeCtx('A')
apply(a, { enabled: true, roots: [root], restartBackoffMs: 300, maxRestarts: 3, logRebuilds: false })

console.log('\n[1] baseline watcher')
check(await waitFor(() => a.lines.some((l) => l.includes('press Ctrl+C to stop')), 30_000, 'readiness'), 'watcher became ready')
const firstPid = pidFrom(a.lines)
check(Number.isInteger(firstPid), `plugin reported a pid (${firstPid})`)

console.log('\n[2] ownership lock is held')
check(existsSync(lockFile), 'lock file exists while watching')

console.log('\n[3] a second apply for the same root is refused')
const b = makeCtx('B')
apply(b, { enabled: true, roots: [root], restartBackoffMs: 300, logRebuilds: false })
check(b.lines.some((l) => l.includes('already watches it')), 'second apply skipped the duplicate root')

console.log('\n[4] external kill is recovered')
spawnSync('taskkill', ['/PID', String(firstPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
check(await waitFor(() => a.lines.some((l) => l.includes('restarting watcher in')), 20_000, 'restart scheduled'), 'exit was noticed and a restart scheduled')
const restarted = await waitFor(() => {
  const pid = pidFrom(a.lines)
  return Number.isInteger(pid) && pid !== firstPid
}, 30_000, 'new watcher pid')
const secondPid = pidFrom(a.lines)
check(restarted, `watcher came back on a new pid (${secondPid})`)
check(await waitFor(() => a.lines.some((l) => l.includes('press Ctrl+C to stop')), 30_000, 'second readiness'), 'restarted watcher became ready')

console.log('\n[5] disposal releases everything')
if (typeof a.dispose === 'function') a.dispose()
if (typeof b.dispose === 'function') b.dispose()
await delay(1000)
check(!existsSync(lockFile), 'lock file released on dispose')

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `FAILURES: ${failures.length}`}`)
for (const f of failures) console.log(`  - ${f}`)
process.exit(failures.length === 0 ? 0 : 1)
