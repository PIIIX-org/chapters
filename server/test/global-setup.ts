import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'

const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ??
  process.env.ELARA_ADMIN_DATABASE_URL ??
  process.env.CHAPTERS_ADMIN_DATABASE_URL ??
  'postgres://elara:elara@localhost:5432/elara'
const TEST_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.ELARA_TEST_DATABASE_URL ??
  process.env.CHAPTERS_TEST_DATABASE_URL ??
  'postgres://elara:elara@localhost:5432/elara_test'

export default async function setup(): Promise<void> {
  await rm(join(tmpdir(), 'chapters-test-data'), { recursive: true, force: true })
  await rm(join(tmpdir(), 'elara-test-data'), { recursive: true, force: true })
  if (process.env.SKIP_DB_SETUP === '1' || process.env.SKIP_DB_SETUP?.trim() === '1') {
    return
  }

  let adminUrl = ADMIN_URL
  let testUrl = TEST_URL

  // If explicit admin URL was not supplied, probe elara credentials first, fallback to chapters
  if (!process.env.ADMIN_DATABASE_URL && !process.env.ELARA_ADMIN_DATABASE_URL) {
    try {
      const probe = postgres(adminUrl, { max: 1, connect_timeout: 2 })
      await probe`SELECT 1`
      await probe.end()
    } catch {
      adminUrl = 'postgres://chapters:chapters@localhost:5432/chapters'
      testUrl = 'postgres://chapters:chapters@localhost:5432/chapters_test'
    }
  }

  const parsedTest = new URL(testUrl)
  const testDbName = parsedTest.pathname.replace(/^\//, '') || 'elara_test'

  const admin = postgres(adminUrl, { max: 1 })
  try {
    await admin.unsafe(`CREATE DATABASE "${testDbName}"`)
  } catch {
    // already exists
  }
  await admin.end()

  const test = postgres(testUrl, { max: 1 })
  await test.unsafe('DROP SCHEMA public CASCADE')
  await test.unsafe('CREATE SCHEMA public')
  // Drizzle's migration journal lives in its own schema — reset it too,
  // or migrations are skipped against the freshly dropped public schema.
  await test.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE')
  await test.end()

  process.env.DATABASE_URL = TEST_URL
  const { runMigrations } = await import('../src/db/migrate.js')
  await runMigrations()
  const { sql } = await import('../src/db/client.js')
  await sql.end()
}
