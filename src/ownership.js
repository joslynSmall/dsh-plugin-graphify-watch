/** Canonical directory identity and cross-process ownership. No watcher logic. */
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const LOCK_DIR = join(tmpdir(), 'dsh-graphify-watch')
const OWNER = /^owner-(\d+)-[a-f0-9-]+$/

export function canonicalRoot(root) {
  return realpathSync.native(resolve(root))
}

export function lockPathFor(root) {
  return join(LOCK_DIR, `${createHash('sha1').update(root).digest('hex')}.lock`)
}

export function processAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

/**
 * Publish a NONEMPTY owner directory atomically. Competing renames cannot replace
 * it. The unique owner filename also makes dead-owner cleanup safe: a delayed
 * reclaimer cannot unlink a replacement owner's marker, and rmdir never removes
 * a nonempty replacement directory. Never recursively remove a published lock.
 */
export function acquireLock(root) {
  const file = lockPathFor(root)
  const ownerFile = `owner-${process.pid}-${randomUUID()}`
  let candidate
  let claimed = false
  try {
    mkdirSync(LOCK_DIR, { recursive: true })
    candidate = mkdtempSync(`${file}.claim-`)
    writeFileSync(join(candidate, ownerFile), 'idle  ', { flag: 'wx' })
    for (let attempt = 0; attempt < 3; attempt++) {
      // Windows can rename a directory OVER a regular file. Inspect legacy
      // file locks before publication, not only after a failed rename.
      if (existsSync(file) && !statSync(file).isDirectory()) {
        const owner = Number(readFileSync(file, 'utf8').trim())
        if (Number.isSafeInteger(owner) && owner > 0 && processAlive(owner)) {
          return { ok: false, owner }
        }
        return { ok: false, error: 'legacy lock found; remove it only after its old watcher has stopped' }
      }
      try {
        renameSync(candidate, file)
        claimed = true
        return { ok: true, file, ownerFile }
      } catch (error) {
        // Windows reports EPERM/EACCES for an existing directory. Inspect it
        // rather than treating that as permission to run without ownership.
        if (!existsSync(file)) throw error
      }
      const entries = readdirSync(file)
      if (entries.length === 0) {
        try { rmdirSync(file) } catch (error) {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error
        }
        continue
      }
      const match = entries.length === 1 && OWNER.exec(entries[0])
      if (!match) return { ok: false, error: 'unrecognized ownership lock; refusing to overwrite it' }
      const owner = Number(match[1])
      if (!Number.isSafeInteger(owner) || owner <= 0) {
        return { ok: false, error: 'invalid lock owner; refusing to overwrite it' }
      }
      if (processAlive(owner)) return { ok: false, owner }
      let activity
      try { activity = readFileSync(join(file, entries[0]), 'utf8').trim() } catch (error) {
        if (error.code === 'ENOENT') continue
        throw error
      }
      if (activity !== 'idle') {
        return { ok: false, error: 'previous supervisor died with an unconfirmed watcher; verify its process tree before clearing this lock' }
      }
      // This exact dead owner's leaf may already be gone. A replacement owner
      // has a different leaf and remains protected by nonempty-directory rename.
      try { unlinkSync(join(file, entries[0])) } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      try { rmdirSync(file) } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error
      }
    }
    return { ok: false, error: 'ownership changed during acquisition; retry by reloading the plugin' }
  } catch (error) {
    return { ok: false, error: `could not acquire ownership: ${error.message}` }
  } finally {
    // Only the private staging directory returned by mkdtemp is recursive-cleaned.
    if (candidate && !claimed) {
      try { rmSync(candidate, { recursive: true, force: true }) } catch { /* no published lock is affected */ }
    }
  }
}

export function markWatcher(lock, active) {
  // Fixed-width records avoid a truncate/write gap; partial or malformed records
  // are refused during crash recovery. r+ cannot recreate a missing owner leaf.
  writeFileSync(join(lock.file, lock.ownerFile), active ? 'active' : 'idle  ', { flag: 'r+' })
}

export function releaseLock(lock) {
  try {
    unlinkSync(join(lock.file, lock.ownerFile))
  } catch (error) {
    if (error.code !== 'ENOENT') return false
  }
  try {
    rmdirSync(lock.file)
    return true
  } catch (error) {
    // Another owner may already have replaced the now-empty directory.
    return ['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)
  }
}
