// A real HTTP process for the Git crash boundary; no job/model worker loop.
import { buildApp } from '../../src/app.js'
import { sql } from '../../src/db/client.js'
import { GIT_QUOTAS } from '../../src/git-remote/metadata.js'
import { sweepVaultRemotes } from '../../src/git-remote/vault-remote.js'

await sweepVaultRemotes()
const app = await buildApp()
await app.listen({ port: 0, host: '127.0.0.1' })
const address = app.server.address()
if (!address || typeof address === 'string') throw new Error('missing private child listener')
process.send?.({ type: 'ready', port: address.port })
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await app.close()
  await sql.end()
  process.disconnect?.()
}
process.on('message', message => {
  if (!message || typeof message !== 'object' || !('type' in message)) return
  if (message.type === 'stop') void stop()
  if (message.type === 'quota' && 'snapshots' in message && typeof message.snapshots === 'number' && Number.isSafeInteger(message.snapshots) && message.snapshots > 0) {
    GIT_QUOTAS.snapshots = message.snapshots
    process.send?.({ type: 'quota-set' })
  }
})
process.once('SIGTERM', () => { void stop() })
