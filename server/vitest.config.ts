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
    setupFiles: ['./test/setup-jobs.ts'],
    fileParallelism: false,
    // Database-bound integration tests on one shared Postgres: vitest's 5 s /
    // 10 s defaults measure the machine's load, not the code (#862). On CI
    // (20 green dev runs) the slowest test without its own timeout took 3.0 s;
    // locally under heavy load (8 busy loops beside other suites, timeouts
    // lifted) every such test finished within 17.2 s. A test or hook that
    // needs more passes its own, larger timeout.
    testTimeout: 30_000,
    hookTimeout: 30_000,
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
