/** Child launch, UTF-8 output framing and bounded process-tree teardown. */
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { processAlive } from './ownership.js'

const GRACE_MS = 3000

export function watchCommand(executable, root) {
  if (process.platform !== 'win32') return { executable, args: ['watch', root], jobBound: false }
  return {
    executable: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      fileURLToPath(new URL('./watch-job.ps1', import.meta.url)), '-Executable', executable, '-Root', root],
    jobBound: true,
  }
}

export function readLines(stream, onLine) {
  if (!stream) return
  const decoder = new StringDecoder('utf8')
  let pending = ''
  const consume = text => {
    pending += text
    let end
    while ((end = pending.indexOf('\n')) >= 0) {
      onLine(pending.slice(0, end).replace(/\r$/, ''))
      pending = pending.slice(end + 1)
    }
  }
  stream.on('data', chunk => consume(typeof chunk === 'string' ? chunk : decoder.write(chunk)))
  stream.once('end', () => {
    consume(decoder.end())
    if (pending) onLine(pending)
    pending = ''
  })
}

async function within(promise, ms) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise(resolve => { timer = setTimeout(() => resolve(false), ms) }),
    ])
  } finally { clearTimeout(timer) }
}

/** False means ownership must be retained; never silently orphan a watcher. */
export async function stopTree(child, closed, warn) {
  if (!child?.pid) return await within(closed, GRACE_MS)
  if (process.platform === 'win32') {
    // Only the bundled runner has the kill-on-close guarantee. Its stable Node
    // process handle avoids both PID reuse and missing intermediate ancestors.
    if (!child.jobBound) { warn('process has no confirmed Job Object boundary'); return false }
    if (child.exitCode === null && child.signalCode === null) {
      try {
        if (!child.kill('SIGKILL')) { warn('could not terminate job runner'); return false }
      } catch (error) { warn(`could not terminate job runner: ${error.message}`); return false }
    }
    return await within(closed, GRACE_MS)
  }

  // The process group outlives its launcher. Check and signal it even when the
  // direct child's exitCode is already set and its output pipes have closed.
  const signalGroup = signal => {
    try { process.kill(-child.pid, signal); return true } catch (error) {
      if (error.code === 'ESRCH') return true
      warn(`could not terminate process group: ${error.message}`)
      return false
    }
  }
  if (!signalGroup('SIGTERM')) return false
  const ended = await within(closed, GRACE_MS)
  if (!ended || processAlive(-child.pid)) {
    if (!signalGroup('SIGKILL')) return false
    if (!await within(closed, GRACE_MS)) return false
  }
  const deadline = Date.now() + GRACE_MS
  while (processAlive(-child.pid)) {
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return true
}
