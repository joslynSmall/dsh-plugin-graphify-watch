/**
 * Supervise one graphify watcher per indexed directory. Graphify continues to
 * own change detection, filtering, debounce and code/document update decisions.
 * This plugin owns directory identity, ownership and the child lifecycle only.
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { acquireLock, canonicalRoot, markWatcher, releaseLock } from './ownership.js'
import { readLines, stopTree, watchCommand } from './process.js'

export const name = 'graphify-watch'
export const inject = []

const TAG = '[graphify-watch]'
// Map values are the same state objects held by each plugin instance. Retaining
// them while stopping also lets a new instance wait for an in-flight teardown.
const ACTIVE_ROOTS = new Map()
const MAX_BACKOFF_MS = 60_000
const STABLE_RUN_MS = 60_000

function clampNumber(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number.parseFloat(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

function resolveOptions(raw) {
  const o = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: o.enabled !== false,
    roots: Array.isArray(o.roots)
      ? o.roots.filter(r => typeof r === 'string' && r.trim() !== '').map(r => r.trim()) : [],
    exePath: typeof o.exePath === 'string' ? o.exePath.trim() : '',
    maxRestarts: Math.trunc(clampNumber(o.maxRestarts, 3, 0, 1000)),
    restartBackoffMs: Math.trunc(clampNumber(o.restartBackoffMs, 2000, 200, MAX_BACKOFF_MS)),
    logRebuilds: o.logRebuilds !== false,
  }
}

function resolveExecutable(configured) {
  const isFile = p => { try { return statSync(p).isFile() } catch { return false } }
  if (configured) return isFile(configured) ? resolve(configured) : null
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : ['']
  for (const dir of String(process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = resolve(dir, `graphify${extension}`)
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

function describeRootProblem(root) {
  try {
    if (!statSync(root).isDirectory()) return 'not a directory'
  } catch { return 'does not exist' }
  try {
    if (statSync(join(root, 'graphify-out', 'graph.json')).isFile()) return null
  } catch { /* missing graph */ }
  return 'no graphify-out/graph.json yet — run /graphify here first'
}

export function apply(ctx, rawConfig) {
  const options = resolveOptions(rawConfig)
  const log = (level, message) => {
    if (typeof ctx?.logger?.[level] === 'function') ctx.logger[level](`${TAG} ${message}`)
  }
  if (!options.enabled) { log('info', 'disabled by config; no watcher started'); return }
  if (typeof ctx?.effect !== 'function') {
    log('warn', 'ctx.effect is unavailable; no unmanaged watcher will be started')
    return
  }
  const executable = resolveExecutable(options.exePath)
  if (!executable) {
    log('warn', 'graphify executable not found; set "exePath" if it is installed outside PATH')
    return
  }
  const roots = options.roots.length > 0 ? options.roots
    : (existsSync(join(process.cwd(), 'graphify-out', 'graph.json')) ? [process.cwd()] : [])
  if (roots.length === 0) {
    log('warn', 'no root configured and the host working directory is not indexed; set "roots" to project paths')
    return
  }
  const supervised = new Map()
  let disposed = false
  let disposal

  const scheduleRestart = (root, state) => {
    if (disposed || state.status === 'stopping') return
    if (state.restarts >= options.maxRestarts) {
      state.status = 'failed'
      log('warn', `${root}: giving up after ${state.restarts} restart(s); fix the cause and reload the plugin`)
      return
    }
    state.restarts += 1
    state.status = 'backoff'
    const delay = Math.min(MAX_BACKOFF_MS, options.restartBackoffMs * 2 ** (state.restarts - 1))
    log('info', `${root}: restarting watcher in ${delay}ms (attempt ${state.restarts}/${options.maxRestarts})`)
    state.timer = setTimeout(() => { state.timer = null; spawnWatcher(root, state) }, delay)
    state.timer.unref?.()
  }

  const spawnWatcher = (root, state) => {
    if (disposed || state.status === 'stopping') return
    state.status = 'starting'
    try { markWatcher(state.lock, true) } catch (error) {
      state.status = 'failed'
      log('warn', `${root}: could not record watcher ownership: ${error.message}`)
      return
    }
    let child
    try {
      const command = watchCommand(executable, root)
      child = spawn(command.executable, command.args, {
        cwd: root,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      })
      child.jobBound = command.jobBound
    } catch (error) {
      log('warn', `${root}: could not start watcher: ${error.message}`)
      try { markWatcher(state.lock, false) } catch {
        state.status = 'failed'
        log('warn', `${root}: could not reset ownership activity; reload the plugin`)
        return
      }
      scheduleRestart(root, state)
      return
    }
    const attempt = { child, readyAt: null, closed: null, cleanup: null }
    state.attempt = attempt
    attempt.stop = () => {
      attempt.cleanup ??= (async () => {
        let stopped = false
        try {
          stopped = await stopTree(child, attempt.closed, text => log('warn', `${root}: ${text}`))
          if (stopped) markWatcher(state.lock, false)
        } catch (error) {
          log('warn', `${root}: could not confirm watcher cleanup: ${error.message}`)
          stopped = false
        }
        if (!stopped) {
          state.status = 'failed-stop'
          log('warn', `${root}: process tree termination unconfirmed; ownership retained to prevent duplicate watchers`)
        }
        return stopped
      })()
      return attempt.cleanup
    }
    // close is a terminal child event, not proof that descendants have stopped.
    // Retain the attempt until the same tree-cleanup promise used by dispose ends.
    attempt.closed = new Promise(resolveClosed => {
      child.once('close', (code, signal) => {
        resolveClosed(true)
        if (state.attempt !== attempt || disposed || state.status === 'stopping') return
        const stable = attempt.readyAt !== null && Date.now() - attempt.readyAt >= STABLE_RUN_MS
        state.status = 'recovering'
        const how = signal ? `signal ${signal}` : `code ${code ?? 'null'}`
        log('warn', `${root}: watcher exited (${how})`)
        void attempt.stop().then(stopped => {
          if (!stopped) return
          if (state.attempt === attempt) state.attempt = null
          if (disposed || state.status === 'stopping') return
          if (stable) state.restarts = 0
          scheduleRestart(root, state)
        })
      })
    })
    child.on('error', error => log('warn', `${root}: watcher error: ${error.message}`))
    if (child.pid) log('info', `watching ${root} (pid ${child.pid})`)
    const emit = (line, isError) => {
      if (disposed || state.attempt !== attempt) return
      const text = line.trim()
      if (!text) return
      if (attempt.readyAt === null && /press Ctrl\+C to stop/i.test(text)) {
        attempt.readyAt = Date.now()
        state.status = 'running'
        log('info', `${root}: ${text}`)
      } else if (/needs_update|non-code files changed|requires LLM/i.test(text)) {
        log('info', `${root}: ${text} — run /graphify --update to refresh the document layer`)
      } else if (options.logRebuilds || isError) {
        log(isError ? 'warn' : 'info', `${root}: ${text}`)
      }
    }
    readLines(child.stdout, line => emit(line, false))
    readLines(child.stderr, line => emit(line, true))
  }

  const startRoot = rawRoot => {
    if (disposed) return
    let root
    try { root = canonicalRoot(rawRoot) } catch (error) {
      log('warn', `${rawRoot}: skipped — ${error.message}`)
      return
    }
    const problem = describeRootProblem(root)
    if (problem) { log('info', `${root}: skipped — ${problem}`); return }
    const previous = ACTIVE_ROOTS.get(root)
    if (previous) {
      if (previous.status === 'stopping') {
        log('info', `${root}: waiting for previous watcher teardown`)
        void previous.stopPromise.then(stopped => {
          if (stopped) startRoot(root)
          else log('warn', `${root}: previous watcher ownership retained; reload after resolving teardown`)
        })
      } else log('info', `${root}: skipped — this process already watches it`)
      return
    }
    const lock = acquireLock(root)
    if (!lock.ok) {
      log(lock.owner ? 'info' : 'warn', `${root}: skipped — ${lock.owner ? `already watched by process ${lock.owner}` : lock.error}`)
      return
    }
    const state = { status: 'starting', attempt: null, restarts: 0, timer: null, lock, stopPromise: null }
    ACTIVE_ROOTS.set(root, state)
    supervised.set(root, state)
    spawnWatcher(root, state)
  }

  const stopRoot = (root, state) => {
    if (state.stopPromise) return state.stopPromise
    state.status = 'stopping'
    if (state.timer) { clearTimeout(state.timer); state.timer = null }
    state.stopPromise = (async () => {
      const attempt = state.attempt
      if (attempt) {
        log('info', `${root}: stopping watcher (pid ${attempt.child.pid ?? 'not started'})`)
        if (!await attempt.stop()) return false
        if (state.attempt === attempt) state.attempt = null
      }
      if (!releaseLock(state.lock)) {
        state.status = 'failed-stop'
        log('warn', `${root}: could not release ownership lock; ownership retained`)
        return false
      }
      state.status = 'stopped'
      if (ACTIVE_ROOTS.get(root) === state) ACTIVE_ROOTS.delete(root)
      supervised.delete(root)
      return true
    })()
    return state.stopPromise
  }

  ctx.effect(() => {
    for (const root of roots) {
      try { startRoot(root) } catch (error) { log('warn', `${root}: ${error.message}`) }
    }
    return () => {
      disposed = true
      disposal ??= Promise.all([...supervised].map(([root, state]) => stopRoot(root, state)))
      return disposal
    }
  }, 'graphify-watch.supervise')
}
