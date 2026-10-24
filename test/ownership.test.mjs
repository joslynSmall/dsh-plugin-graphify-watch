import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { acquireLock, canonicalRoot, lockPathFor, releaseLock } from '../src/ownership.js'

const root = () => fs.mkdtempSync(join(tmpdir(), 'graphify-ownership-test-'))
const nextMessage = child => once(child, 'message').then(([value]) => value)

async function workers(t, project, count) {
  const children = []
  t.after(async () => {
    await Promise.all(children.map(child => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const ended = once(child, 'exit')
      if (child.connected) child.send('release')
      else child.kill()
      return ended
    }))
  })
  for (let i = 0; i < count; i++) {
    const child = fork(new URL('./fixtures/lock-owner.mjs', import.meta.url), [project], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    children.push(child)
    assert.equal((await nextMessage(child)).type, 'ready')
  }
  return children
}

async function compete(children) {
  const pending = children.map(nextMessage)
  for (const child of children) child.send('claim')
  return Promise.all(pending)
}

test('real paths, trailing separators and directory junctions have one identity', () => {
  const project = root()
  const alias = project + '-alias'
  fs.symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(canonicalRoot(project), canonicalRoot(project + '/.'))
  assert.equal(canonicalRoot(project), canonicalRoot(project + '/'))
  assert.equal(canonicalRoot(project), canonicalRoot(alias))
})

test('a live owner cannot be replaced even by the same process', () => {
  const project = root()
  const first = acquireLock(project)
  assert.equal(first.ok, true)
  try {
    const second = acquireLock(project)
    assert.equal(second.ok, false)
    assert.equal(second.owner, process.pid)
    assert(fs.existsSync(join(first.file, first.ownerFile)))
  } finally { releaseLock(first) }
})

test('late release cannot remove a replacement owner', () => {
  const project = root()
  const first = acquireLock(project)
  assert(first.ok)
  assert(releaseLock(first))
  const replacement = acquireLock(project)
  assert(replacement.ok)
  try {
    assert(releaseLock(first))
    assert(fs.existsSync(join(replacement.file, replacement.ownerFile)))
    assert.equal(acquireLock(project).ok, false)
  } finally { releaseLock(replacement) }
})

test('lock IO errors refuse ownership instead of running unlocked', t => {
  const original = fs.mkdirSync
  fs.mkdirSync = () => { throw Object.assign(new Error('access denied'), { code: 'EACCES' }) }
  syncBuiltinESMExports()
  t.after(() => { fs.mkdirSync = original; syncBuiltinESMExports() })
  const result = acquireLock(join(tmpdir(), 'unwritable-lock-test'))
  assert.equal(result.ok, false)
  assert.match(result.error, /access denied/)
})

test('legacy live owners and malformed locks are never overwritten', () => {
  const project = root()
  const file = lockPathFor(project)
  fs.writeFileSync(file, String(process.pid))
  assert.equal(acquireLock(project).owner, process.pid)
  fs.writeFileSync(file, 'not a pid')
  assert.equal(acquireLock(project).ok, false)
  assert.equal(fs.readFileSync(file, 'utf8'), 'not a pid')
  fs.unlinkSync(file)
})

test('eight independent processes claim exactly one watcher owner', async t => {
  const project = root()
  const children = await workers(t, project, 8)
  const results = await compete(children)
  assert.equal(results.filter(x => x.result.ok).length, 1)
})

test('concurrent dead-owner reclaimers cannot evict the winning owner', async t => {
  const project = root()
  const file = lockPathFor(project)
  fs.mkdirSync(file)
  fs.writeFileSync(join(file, `owner-2147483647-${randomUUID()}`), 'idle  ')
  const children = await workers(t, project, 8)
  const results = await compete(children)
  const winners = results.filter(x => x.result.ok)
  assert.equal(winners.length, 1)
  assert(fs.existsSync(join(file, winners[0].result.ownerFile)))
})

test('an owner killed mid-session is safely reclaimed by a new process', async t => {
  const project = root()
  const [child] = await workers(t, project, 1)
  const [result] = await compete([child])
  assert(result.result.ok)
  const ended = once(child, 'exit')
  child.kill('SIGKILL')
  await ended
  const replacement = acquireLock(project)
  assert(replacement.ok)
  assert.notEqual(replacement.ownerFile, result.result.ownerFile)
  releaseLock(replacement)
})

test('a crashed supervisor with an unconfirmed watcher cannot be taken over automatically', async t => {
  const project = root()
  const [child] = await workers(t, project, 1)
  const [result] = await compete([child])
  assert(result.result.ok)
  const active = nextMessage(child)
  child.send('active')
  assert.equal((await active).type, 'active')
  const ended = once(child, 'exit')
  child.kill('SIGKILL')
  await ended
  const replacement = acquireLock(project)
  assert.equal(replacement.ok, false)
  assert.match(replacement.error, /unconfirmed watcher/)
  assert(fs.existsSync(join(result.result.file, result.result.ownerFile)))
})
