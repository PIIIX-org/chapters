import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://chapters:chapters@localhost:5432/chapters_test'

export default defineConfig({
  test: {
    globalSetup: './test/global-setup.ts',
    fileParallelism: false,
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      NODE_ENV: 'test',
      DATA_DIR: join(tmpdir(), 'chapters-test-data'),
      // Fake embedder's bag-of-words vectors need a looser edge threshold.
      SEMANTIC_THRESHOLD: '0.2',
      COLLAB_DEBOUNCE_MS: '150',
      CREDENTIALS_ENCRYPTION_KEY: '0'.repeat(63) + '1',
    },
  },
})
