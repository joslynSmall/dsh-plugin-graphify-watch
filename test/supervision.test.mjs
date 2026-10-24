import assert from 'node:assert/strict'
import { test } from 'node:test'
import cp from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { PassThrough } from 'node:stream'
import { syncBuiltinESMExports } from 'node:module'
import { apply } from '../src/index.js'

const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }

function harness(t) {
  const base = mkdtempSync(join(tmpdir(), 'graphify-supervision-test-'))
  const root = join(base, 'project')
  mkdirSync(join(root, 'graphify-out'), { recursive: true })
  writeFileSync(join(root, 'graphify-out/graph.json'), '{}')
  const original = { spawn: cp.spawn, kill: process.kill, timeout: global.setTimeout, clear: global.clearTimeout, now: Date.now }
  let now = 100_000
  const timers = new Map()
  const watchers = []
  const killers = []
  const contexts = []
  let killMode = 'success'
  let spawnMode = 'success'
  global.setTimeout = (fn, delay) => {
    const id = { unref() {} }
    timers.set(id, { fn, at: now + delay })
    return id
  }
  global.clearTimeout = id => timers.delete(id)
  Date.now = () => now
  function child() {
    const c = new EventEmitter()
    c.pid = 800_000 + watchers.length
    c.exitCode = null
    c.signalCode = null
    c.stdout = new PassThrough()
    c.stderr = new PassThrough()
    c.finish = (code = 1) => {
      c.exitCode = code
      c.emit('exit', code, null)
      c.stdout.end()
      c.stderr.end()
      c.emit('close', code, null)
    }
    c.kill = () => {
      killers.push(c)
      if (killMode === 'error') throw new Error('runner termination denied')
      if (killMode === 'success') queueMicrotask(() => c.finish(0))
      return true
    }
    return c
  }
  cp.spawn = (exe, args, options) => {
    if (spawnMode === 'throw') throw new Error('synchronous spawn failure')
    const c = child()
    c.options = options
    watchers.push(c)
    if (spawnMode === 'error') {
      c.pid = undefined
      queueMicrotask(() => {
        c.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
        c.emit('close', -2, null)
      })
    }
    return c
  }
  process.kill = (pid, signal) => {
    const target = watchers.find(w => w.pid === -pid)
    if (!target) return original.kill(pid, signal)
    if (target.exitCode !== null) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    if (signal !== 0) queueMicrotask(() => target.finish(0))
    return true
  }
  syncBuiltinESMExports()
  function mount(extra = {}) {
    const lines = []
    const ctx = {
      lines,
      logger: { info: x => lines.push(x), warn: x => lines.push(x) },
      effect(fn) { this.dispose = fn(); return this.dispose },
    }
    contexts.push(ctx)
    apply(ctx, { exePath: process.execPath, roots: [root], restartBackoffMs: 200, maxRestarts: 1, logRebuilds: false, ...extra })
    return ctx
  }
  t.after(async () => {
    killMode = 'success'
    for (const ctx of contexts) await ctx.dispose?.()
    cp.spawn = original.spawn
    process.kill = original.kill
    global.setTimeout = original.timeout
    global.clearTimeout = original.clear
    Date.now = original.now
    syncBuiltinESMExports()
  })
  return {
    root, mount, watchers, killers, timers,
    spawn(mode) { spawnMode = mode },
    kill(mode) { killMode = mode },
    async advance(ms) {
      await flush()
      now += ms
      for (const [id, task] of [...timers]) {
        if (task.at <= now) { timers.delete(id); task.fn() }
      }
      await flush()
    },
  }
}

test('canonical directory aliases share one watcher', async t => {
  const h = harness(t)
  h.mount({ roots: [h.root, h.root + sep + '.', h.root + sep] })
  assert.equal(h.watchers.length, 1)
})

test('asynchronous spawn errors consume the retry budget exactly once', async t => {
  const h = harness(t)
  h.spawn('error')
  const ctx = h.mount()
  await flush()
  await h.advance(200)
  assert.equal(h.watchers.length, 2)
  await h.advance(60_000)
  assert.equal(h.watchers.length, 2)
  assert(ctx.lines.some(x => x.includes('giving up after 1')))
})

test('synchronous spawn failures retry and disposal cancels a pending retry', async t => {
  const h = harness(t)
  h.spawn('throw')
  const ctx = h.mount()
  assert.equal(h.timers.size, 1)
  await ctx.dispose()
  await h.advance(60_000)
  assert.equal(h.timers.size, 0)
})

test('split UTF-8 and split readiness lines survive stream chunks', async t => {
  const h = harness(t)
  const ctx = h.mount()
  const child = h.watchers[0]
  const text = Buffer.from('中文项目 - press Ctrl+C to stop\n')
  child.stdout.write(text.subarray(0, 2))
  child.stdout.write(text.subarray(2, text.length - 7))
  child.stdout.write(text.subarray(text.length - 7))
  assert(ctx.lines.some(x => x.includes('中文项目 - press Ctrl+C to stop')))
  assert(!ctx.lines.some(x => x.includes('�')))
})

test('a stable ready watcher resets consecutive failures', async t => {
  const h = harness(t)
  h.mount()
  h.watchers[0].finish()
  await flush()
  await h.advance(200)
  h.watchers[1].stdout.write('press Ctrl+C to stop\n')
  await h.advance(60_000)
  h.watchers[1].finish()
  await flush()
  await h.advance(200)
  assert.equal(h.watchers.length, 3)
})

test('brief readiness does not reset a crash loop budget', async t => {
  const h = harness(t)
  const ctx = h.mount()
  h.watchers[0].stdout.write('press Ctrl+C to stop\n')
  h.watchers[0].finish()
  await flush()
  await h.advance(200)
  h.watchers[1].stdout.write('press Ctrl+C to stop\n')
  h.watchers[1].finish()
  await flush()
  await h.advance(60_000)
  assert.equal(h.watchers.length, 2)
  assert(ctx.lines.some(x => x.includes('giving up')))
})

test('a remount waits for confirmed tree termination', { skip: process.platform !== 'win32' }, async t => {
  const h = harness(t)
  const ctx = h.mount()
  h.kill('pending')
  const stopping = ctx.dispose()
  const next = h.mount()
  assert.equal(h.watchers.length, 1)
  h.watchers[0].finish(0)
  await stopping
  await flush()
  assert.equal(h.watchers.length, 2)
  assert(!next.lines.some(x => x.includes('giving up')))
})

test('job runner termination failures preserve root ownership', { skip: process.platform !== 'win32' }, async t => {
  const h = harness(t)
  const ctx = h.mount()
  h.kill('error')
  await ctx.dispose()
  await flush()
  h.mount()
  assert.equal(h.watchers.length, 1)
  assert(ctx.lines.some(x => /retained|could not stop|could not terminate/i.test(x)))
})

test('disposal during backoff prevents any subsequent spawn', async t => {
  const h = harness(t)
  const ctx = h.mount()
  h.watchers[0].finish()
  await flush()
  await ctx.dispose()
  await h.advance(60_000)
  assert.equal(h.watchers.length, 1)
})

test('a host without lifecycle support starts no unmanaged watcher', async t => {
  const h = harness(t)
  apply({ logger: { warn() {} } }, { exePath: process.execPath, roots: [h.root] })
  assert.equal(h.watchers.length, 0)
})

test('a runner without close times out without releasing ownership', { skip: process.platform !== 'win32' }, async t => {
  const h = harness(t)
  const ctx = h.mount()
  h.kill('pending')
  const stopping = ctx.dispose()
  assert.equal(ctx.dispose(), stopping)
  await h.advance(3000)
  await stopping
  h.mount()
  assert.equal(h.watchers.length, 1)
  assert(ctx.lines.some(x => x.includes('ownership retained')))
})

test('a disposed replacement never starts after the old teardown', { skip: process.platform !== 'win32' }, async t => {
  const h = harness(t)
  const first = h.mount()
  h.kill('pending')
  const stopping = first.dispose()
  const second = h.mount()
  await second.dispose()
  h.watchers[0].finish(0)
  await stopping
  await flush()
  assert.equal(h.watchers.length, 1)
})

test('an exit alone never overlaps a child whose pipes have not closed', async t => {
  const h = harness(t)
  const ctx = h.mount()
  const child = h.watchers[0]
  child.exitCode = 1
  child.emit('exit', 1, null)
  await h.advance(60_000)
  assert.equal(h.watchers.length, 1)
  assert.equal(h.timers.size, 0)
  child.emit('close', 1, null)
  await h.advance(200)
  assert.equal(h.watchers.length, 2)
  await ctx.dispose()
})
