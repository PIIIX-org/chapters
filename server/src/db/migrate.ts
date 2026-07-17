import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { db } from './client.js'

const here = dirname(fileURLToPath(import.meta.url))

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: join(here, '../../drizzle') })
}
