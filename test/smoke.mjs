/**
 * Standalone smoke test. Requires a disposable, already indexed scratch project
 * containing src/store.py and README.md; it appends unique probes to both files
 * and removes any old graphify-out/needs_update flag.
 *
 *   node test/smoke.mjs <root>
 *
 * Verifies fresh readiness, a real added graph node, a fresh document event with
 * an unchanged graph across debounce cycles, and awaited process-tree teardown.
 * Any failed assertion exits nonzero; no DSH host is needed.
 */
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, unlinkSync } from 'node:fs'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { apply, inject, name } from '../src/index.js'
import {
  DEBOUNCE_MS, WatcherProcesses, appendProbe, check, makeCtx, scratchProject,
  snapshotGraph, waitFor, waitForProbe, waitForReady,
} from './helpers.mjs'

const { root, graphPath, flagPath, codeFile, docFile } = scratchProject('smoke.mjs')
const processes = new WatcherProcesses()
const ctx = makeCtx('smoke', processes)
const failures = []
const fail = error => { failures.push(error.message); console.error(`  FAIL   ${error.stack || error}`) }

console.log(`plugin: ${name}  inject=[${inject.join(', ')}]`)
try {
  apply(ctx, { enabled: true, roots: [root], logRebuilds: true })
  check(typeof ctx.dispose === 'function', 'ctx.effect captured a disposer')

  console.log('\n[1] watcher starts')
  const watcher = await waitForReady(ctx.lines)
  processes.capture(watcher.pid)
  check(true, `launcher ${watcher.pid} exists and its watcher reported readiness`)

  console.log('\n[2] code change adds a graph symbol')
  const beforeCode = snapshotGraph(graphPath)
  const codeCursor = ctx.lines.length
  const symbol = appendProbe(codeFile, 'smoke_test')
  await waitForProbe(graphPath, beforeCode, symbol, ctx.lines, codeCursor)
  check(true, `graph.json contains the new symbol node ${symbol}, with changed content and mtime`)

  // Let any remaining code-event batch drain before establishing the doc baseline.
  await delay(DEBOUNCE_MS + 1000)
  const beforeDoc = snapshotGraph(graphPath)
  console.log('\n[3] a fresh document event flags without rebuilding')
  if (existsSync(flagPath)) unlinkSync(flagPath)
  check(!existsSync(flagPath), 'old scratch needs_update flag is absent before the edit')
  const docCursor = ctx.lines.length
  appendFileSync(docFile, `\nSmoke document event: ${symbol}.\n`, 'utf8')
  await waitFor(() => {
    const fresh = ctx.lines.slice(docCursor)
    const event = fresh.findIndex(line => /\d+ file\(s\) changed/i.test(line))
    const notice = fresh.findIndex((line, index) => index > event && /non-code files changed/i.test(line))
    const completed = fresh.findIndex((line, index) => index > notice && /Flag written to .*needs_update/i.test(line))
    return event >= 0 && notice > event && completed > notice && existsSync(flagPath)
  }, 30_000, 'this document event, non-code notification, and completed fresh flag write')
  check(true, 'this document edit produced a new needs_update flag and completion log')

  // Observe more than two full 3-second debounce periods after completion. Check
  // throughout the interval so a delayed graph rewrite cannot pass accidentally.
  const deadline = Date.now() + 2 * DEBOUNCE_MS + 1000
  do {
    const current = snapshotGraph(graphPath)
    assert.equal(current.mtimeMs, beforeDoc.mtimeMs, 'document edit must preserve graph.json mtime')
    assert(current.content.equals(beforeDoc.content), 'document edit must preserve graph.json bytes')
    await delay(500)
  } while (Date.now() < deadline)
  const afterDoc = snapshotGraph(graphPath)
  check(afterDoc.mtimeMs === beforeDoc.mtimeMs && afterDoc.content.equals(beforeDoc.content),
    'graph.json content and mtime stayed unchanged across document debounce cycles')
} catch (error) {
  fail(error)
} finally {
  console.log('\n[4] awaited disposal removes the observed process tree')
  // Capture again before stopping, including descendants created after readiness.
  try { if (processes.pids.size) processes.capture() } catch (error) { fail(error) }
  try {
    check(typeof ctx.dispose === 'function', 'disposer is available for teardown')
    await ctx.dispose()
  } catch (error) { fail(error) }
  try { await processes.assertGone() } catch (error) { fail(error) }
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `FAILURES: ${failures.length}`}`)
for (const failure of failures) console.error(`  - ${failure}`)
// A failed teardown must report failure even if an orphan still holds a pipe.
if (failures.length) process.exit(1)
