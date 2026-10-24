/**
 * Standalone resilience checks against a disposable, already indexed scratch
 * project containing src/store.py and README.md. Appends one unique code probe.
 *
 *   node test/resilience.mjs <root>
 *
 * Verifies same-process duplicate refusal, directory ownership, a fresh restart
 * generation that really updates graph topology, and awaited teardown of every
 * observed launcher/descendant. Any failed assertion exits nonzero.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import process from 'node:process'
import { apply } from '../src/index.js'
import { canonicalRoot, lockPathFor } from '../src/ownership.js'
import {
  WatcherProcesses, appendProbe, check, killWatcherTree, latestWatcher, makeCtx,
  scratchProject, snapshotGraph, waitFor, waitForProbe, waitForReady,
} from './helpers.mjs'

const { root, graphPath, codeFile } = scratchProject('resilience.mjs')
const lockPath = lockPathFor(canonicalRoot(root))
const processes = new WatcherProcesses()
const a = makeCtx('A', processes)
const b = makeCtx('B', processes)
const mounted = []
const failures = []
const fail = error => { failures.push(error.message); console.error(`  FAIL   ${error.stack || error}`) }

try {
  mounted.push(a)
  apply(a, { enabled: true, roots: [root], restartBackoffMs: 300, maxRestarts: 3, logRebuilds: true })
  check(typeof a.dispose === 'function', 'first ctx.effect captured a disposer')

  console.log('\n[1] baseline watcher')
  const first = await waitForReady(a.lines)
  processes.capture(first.pid)
  check(true, `initial launcher ${first.pid} exists and its watcher became ready`)

  console.log('\n[2] ownership directory is held')
  check(statSync(lockPath).isDirectory(), 'canonical root lock path is a directory')
  const owners = readdirSync(lockPath)
  check(owners.length === 1 && new RegExp(`^owner-${process.pid}-[a-f0-9-]+$`).test(owners[0]),
    'lock directory contains exactly this process\'s unique owner marker')

  console.log('\n[3] a second apply for the same root is refused')
  mounted.push(b)
  apply(b, { enabled: true, roots: [root], restartBackoffMs: 300, logRebuilds: true })
  check(b.lines.some(line => line.includes('already watches it')), 'second apply skipped the duplicate root')
  check(latestWatcher(b.lines) === null, 'duplicate apply launched no watcher')

  console.log('\n[4] external kill is recovered by a fresh, working generation')
  const firstTree = processes.capture(first.pid)
  // No readiness or restart message preceding this cursor may satisfy recovery.
  const restartCursor = a.lines.length
  killWatcherTree(first.pid)
  await waitFor(() => a.lines.slice(restartCursor).some(line => line.includes('restarting watcher in')),
    20_000, 'a new restart-scheduled log after the external kill')
  const second = await waitForReady(a.lines, restartCursor, first.pid)
  check(second.pid !== first.pid, `new launcher ${second.pid} emitted its own readiness`)
  processes.capture(second.pid)
  await processes.assertGone(firstTree)

  // Readiness alone is insufficient: edit code only after the new generation's
  // own banner, then require a newly identified symbol node and completed write.
  const beforeCode = snapshotGraph(graphPath)
  const codeCursor = a.lines.length
  const symbol = appendProbe(codeFile, 'resilience_test')
  await waitForProbe(graphPath, beforeCode, symbol, a.lines, codeCursor)
  check(latestWatcher(a.lines)?.pid === second.pid, 'the same restarted generation handled the code edit')
  processes.capture(second.pid)
  check(true, `restarted watcher added graph symbol ${symbol}, changing content and mtime`)
} catch (error) {
  fail(error)
} finally {
  console.log('\n[5] awaited disposal releases ownership and all observed PIDs')
  try { if (processes.pids.size) processes.capture() } catch (error) { fail(error) }
  for (const ctx of mounted) {
    try {
      check(typeof ctx.dispose === 'function', 'mounted ctx.effect supplied a disposer')
      await ctx.dispose()
    } catch (error) { fail(error) }
  }
  try { await processes.assertGone() } catch (error) { fail(error) }
  try { check(!existsSync(lockPath), 'ownership directory was released after awaited disposal') } catch (error) { fail(error) }
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `FAILURES: ${failures.length}`}`)
for (const failure of failures) console.error(`  - ${failure}`)
if (failures.length) process.exit(1)
