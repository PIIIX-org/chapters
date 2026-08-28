import { fileURLToPath } from 'node:url'

const env = process.env

export const config = {
  nodeEnv: env.NODE_ENV ?? 'development',
  isProd: env.NODE_ENV === 'production',
  port: Number(env.PORT ?? 3000),
  /**
   * Built client to serve from this process (`/collab` and `/api/*` excluded).
   * Absolute by default so it resolves the same however the process is
   * started; missing directory = API only, exactly as before.
   */
  clientDist:
    env.CLIENT_DIST ?? fileURLToPath(new URL('../../client/dist', import.meta.url)),
  databaseUrl:
    env.DATABASE_URL ?? 'postgres://chapters:chapters@localhost:5432/chapters',
  /** Root directory for vault note files (OKF markdown on disk). */
  dataDir: env.DATA_DIR ?? './data',
  /** Optional pre-set one-time setup token; generated+logged if absent. */
  setupToken: env.SETUP_TOKEN,
  /**
   * 32-byte (64 hex char) key for encrypting repository credentials/webhook
   * secrets at rest. Optional — only required when a private git repo or a
   * webhook secret is actually configured; unset otherwise.
   */
  credentialsEncryptionKey: env.CREDENTIALS_ENCRYPTION_KEY,
  /** Repositories using the local_path ingestion method must resolve under this root. */
  localReposRoot: env.LOCAL_REPOS_ROOT ?? './data/local-repos',
  pollIntervalMs: Number(env.POLL_INTERVAL_MS ?? 5 * 60 * 1000),
  webhookStaleThresholdMs: Number(env.WEBHOOK_STALE_THRESHOLD_MS ?? 10 * 60 * 1000),
  /** 'local' = ONNX bge-small on CPU; 'fake' = deterministic test embedder. */
  embeddings: env.EMBEDDINGS ?? (env.NODE_ENV === 'production' ? 'local' : 'fake'),
  semanticThreshold: Number(env.SEMANTIC_THRESHOLD ?? 0.75),
  semanticK: Number(env.SEMANTIC_K ?? 8),
  smtp: env.SMTP_HOST
    ? {
        host: env.SMTP_HOST,
        port: Number(env.SMTP_PORT ?? 587),
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
        from: env.SMTP_FROM ?? 'chapters@localhost',
      }
    : null,
  /** Comma-separated allowed cross-origin callers; unset = same-origin only. */
  corsOrigins: env.CORS_ORIGIN ? env.CORS_ORIGIN.split(',').map((o) => o.trim()) : [],
}
