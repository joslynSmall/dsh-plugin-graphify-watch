import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { stopTree, watchCommand } from '../src/process.js'
import { processAlive } from '../src/ownership.js'

test('a pidless attempt still waits for its terminal close event', async () => {
  let close
  const closed = new Promise(resolve => { close = resolve })
  let finished = false
  const stopping = stopTree({ pid: undefined }, closed, () => {}).then(result => { finished = true; return result })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(finished, false)
  close(true)
  assert.equal(await stopping, true)
})

test('Unix descendants can outlive a closed launcher and exit asynchronously after SIGKILL', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  const originalKill = process.kill
  let groupAlive = true
  const signals = []
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  process.kill = (pid, signal) => {
    assert.equal(pid, -12345)
    if (signal === 0) {
      if (!groupAlive) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    } else {
      signals.push(signal)
      if (signal === 'SIGKILL') setImmediate(() => { groupAlive = false })
    }
    return true
  }
  t.after(() => { process.kill = originalKill; Object.defineProperty(process, 'platform', platform) })
  const stopped = await stopTree({ pid: 12345, exitCode: 1, signalCode: null }, Promise.resolve(true), () => {})
  assert.equal(stopped, true)
  assert.equal(groupAlive, false)
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
})

async function jobFixture(t, keepLauncher) {
  const dir = mkdtempSync(join(tmpdir(), 'graphify-job-test-'))
  const pidFile = join(dir, 'grandchild.pid')
  const stopFile = join(dir, 'stop')
  const grandchild = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{if(fs.existsSync(${JSON.stringify(stopFile)}))process.exit(0)},50)`
  const middle = `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore',detached:true});c.unref();const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(pidFile)})){clearInterval(t);process.exit(0)}},20)`
  const launcher = `const {spawn}=require('node:child_process');const b=spawn(process.execPath,['-e',${JSON.stringify(middle)}],{stdio:'ignore'});b.on('exit',()=>{${keepLauncher ? 'setInterval(()=>{},1000)' : 'process.exit(9)'}})`
  writeFileSync(join(dir, 'watch'), launcher)
  const command = watchCommand(process.execPath, dir)
  const runner = spawn(command.executable, command.args, {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  runner.jobBound = command.jobBound
  let stderr = ''
  runner.stderr.on('data', chunk => { stderr += chunk })
  runner.stdout.resume()
  const closed = once(runner, 'close').then(() => true)
  t.after(async () => {
    writeFileSync(stopFile, 'stop') // Cooperative cleanup of this fixture only.
    if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL')
    await closed
  })
  const deadline = Date.now() + 25_000
  while (!existsSync(pidFile) && runner.exitCode === null && Date.now() < deadline) await delay(50)
  assert(existsSync(pidFile), `job runner must start the fixture: ${stderr}`)
  return { runner, closed, pid: Number(readFileSync(pidFile, 'utf8')), stderr: () => stderr }
}

test('Windows job exit kills a grandchild after both intermediate ancestors exit', { skip: process.platform !== 'win32', timeout: 35_000 }, async t => {
  const fixture = await jobFixture(t, false)
  await fixture.closed
  assert.equal(fixture.runner.exitCode, 9, fixture.stderr())
  assert.equal(await stopTree(fixture.runner, fixture.closed, () => {}), true)
  const deadline = Date.now() + 3000
  while (processAlive(fixture.pid) && Date.now() < deadline) await delay(50)
  assert.equal(processAlive(fixture.pid), false)
})

test('terminating a Windows runner by handle kills detached descendants in its job', { skip: process.platform !== 'win32', timeout: 35_000 }, async t => {
  const fixture = await jobFixture(t, true)
  assert.equal(processAlive(fixture.pid), true)
  assert.equal(await stopTree(fixture.runner, fixture.closed, () => {}), true, fixture.stderr())
  const deadline = Date.now() + 3000
  while (processAlive(fixture.pid) && Date.now() < deadline) await delay(50)
  assert.equal(processAlive(fixture.pid), false)
})

test('Windows runner preserves UTF-8 stderr, output and exit codes in paths with spaces', { skip: process.platform !== 'win32', timeout: 15_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'graphify-中文 job-'))
  writeFileSync(join(dir, 'watch'), "process.stderr.write('中文警告\\n');process.stdout.write('press Ctrl+C to stop\\n');process.exit(5)")
  const command = watchCommand(process.execPath, dir)
  const runner = spawn(command.executable, command.args, { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  runner.stdout.setEncoding('utf8').on('data', text => { stdout += text })
  runner.stderr.setEncoding('utf8').on('data', text => { stderr += text })
  const closed = once(runner, 'close')
  t.after(async () => { if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL'); await closed })
  await closed
  assert.equal(runner.exitCode, 5, stderr)
  assert.match(stdout, /press Ctrl\+C to stop/)
  assert.match(stderr, /中文警告/)
})

test('an exited Windows child without a job guarantee retains ownership', { skip: process.platform !== 'win32' }, async () => {
  const warnings = []
  assert.equal(await stopTree({ pid: 12345, exitCode: 1, signalCode: null }, Promise.resolve(true), x => warnings.push(x)), false)
  assert.match(warnings[0], /no confirmed Job Object/)
})
