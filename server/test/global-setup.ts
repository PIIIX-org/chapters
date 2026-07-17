import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'

const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ??
  'postgres://chapters:chapters@localhost:5432/chapters'
const TEST_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://chapters:chapters@localhost:5432/chapters_test'

export default async function setup(): Promise<void> {
  await rm(join(tmpdir(), 'chapters-test-data'), { recursive: true, force: true })
  const admin = postgres(ADMIN_URL, { max: 1 })
  try {
    await admin.unsafe('CREATE DATABASE chapters_test')
  } catch {
    // already exists
  }
  await admin.end()

  const test = postgres(TEST_URL, { max: 1 })
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
