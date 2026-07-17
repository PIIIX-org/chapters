import { buildApp } from './app.js'
import { runMigrations } from './db/migrate.js'
import { ensureInstanceState } from './auth/bootstrap.js'
import { config } from './config.js'

const app = await buildApp()

try {
  await runMigrations()
  const { setupPending, setupToken } = await ensureInstanceState()
  if (setupPending && setupToken) {
    // The only place the setup token ever appears in plaintext.
    console.log(`\n=== Chapters one-time setup token: ${setupToken} ===\n`)
  }
  await app.listen({ port: config.port, host: '0.0.0.0' })
  console.log(`Chapters server listening on :${config.port}`)
} catch (err) {
  console.error(err)
  process.exit(1)
}
