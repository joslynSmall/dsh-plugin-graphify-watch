/** Shared helpers for the standalone scratch-project tests; no runtime imports use this file. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { canonicalRoot } from '../src/ownership.js'

export const DEBOUNCE_MS = 3000

export function scratchProject(script) {
  if (!process.argv[2]) {
    console.error(`usage: node test/${script} <root>`)
    console.error('Use a disposable, already indexed scratch project with src/store.py and README.md.')
    process.exit(2)
  }
  const root = canonicalRoot(process.argv[2])
  const paths = {
    root,
    graphPath: join(root, 'graphify-out', 'graph.json'),
    flagPath: join(root, 'graphify-out', 'needs_update'),
    codeFile: join(root, 'src', 'store.py'),
    docFile: join(root, 'README.md'),
  }
  for (const file of [paths.graphPath, paths.codeFile, paths.docFile]) {
    assert(statSync(file).isFile(), `scratch-project fixture must be a file: ${file}`)
  }
  console.log(`scratch root: ${root}`)
  console.log('This test appends unique probes to the scratch project; smoke also clears its old needs_update flag.\n')
  return paths
}

export function makeCtx(tag, processes) {
  const lines = []
  const log = level => message => {
    const line = String(message)
    lines.push(line)
    processes.remember(line)
    console.log(`  ${tag} ${level.padEnd(5)} ${line}`)
  }
  return {
    lines,
    logger: { info: log('info'), warn: log('warn'), error: log('error') },
    effect(callback) { this.dispose = callback(); return this.dispose },
  }
}

export function check(ok, label) {
  assert(ok, label)
  console.log(`  PASS   ${label}`)
}

export async function waitFor(predicate, timeoutMs, label, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  do {
    const result = await predicate()
    if (result) return result
    await delay(intervalMs)
  } while (Date.now() < deadline)
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
}

export function latestWatcher(lines, cursor = 0) {
  for (let index = lines.length - 1; index >= cursor; index--) {
    const match = /\bwatching .*\(pid (\d+)\)/.exec(lines[index])
    if (match) return { pid: Number(match[1]), index }
  }
  return null
}

export async function waitForReady(lines, cursor = 0, previousPid = null) {
  return waitFor(() => {
    const watcher = latestWatcher(lines, cursor)
    return watcher && watcher.pid !== previousPid &&
      lines.slice(watcher.index + 1).some(line => /press Ctrl\+C to stop/i.test(line)) && watcher
  }, 30_000, 'a fresh watcher pid followed by its own readiness banner')
}

export function snapshotGraph(file) {
  const content = readFileSync(file)
  const graph = JSON.parse(content.toString('utf8'))
  assert(Array.isArray(graph.nodes), 'scratch graph.json must contain a nodes array')
  return { content, graph, mtimeMs: statSync(file).mtimeMs }
}

export function appendProbe(codeFile, prefix) {
  const symbol = `${prefix}_probe_${randomUUID().replaceAll('-', '')}`
  appendFileSync(codeFile, [
    '',
    `def ${symbol}(store):`,
    '    # Appended by the standalone test to force a new graph node.',
    `    return store.put('${symbol}', '1')`,
    '',
  ].join('\n'), 'utf8')
  return symbol
}

export async function waitForProbe(graphPath, before, symbol, lines, cursor) {
  const oldIds = new Set(before.graph.nodes.map(node => node.id))
  return waitFor(() => {
    let after
    try { after = snapshotGraph(graphPath) } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return false
      throw error
    }
    // Require a newly identified symbol node, not a mention in graph metadata or
    // a timestamp-only rewrite. The UUID also makes repeated scratch runs valid.
    const added = after.graph.nodes.some(node => !oldIds.has(node.id) &&
      ['label', 'name', 'qualified_name', 'id'].some(key =>
        typeof node[key] === 'string' && new RegExp(`\\b${symbol}\\b`).test(node[key])))
    const completed = lines.slice(cursor).some(line => /graph\.json.*updated in/i.test(line))
    return added && completed && after.mtimeMs !== before.mtimeMs &&
      !after.content.equals(before.content) && after
  }, 90_000, `new graph node ${symbol} and this edit's completed graph update`)
}

function run(executable, args) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${executable} failed: ${result.stderr?.trim() || result.signal || result.status}`)
  return result.stdout.trim().replace(/^\uFEFF/, '')
}

function processTable() {
  if (process.platform === 'win32') {
    const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const output = run(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId) | ConvertTo-Json -Compress"])
    const rows = JSON.parse(output)
    return (Array.isArray(rows) ? rows : [rows]).map(row => ({ pid: Number(row.ProcessId), ppid: Number(row.ParentProcessId) }))
  }
  return run('ps', ['-A', '-o', 'pid=,ppid=']).split(/\r?\n/).filter(Boolean).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    assert(match, `could not parse ps pid/ppid row: ${line}`)
    return { pid: Number(match[1]), ppid: Number(match[2]) }
  })
}

export class WatcherProcesses {
  pids = new Set()

  remember(line) {
    const watcher = latestWatcher([line])
    if (watcher) this.pids.add(watcher.pid)
  }

  capture(launcherPid) {
    const table = processTable()
    // Seeded from actual spawn logs, then expanded with OS parent relationships.
    // Keeping every observation also catches children orphaned by a later crash.
    let changed
    do {
      changed = false
      for (const row of table) {
        if (this.pids.has(row.ppid) && !this.pids.has(row.pid)) {
          this.pids.add(row.pid)
          changed = true
        }
      }
    } while (changed)
    if (launcherPid !== undefined) {
      assert(table.some(row => row.pid === launcherPid), `launcher ${launcherPid} exists in the OS process table`)
      console.log(`  observed watcher pid/ppid: ${table.filter(row => this.pids.has(row.pid)).map(row => `${row.pid}/${row.ppid}`).join(', ')}`)
    }
    return [...this.pids]
  }

  async assertGone(pids = [...this.pids]) {
    let remaining = []
    await waitFor(() => {
      const alive = new Set(processTable().map(row => row.pid))
      remaining = pids.filter(pid => alive.has(pid))
      return remaining.length === 0
    }, 15_000, `observed launcher/descendant PIDs to disappear: ${pids.join(', ')}`, 500)
    check(remaining.length === 0, `all observed watcher PIDs disappeared (${pids.join(', ') || 'none started'})`)
  }
}

export function killWatcherTree(pid) {
  assert(Number.isSafeInteger(pid) && pid > 0, 'external kill needs a real watcher pid')
  if (process.platform === 'win32') {
    run(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'])
  } else {
    // The plugin launches a detached process group on Unix.
    process.kill(-pid, 'SIGKILL')
  }
}
