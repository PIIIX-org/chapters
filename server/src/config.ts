const env = process.env

export const config = {
  nodeEnv: env.NODE_ENV ?? 'development',
  isProd: env.NODE_ENV === 'production',
  port: Number(env.PORT ?? 3000),
  /** Yjs sync relay port (same process, own listener). */
  collabPort: Number(env.COLLAB_PORT ?? 3001),
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
}
