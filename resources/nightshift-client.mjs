/** Private local capability RPC. Only socket path/token are inherited by Pi, never release credentials or route configs. */
import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
const LIMIT = 64 * 1024
export function callNightHost(capability, kind, input, signal) {
  if (!capability || typeof capability.socketPath !== 'string' || typeof capability.token !== 'string') throw new Error('Host action capability unavailable')
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Host action cancelled')); return }
    const id = randomUUID(), socket = createConnection(capability.socketPath)
    let buffer = '', done = false
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy()
      if (error) reject(error); else resolve(value)
    }
    const abort = () => finish(new Error('Host action interrupted; reconcile outcome'))
    const timer = setTimeout(() => finish(new Error('Host action timeout; reconcile outcome')), 3_650_000)
    signal?.addEventListener('abort', abort, { once: true })
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(JSON.stringify({ id, token: capability.token, kind, input }) + '\n'))
    socket.on('data', chunk => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > LIMIT) { finish(new Error('Host action response exceeds limit')); return }
      const end = buffer.indexOf('\n'); if (end < 0) return
      try {
        const response = JSON.parse(buffer.slice(0, end))
        if (response.id !== id || typeof response.ok !== 'boolean') throw new Error('Invalid host response')
        if (!response.ok) { finish(new Error('Host rejected action request')); return }
        finish(undefined, response.result)
      } catch { finish(new Error('Malformed host action response')) }
    })
    socket.on('error', () => finish(new Error('Host action transport failed; reconcile outcome')))
    socket.on('end', () => { if (!done) finish(new Error('Host action response incomplete; reconcile outcome')) })
  })
}
