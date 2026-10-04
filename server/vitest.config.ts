import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'
import { defineConfig } from 'vitest/config'

export default defineConfig(async () => {
  let testDatabaseUrl =
    process.env.TEST_DATABASE_URL ??
    process.env.ELARA_TEST_DATABASE_URL ??
    process.env.CHAPTERS_TEST_DATABASE_URL

  if (!testDatabaseUrl) {
    try {
      const probe = postgres('postgres://elara:elara@localhost:5432/elara', { max: 1, connect_timeout: 1 })
      await probe`SELECT 1`
      await probe.end()
      testDatabaseUrl = 'postgres://elara:elara@localhost:5432/elara_test'
    } catch {
      testDatabaseUrl = 'postgres://chapters:chapters@localhost:5432/chapters_test'
    }
  }

  return {
    test: {
      globalSetup: './test/global-setup.ts',
      fileParallelism: false,
      env: {
        DATABASE_URL: testDatabaseUrl,
        NODE_ENV: 'test',
        DATA_DIR: process.env.DATA_DIR ?? join(tmpdir(), 'elara-test-data'),
        // Fake embedder's bag-of-words vectors need a looser edge threshold.
        SEMANTIC_THRESHOLD: '0.2',
        COLLAB_DEBOUNCE_MS: '150',
        CREDENTIALS_ENCRYPTION_KEY: '0'.repeat(63) + '1',
      },
    },
  }
})
