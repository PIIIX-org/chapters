import { fileURLToPath } from 'node:url'

const env = process.env

export const config = {
  nodeEnv: env.NODE_ENV ?? 'development',
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: Number(env.ELARA_PORT ?? env.CHAPTERS_PORT ?? env.PORT ?? 3000),
  /** Base public application URL for external callbacks (OIDC, emails, etc.). */
  appUrl: env.ELARA_APP_URL ?? env.CHAPTERS_APP_URL ?? env.APP_URL ?? env.BASE_URL ?? null,
  /**
   * Built client to serve from this process (`/collab` and `/api/*` excluded).
   * Absolute by default so it resolves the same however the process is
   * started; missing directory = API only, exactly as before.
   */
  clientDist:
    env.ELARA_CLIENT_DIST ??
    env.CHAPTERS_CLIENT_DIST ??
    env.CLIENT_DIST ??
    fileURLToPath(new URL('../../client/dist', import.meta.url)),
  databaseUrl:
    env.ELARA_DATABASE_URL ??
    env.CHAPTERS_DATABASE_URL ??
    env.DATABASE_URL ??
    'postgres://chapters:chapters@localhost:5432/chapters',
  databasePoolSize: Number(
    env.ELARA_DATABASE_POOL_SIZE ??
    env.CHAPTERS_DATABASE_POOL_SIZE ??
    env.DATABASE_POOL_SIZE ??
    (env.NODE_ENV === 'production' ? 25 : 10)
  ),
  /** Root directory for vault note files (OKF markdown on disk). */
  dataDir: env.ELARA_DATA_DIR ?? env.CHAPTERS_DATA_DIR ?? env.DATA_DIR ?? './data',
  /** Optional pre-set one-time setup token; generated+logged if absent. */
  setupToken: env.ELARA_SETUP_TOKEN ?? env.CHAPTERS_SETUP_TOKEN ?? env.SETUP_TOKEN,
  /**
   * 32-byte (64 hex char) key for encrypting repository credentials/webhook
   * secrets at rest. Optional — only required when a private git repo or a
   * webhook secret is actually configured; unset otherwise.
   */
  credentialsEncryptionKey:
    env.ELARA_CREDENTIALS_ENCRYPTION_KEY ??
    env.CHAPTERS_CREDENTIALS_ENCRYPTION_KEY ??
    env.CREDENTIALS_ENCRYPTION_KEY,
  /** Repositories using the local_path ingestion method must resolve under this root. */
  localReposRoot:
    env.ELARA_LOCAL_REPOS_ROOT ??
    env.CHAPTERS_LOCAL_REPOS_ROOT ??
    env.LOCAL_REPOS_ROOT ??
    './data/local-repos',
  pollIntervalMs: Number(env.POLL_INTERVAL_MS ?? 5 * 60 * 1000),
  webhookStaleThresholdMs: Number(env.WEBHOOK_STALE_THRESHOLD_MS ?? 10 * 60 * 1000),
  /** 'local' = ONNX bge-small on CPU; 'fake' = deterministic test embedder. */
  embeddings: env.EMBEDDINGS ?? (env.NODE_ENV === 'production' ? 'local' : 'fake'),
  semanticThreshold: Number(env.SEMANTIC_THRESHOLD ?? 0.75),
  semanticK: Number(env.SEMANTIC_K ?? 8),
  chromaUrl: env.ELARA_CHROMA_URL ?? env.CHROMA_URL ?? 'http://localhost:8000',
  chromaAuthToken: env.ELARA_CHROMA_AUTH_TOKEN ?? env.CHROMA_AUTH_TOKEN,
  chromaPrefix: env.ELARA_CHROMA_PREFIX ?? 'elara',
  vectorStore: (env.VECTOR_STORE ?? (env.NODE_ENV === 'test' ? 'memory' : 'chroma')) as 'chroma' | 'memory',
  smtp: (env.ELARA_SMTP_HOST ?? env.CHAPTERS_SMTP_HOST ?? env.SMTP_HOST)
    ? {
        host: (env.ELARA_SMTP_HOST ?? env.CHAPTERS_SMTP_HOST ?? env.SMTP_HOST)!,
        port: Number(
          env.ELARA_SMTP_PORT ?? env.CHAPTERS_SMTP_PORT ?? env.SMTP_PORT ?? 587
        ),
        user: env.ELARA_SMTP_USER ?? env.CHAPTERS_SMTP_USER ?? env.SMTP_USER,
        pass: env.ELARA_SMTP_PASS ?? env.CHAPTERS_SMTP_PASS ?? env.SMTP_PASS,
        from:
          env.ELARA_SMTP_FROM ??
          env.CHAPTERS_SMTP_FROM ??
          env.SMTP_FROM ??
          'elara@localhost',
      }
    : null,
  /** Comma-separated allowed cross-origin callers; unset = same-origin only. */
  corsOrigins: (env.ELARA_CORS_ORIGIN ?? env.CHAPTERS_CORS_ORIGIN ?? env.CORS_ORIGIN)
    ? (env.ELARA_CORS_ORIGIN ?? env.CHAPTERS_CORS_ORIGIN ?? env.CORS_ORIGIN)!
        .split(',')
        .map((o) => o.trim())
    : [],
  /**
   * Generic OIDC login — any spec-compliant issuer (Keycloak, Authentik, or
   * the PIIIX control plane; the app cannot tell which and must never learn).
   * A getter, not a snapshot, so tests can point it at a fake issuer whose
   * port is only known after the config module was first imported.
   * OIDC_ONLY=true also disables password login/signup/reset — a posture any
   * self-hoster mandating their IdP wants, not a hosted-edition flag.
   */
  get oidc() {
    const issuer = env.ELARA_OIDC_ISSUER ?? env.CHAPTERS_OIDC_ISSUER ?? env.OIDC_ISSUER
    if (!issuer) return null
    return {
      issuer: issuer.replace(/\/$/, ''),
      clientId: env.ELARA_OIDC_CLIENT_ID ?? env.CHAPTERS_OIDC_CLIENT_ID ?? env.OIDC_CLIENT_ID ?? '',
      clientSecret: env.ELARA_OIDC_CLIENT_SECRET ?? env.CHAPTERS_OIDC_CLIENT_SECRET ?? env.OIDC_CLIENT_SECRET ?? '',
      only: (env.ELARA_OIDC_ONLY ?? env.CHAPTERS_OIDC_ONLY ?? env.OIDC_ONLY) === 'true',
    }
  },
  /** Automated scheduled offsite backup configuration (Issue #260). */
  backup: {
    get localPath() {
      return env.ELARA_BACKUP_LOCAL_PATH ?? env.CHAPTERS_BACKUP_LOCAL_PATH ?? env.BACKUP_LOCAL_PATH
    },
    get s3Endpoint() {
      return env.ELARA_BACKUP_S3_ENDPOINT ?? env.CHAPTERS_BACKUP_S3_ENDPOINT ?? env.BACKUP_S3_ENDPOINT
    },
    get s3Region() {
      return env.ELARA_BACKUP_S3_REGION ?? env.CHAPTERS_BACKUP_S3_REGION ?? env.BACKUP_S3_REGION ?? 'us-east-1'
    },
    get s3Bucket() {
      return env.ELARA_BACKUP_S3_BUCKET ?? env.CHAPTERS_BACKUP_S3_BUCKET ?? env.BACKUP_S3_BUCKET
    },
    get s3Prefix() {
      return env.ELARA_BACKUP_S3_PREFIX ?? env.CHAPTERS_BACKUP_S3_PREFIX ?? env.BACKUP_S3_PREFIX ?? 'elara-backups/'
    },
    get s3AccessKeyId() {
      return env.ELARA_BACKUP_S3_ACCESS_KEY_ID ?? env.CHAPTERS_BACKUP_S3_ACCESS_KEY_ID ?? env.BACKUP_S3_ACCESS_KEY_ID
    },
    get s3SecretAccessKey() {
      return env.ELARA_BACKUP_S3_SECRET_ACCESS_KEY ?? env.CHAPTERS_BACKUP_S3_SECRET_ACCESS_KEY ?? env.BACKUP_S3_SECRET_ACCESS_KEY
    },
    get s3ForcePathStyle() {
      return (
        (env.ELARA_BACKUP_S3_FORCE_PATH_STYLE ?? env.CHAPTERS_BACKUP_S3_FORCE_PATH_STYLE ?? env.BACKUP_S3_FORCE_PATH_STYLE) === 'true' ||
        Boolean(env.ELARA_BACKUP_S3_ENDPOINT ?? env.CHAPTERS_BACKUP_S3_ENDPOINT ?? env.BACKUP_S3_ENDPOINT)
      )
    },
    get retentionCount() {
      return Math.max(1, Number(env.ELARA_BACKUP_RETENTION_COUNT ?? env.CHAPTERS_BACKUP_RETENTION_COUNT ?? env.BACKUP_RETENTION_COUNT ?? 7))
    },
    get intervalHours() {
      return Math.max(1, Number(env.ELARA_BACKUP_INTERVAL_HOURS ?? env.CHAPTERS_BACKUP_INTERVAL_HOURS ?? env.BACKUP_INTERVAL_HOURS ?? 24))
    },
  },
}

