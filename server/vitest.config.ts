import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.ELARA_TEST_DATABASE_URL ??
  process.env.CHAPTERS_TEST_DATABASE_URL ??
  'postgres://elara:elara@localhost:5432/elara_test'

export default defineConfig({
  test: {
    globalSetup: './test/global-setup.ts',
    fileParallelism: false,
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      NODE_ENV: 'test',
      DATA_DIR: process.env.DATA_DIR ?? join(tmpdir(), 'elara-test-data'),
      // Fake embedder's bag-of-words vectors need a looser edge threshold.
      SEMANTIC_THRESHOLD: '0.2',
      COLLAB_DEBOUNCE_MS: '150',
      CREDENTIALS_ENCRYPTION_KEY: '0'.repeat(63) + '1',
    },
  },
})
