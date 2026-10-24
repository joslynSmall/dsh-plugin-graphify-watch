import { acquireLock, markWatcher, releaseLock } from '../../src/ownership.js'
let lock
process.on('message', message => {
  if (message === 'claim') {
    lock = acquireLock(process.argv[2])
    process.send({ type: 'claimed', result: lock })
  } else if (message === 'active') {
    markWatcher(lock, true)
    process.send({ type: 'active' })
  } else if (message === 'release') {
    if (lock?.ok) releaseLock(lock)
    process.disconnect()
  }
})
process.send({ type: 'ready' })
