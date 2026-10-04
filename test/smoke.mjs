/**
 * Standalone smoke test for dsh-plugin-graphify-watch.
 *
 * Drives `apply()` with a minimal fake Cordis context — the same shape the
 * loader provides (`ctx.logger`, `ctx.effect`) — so the supervision logic can be
 * exercised without mounting the plugin into a live profile.
 *
 *   node test/smoke.mjs <root>
 *
 * Asserts, in order:
 *   1. the watcher starts and reports the pid
 *   2. editing a code file advances graph.json's mtime
 *   3. editing a doc file leaves graph.json alone and creates `needs_update`
 *   4. disposing through ctx.effect stops the watcher
 *
 * Exit code 0 = all assertions held.
 */

import { appendFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

import { apply, inject, name } from '../src/index.js'

const root = process.argv[2]
if (!root) {
  console.error('usage: node test/smoke.mjs <root>')
  process.exit(2)
}

const graphPath = join(root, 'graphify-out', 'graph.json')
const flagPath = join(root, 'graphify-out', 'needs_update')
const codeFile = join(root, 'src', 'store.py')
const docFile = join(root, 'README.md')

const logged = []
const ctx = {
  logger: {
    info: (m) => { logged.push({ level: 'info', m }); console.log(`  info   ${m}`) },
    warn: (m) => { logged.push({ level: 'warn', m }); console.log(`  warn   ${m}`) },
    error: (m) => { logged.push({ level: 'error', m }); console.log(`  error  ${m}`) },
  },
  effect(callback) {
    this.dispose = callback()
    return this.dispose
  },
}

const mtime = () => statSync(graphPath).mtimeMs
const failures = []
const check = (ok, label) => {
  console.log(`${ok ? '  PASS  ' : '  FAIL  '} ${label}`)
  if (!ok) failures.push(label)
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await delay(500)
  }
  console.log(`  (timed out after ${timeoutMs}ms waiting for: ${label})`)
  return false
}

console.log(`plugin: ${name}  inject=[${inject.join(', ')}]`)
console.log(`root:   ${root}\n`)

const before = mtime()
apply(ctx, { enabled: true, roots: [root], logRebuilds: true })

console.log('\n[1] watcher starts')
check(await waitFor(() => logged.some((l) => l.m.includes('watching ')), 15_000, 'watching log line'), 'watcher reported a pid')
// The plugin's own line only proves the process was spawned. graphify builds its
// ignore patterns and starts the observer afterwards, and an edit made in that
// window is missed outright — so wait for the child's readiness banner.
check(
  await waitFor(() => logged.some((l) => l.m.includes('press Ctrl+C to stop')), 30_000, 'child readiness banner'),
  'child reported it is watching (streamed, unbuffered)',
)

console.log('\n[2] code change rebuilds the graph')
// A comment-only edit is not enough: graphify re-extracts, finds no topology
// change ("No code-graph topology changes detected; outputs left untouched")
// and correctly leaves graph.json alone. Add a symbol so the graph must change.
appendFileSync(codeFile, [
  '',
  'def smoke_test_probe(store):',
  '    # WHY: appended by the smoke test to force a real topology change',
  "    return store.put('probe', '1')",
  '',
].join('\n'), 'utf8')
const rebuilt = await waitFor(() => {
  try { return mtime() !== before } catch { return false }
}, 90_000, 'graph.json mtime change')
check(rebuilt, 'graph.json was rebuilt after a code edit')

console.log('\n[3] doc change flags without rebuilding')
const afterCode = mtime()
const flagBefore = existsSync(flagPath)
appendFileSync(docFile, '\nSmoke test touch.\n', 'utf8')
const flagged = await waitFor(() => existsSync(flagPath), 30_000, 'needs_update flag')
check(flagged, 'needs_update flag was written for a doc edit')
check(mtime() === afterCode, 'graph.json was NOT touched by the doc edit')
if (flagBefore) console.log('  note: needs_update already existed before this run')

console.log('\n[4] disposal stops the watcher')
if (typeof ctx.dispose === 'function') {
  ctx.dispose()
  check(logged.some((l) => l.m.includes('stopping watcher')), 'teardown logged the stop')
} else {
  check(false, 'ctx.effect captured a disposer')
}

await delay(1500)
console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `FAILURES: ${failures.length}`}`)
for (const f of failures) console.log(`  - ${f}`)
process.exit(failures.length === 0 ? 0 : 1)
