/**
 * dsh-plugin-graphify-watch
 *
 * Keeps one `graphify watch` process alive per configured root, so a code change
 * — made by a DSH file tool, an external editor, a shell command or a git
 * operation — rebuilds `graphify-out/graph.json` without the agent having to
 * remember to start a watcher.
 *
 * Why supervise instead of detecting: `graphify watch` already owns the whole
 * decision surface (extension filter, `.graphifyignore`, skipping dot
 * directories and `graphify-out/`, batch debounce, the code-vs-doc split,
 * deletion eviction, and the `needs_update` flag). Watching the real filesystem
 * is also the only way to see changes DSH did not make itself: the harness
 * `workspace/changes` signal is derived from git snapshots plus file-tool
 * captures, so a shell-only edit is invisible to it.
 *
 * Four properties hold the design together:
 *  - The plugin never throws into the loader; every failure path is a log line.
 *  - A root is owned by one process at a time, enforced by a lock file, so two
 *    DSH windows cannot rebuild the same graph concurrently.
 *  - Nothing is spawned unless the root already holds a `graphify-out/graph.json`,
 *    so an un-indexed folder is skipped rather than silently indexed.
 *  - Teardown kills the whole process tree: `graphify.exe` is a launcher, so a
 *    plain kill would orphan the Python process it started.
 *
 * No dependencies, no build step. `@deepseek-ai/schemastery` is deliberately not
 * used, so the plugin declares no peer range and cannot be blocked by DSH's
 * version-compatibility gate; options are validated by hand below.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import process from 'node:process'

/** Cordis display name for this plugin's fiber. */
export const name = 'graphify-watch'

/**
 * No service is injected on purpose: the plugin uses Node's `child_process`
 * directly, so it mounts unconditionally instead of staying pending until a
 * service it does not truly need happens to exist.
 */
export const inject = []

const TAG = '[graphify-watch]'
const LOCK_DIR = join(tmpdir(), 'dsh-graphify-watch')
/**
 * Roots this process already watches. The lock file fences other processes; this
 * fences the same process, where two rows (or two applies) would otherwise both
 * claim the same root and race on graph.json.
 */
const ACTIVE_ROOTS = new Set()
const DEFAULT_MAX_RESTARTS = 3
const DEFAULT_BACKOFF_MS = 2000
const MAX_BACKOFF_MS = 60_000
const KILL_GRACE_MS = 3000

/**
 * Validate and default the row config. Deliberately tolerant: a typo in the
 * profile patch must degrade to a default and a log line, never to a failed
 * mount.
 */
function resolveOptions(raw) {
  const o = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: o.enabled !== false,
    roots: Array.isArray(o.roots)
      ? o.roots.filter((r) => typeof r === 'string' && r.trim() !== '').map((r) => r.trim())
      : [],
    exePath: typeof o.exePath === 'string' ? o.exePath.trim() : '',
    maxRestarts: Math.trunc(clampNumber(o.maxRestarts, DEFAULT_MAX_RESTARTS, 0, 1000)),
    restartBackoffMs: Math.trunc(clampNumber(o.restartBackoffMs, DEFAULT_BACKOFF_MS, 200, MAX_BACKOFF_MS)),
    logRebuilds: o.logRebuilds !== false,
  }
}

function clampNumber(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number.parseFloat(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve the `graphify` launcher: an explicit path wins, otherwise PATH is
 * searched. Directory entries are rejected — `graphify` would otherwise match a
 * folder of that name and spawn would fail at call time instead of here.
 */
function resolveExecutable(configured) {
  const isFile = (p) => {
    try { return statSync(p).isFile() } catch { return false }
  }
  if (configured) return isFile(configured) ? configured : null

  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : ['']
  const dirs = String(process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = join(dir, `graphify${extension}`)
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

function lockPathFor(root) {
  return join(LOCK_DIR, `${createHash('sha1').update(root).digest('hex')}.lock`)
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the pid exists but belongs to someone else.
    return error?.code === 'EPERM'
  }
}

/**
 * Claim a root for this process. Returns false when a live foreign process
 * already owns it, which is what stops two DSH windows from both rebuilding the
 * same graph — graphify writes atomically but holds no cross-process lock, and
 * its shrink guard would reject the loser's write.
 */
function acquireLock(root) {
  try { mkdirSync(LOCK_DIR, { recursive: true }) } catch { return { file: null, ok: true } }
  const file = lockPathFor(root)
  try {
    const owner = Number.parseInt(readFileSync(file, 'utf8').trim(), 10)
    if (Number.isInteger(owner) && owner > 0 && owner !== process.pid && processAlive(owner)) {
      return { file, ok: false, owner }
    }
  } catch { /* absent or unreadable: the lock is ours to take */ }
  try { writeFileSync(file, String(process.pid), 'utf8') } catch { return { file: null, ok: true } }
  return { file, ok: true }
}

function releaseLock(file) {
  if (!file) return
  try {
    if (readFileSync(file, 'utf8').trim() === String(process.pid)) rmSync(file, { force: true })
  } catch { /* already gone */ }
}

/**
 * Kill a process and its children. `graphify.exe` from `uv tool install` is a
 * launcher that starts the venv Python as a child, so killing only the launcher
 * would leave the real watcher running.
 */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const pid = child.pid
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      return
    } catch { /* fall through to the portable path */ }
  }
  try { child.kill('SIGTERM') } catch { /* already gone */ }
  const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, KILL_GRACE_MS)
  timer.unref?.()
}

export function apply(ctx, rawConfig) {
  const options = resolveOptions(rawConfig)
  const log = (level, message) => {
    const logger = ctx?.logger
    if (logger && typeof logger[level] === 'function') logger[level](`${TAG} ${message}`)
  }

  if (!options.enabled) {
    log('info', 'disabled by config; no watcher started')
    return
  }

  const executable = resolveExecutable(options.exePath)
  if (!executable) {
    log('warn', 'graphify executable not found; set "exePath" in this row\'s config if it is installed outside PATH')
    return
  }

  const roots = options.roots.length > 0
    ? options.roots
    : (existsSync(join(process.cwd(), 'graphify-out', 'graph.json')) ? [process.cwd()] : [])
  if (roots.length === 0) {
    log('warn', 'no root configured and the host working directory is not indexed; set "roots" to absolute project paths in the profile cordis.patch.yml')
    return
  }

  /** @type {Map<string, {child: any, restarts: number, timer: any, stopping: boolean, lock: string|null}>} */
  const supervised = new Map()
  let disposed = false

  const emit = (root, state, chunk, isError) => {
    const text = String(chunk).trimEnd()
    if (text === '') return
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      if (!state.ready && /press Ctrl\+C to stop/i.test(trimmed)) {
        // The banner is the only readiness signal the watcher emits, and an edit
        // made before the observer is up is missed outright — so report it even
        // when rebuild chatter is off. Otherwise a spawn line would be the only
        // evidence and a too-early edit would look like a broken plugin.
        state.ready = true
        log('info', `${root}: ${trimmed}`)
      } else if (/needs_update|non-code files changed|requires LLM/i.test(trimmed)) {
        log('info', `${root}: ${trimmed} — run /graphify --update to refresh the document layer`)
      } else if (options.logRebuilds || isError) {
        log(isError ? 'warn' : 'info', `${root}: ${trimmed}`)
      }
    }
  }

  const scheduleRestart = (root, state) => {
    if (disposed || state.stopping) return
    if (state.restarts >= options.maxRestarts) {
      log('warn', `${root}: giving up after ${state.restarts} restart(s); fix the cause and reload the plugin`)
      return
    }
    state.restarts += 1
    const delay = Math.min(MAX_BACKOFF_MS, options.restartBackoffMs * 2 ** (state.restarts - 1))
    log('info', `${root}: restarting watcher in ${delay}ms (attempt ${state.restarts}/${options.maxRestarts})`)
    state.timer = setTimeout(() => { state.timer = null; spawnWatcher(root, state) }, delay)
    state.timer.unref?.()
  }

  const spawnWatcher = (root, state) => {
    if (disposed || state.stopping) return
    // `graphify watch` accepts no flags — `--debounce` exists only on the module
    // entry point (`python -m graphify.watch`), so the watcher's own 3-second
    // debounce applies here. Unbuffered UTF-8 output matters: Python block-buffers
    // a piped stdout, which would otherwise hide every rebuild line until exit,
    // and its default console encoding mangles non-ASCII warnings.
    const args = ['watch', root]
    let child
    try {
      child = spawn(executable, args, {
        cwd: root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      })
    } catch (error) {
      log('warn', `${root}: could not start watcher: ${errorText(error)}`)
      scheduleRestart(root, state)
      return
    }
    state.child = child
    state.ready = false
    log('info', `watching ${root} (pid ${child.pid})`)

    child.stdout?.on('data', (chunk) => emit(root, state, chunk, false))
    child.stderr?.on('data', (chunk) => emit(root, state, chunk, true))
    child.on('error', (error) => log('warn', `${root}: watcher error: ${errorText(error)}`))
    child.on('exit', (code, signal) => {
      state.child = null
      if (disposed || state.stopping) return
      const how = signal ? `signal ${signal}` : `code ${code ?? 'null'}`
      log('warn', `${root}: watcher exited (${how})`)
      scheduleRestart(root, state)
    })
  }

  const startRoot = (root) => {
    const problem = describeRootProblem(root)
    if (problem) {
      log('info', `${root}: skipped — ${problem}`)
      return
    }
    if (ACTIVE_ROOTS.has(root)) {
      log('info', `${root}: skipped — this process already watches it`)
      return
    }
    const lock = acquireLock(root)
    if (!lock.ok) {
      log('info', `${root}: skipped — already watched by process ${lock.owner}`)
      return
    }
    const state = { child: null, restarts: 0, timer: null, stopping: false, lock: lock.file }
    ACTIVE_ROOTS.add(root)
    supervised.set(root, state)
    spawnWatcher(root, state)
  }

  const stopAll = () => {
    for (const [root, state] of supervised) {
      state.stopping = true
      if (state.timer) { clearTimeout(state.timer); state.timer = null }
      if (state.child) {
        log('info', `${root}: stopping watcher (pid ${state.child.pid})`)
        killTree(state.child)
        state.child = null
      }
      releaseLock(state.lock)
      ACTIVE_ROOTS.delete(root)
    }
    supervised.clear()
  }

  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => {
      for (const root of roots) {
        try { startRoot(root) } catch (error) { log('warn', `${root}: ${errorText(error)}`) }
      }
      return () => { disposed = true; stopAll() }
    }, 'graphify-watch.supervise')
  } else {
    // No lifecycle service: start anyway, but the watchers then outlive an unload.
    log('warn', 'ctx.effect is unavailable; watchers cannot be torn down on unload')
    for (const root of roots) {
      try { startRoot(root) } catch (error) { log('warn', `${root}: ${errorText(error)}`) }
    }
  }
}

/** A human-readable reason to skip a root, or null when it is watchable. */
function describeRootProblem(root) {
  try {
    if (!statSync(root).isDirectory()) return 'not a directory'
  } catch {
    return 'does not exist'
  }
  if (!existsSync(join(root, 'graphify-out', 'graph.json'))) {
    return 'no graphify-out/graph.json yet — run /graphify here first'
  }
  return null
}
