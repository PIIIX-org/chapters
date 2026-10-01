import { fileURLToPath } from 'node:url'

const env = process.env

export const config = {
  nodeEnv: env.NODE_ENV ?? 'development',
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: Number(env.PORT ?? 3000),
  /** Base public application URL for external callbacks (OIDC, emails, etc.). */
  appUrl: env.APP_URL ?? env.BASE_URL ?? null,
  /**
   * Built client to serve from this process (`/collab` and `/api/*` excluded).
   * Absolute by default so it resolves the same however the process is
   * started; missing directory = API only, exactly as before.
   */
  clientDist:
    env.CLIENT_DIST ?? fileURLToPath(new URL('../../client/dist', import.meta.url)),
  databaseUrl:
    env.DATABASE_URL ?? 'postgres://chapters:chapters@localhost:5432/chapters',
  databasePoolSize: Number(env.DATABASE_POOL_SIZE ?? (env.NODE_ENV === 'production' ? 25 : 10)),
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
  /**
   * Generic OIDC login — any spec-compliant issuer (Keycloak, Authentik, or
   * the PIIIX control plane; the app cannot tell which and must never learn).
   * A getter, not a snapshot, so tests can point it at a fake issuer whose
   * port is only known after the config module was first imported.
   * OIDC_ONLY=true also disables password login/signup/reset — a posture any
   * self-hoster mandating their IdP wants, not a hosted-edition flag.
   */
  get oidc() {
    if (!env.OIDC_ISSUER) return null
    return {
      issuer: env.OIDC_ISSUER.replace(/\/$/, ''),
      clientId: env.OIDC_CLIENT_ID ?? '',
      clientSecret: env.OIDC_CLIENT_SECRET ?? '',
      only: env.OIDC_ONLY === 'true',
    }
  },
  /** Automated scheduled offsite backup configuration (Issue #260). */
  backup: {
    get localPath() {
      return env.BACKUP_LOCAL_PATH
    },
    get s3Endpoint() {
      return env.BACKUP_S3_ENDPOINT
    },
    get s3Region() {
      return env.BACKUP_S3_REGION ?? 'us-east-1'
    },
    get s3Bucket() {
      return env.BACKUP_S3_BUCKET
    },
    get s3Prefix() {
      return env.BACKUP_S3_PREFIX ?? 'chapters-backups/'
    },
    get s3AccessKeyId() {
      return env.BACKUP_S3_ACCESS_KEY_ID
    },
    get s3SecretAccessKey() {
      return env.BACKUP_S3_SECRET_ACCESS_KEY
    },
    get s3ForcePathStyle() {
      return (
        env.BACKUP_S3_FORCE_PATH_STYLE === 'true' ||
        Boolean(env.BACKUP_S3_ENDPOINT)
      )
    },
    get retentionCount() {
      return Math.max(1, Number(env.BACKUP_RETENTION_COUNT ?? 7))
    },
    get intervalHours() {
      return Number(env.BACKUP_INTERVAL_HOURS ?? 24)
    },
  },
}

