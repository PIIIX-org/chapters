import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'

const env = process.env

/**
 * `ELARA_HEALTH_HIDE_VERSION` -> whether `/health` leaves out `version`
 * (#638). Only `true` hides it. Any value other than unset, empty, `true` or
 * `false` (`1`, `yes`, `TRUE`, ...) keeps it shown and warns once, when the
 * config loads at boot, so a typo does not silently keep the commit public.
 */
export function readHealthHidesVersion(raw: string | undefined): boolean {
  if (raw === undefined || raw === '' || raw === 'false') return false
  if (raw === 'true') return true
  console.warn(`ELARA_HEALTH_HIDE_VERSION=${JSON.stringify(raw)} is not 'true' or 'false': /health keeps reporting version`)
  return false
}

/**
 * Which peers may say who the client is (#911), as Fastify's `trustProxy`:
 * `false` (the socket's peer is the client) or the proxies' addresses.
 * Without it every request behind a reverse proxy has the proxy's address as
 * `req.ip`, so every user shares one rate-limit bucket, one login lockout and
 * one address in the security events.
 */
export type TrustProxy = false | string[]

/** proxy-addr's named ranges, which Fastify's trustProxy accepts as list entries. */
const PROXY_RANGE_NAMES: readonly string[] = ['loopback', 'linklocal', 'uniquelocal']

/** An IPv4/IPv6 address, an address/prefix CIDR, or a proxy-addr range name. */
function isProxyEntry(entry: string): boolean {
  if (PROXY_RANGE_NAMES.includes(entry)) return true
  const [address, prefix, extra] = entry.split('/')
  const family = isIP(address ?? '')
  if (!family || extra !== undefined) return false
  if (prefix === undefined) return true
  // `/0` is every address: the same as trusting every peer.
  return /^\d{1,3}$/.test(prefix) && Number(prefix) > 0 && Number(prefix) <= (family === 4 ? 32 : 128)
}

/**
 * `ELARA_TRUST_PROXY` -> Fastify's `trustProxy` (#911). Unset, empty or
 * `false`: off, the socket's peer is the client (direct exposure, and the
 * behaviour before #911). Otherwise a comma-separated list of the proxies'
 * addresses or CIDRs (`127.0.0.1`, `172.16.0.0/12`, `loopback`): only a
 * request whose peer is one of them has its `X-Forwarded-For` read, and only
 * back to the first address that is not. Never every peer: `true`, `*` or a
 * `/0` would let any client name its own address and walk around every rate
 * limit and lockout. Not a hop count either: it cannot tell the proxy from a
 * client that reached the app's port directly, and Fastify trusts no hop
 * count for that reason. Anything else warns once at boot and keeps it off.
 */
export function readTrustProxy(raw: string | undefined): TrustProxy {
  const value = raw?.trim() ?? ''
  if (value === '' || value === 'false') return false
  const entries = value.split(',').map((entry) => entry.trim())
  if (entries.every(isProxyEntry)) return entries
  console.warn(
    `ELARA_TRUST_PROXY=${JSON.stringify(raw)} is not a list of proxy addresses or CIDRs: X-Forwarded-For is not trusted (name the reverse proxy's address as the app sees it; never true or a hop count, which trust any client)`,
  )
  return false
}

/** Shortest ELARA_MONITORING_TOKEN accepted (`openssl rand -hex 32` gives 64). */
export const MIN_MONITORING_TOKEN_LENGTH = 32

/** Default ELARA_NOTE_MAX_BYTES: 1 MiB, the size REST and MCP refused at before #491. */
export const DEFAULT_NOTE_MAX_BYTES = 1024 * 1024

/** `ELARA_NOTE_MAX_BYTES` -> a positive whole number of bytes, or null when it is not one. */
export function readNoteMaxBytes(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return DEFAULT_NOTE_MAX_BYTES
  const bytes = Number(raw)
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null
}

if (readNoteMaxBytes(env.ELARA_NOTE_MAX_BYTES) === null) {
  console.warn(`ELARA_NOTE_MAX_BYTES=${JSON.stringify(env.ELARA_NOTE_MAX_BYTES)} is not a positive whole number of bytes: using ${DEFAULT_NOTE_MAX_BYTES}`)
}

/** Default ELARA_EMBED_MAX_SYMBOLS_PER_FILE (#496); the largest file in the benchmark's chapters corpus has 43 symbols. */
export const DEFAULT_EMBED_MAX_SYMBOLS_PER_FILE = 256

/** `ELARA_EMBED_MAX_SYMBOLS_PER_FILE` -> a whole number >= 0, or null when it is not one. */
export function readEmbedMaxSymbolsPerFile(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return DEFAULT_EMBED_MAX_SYMBOLS_PER_FILE
  if (raw.trim() === '') return null
  const max = Number(raw)
  return Number.isSafeInteger(max) && max >= 0 ? max : null
}

if (readEmbedMaxSymbolsPerFile(env.ELARA_EMBED_MAX_SYMBOLS_PER_FILE) === null) {
  console.warn(`ELARA_EMBED_MAX_SYMBOLS_PER_FILE=${JSON.stringify(env.ELARA_EMBED_MAX_SYMBOLS_PER_FILE)} is not a whole number >= 0: using ${DEFAULT_EMBED_MAX_SYMBOLS_PER_FILE}`)
}

export const config = {
  nodeEnv: env.NODE_ENV ?? 'development',
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  /**
   * Commit the image was built from: publish.yml passes it as the
   * `ELARA_VERSION` build arg and the Dockerfile bakes it in. Reported by
   * `/health` (#583); null for builds that did not set it.
   */
  version: env.ELARA_VERSION || null,
  /**
   * `ELARA_HEALTH_HIDE_VERSION=true` leaves `version` out of `/health` (#638),
   * for an operator who does not want to publish the build commit. Default:
   * shown. The boot log line keeps it either way.
   */
  healthHidesVersion: readHealthHidesVersion(env.ELARA_HEALTH_HIDE_VERSION),
  /** `ELARA_TRUST_PROXY` (or `TRUST_PROXY`): the reverse proxies whose `X-Forwarded-For` names the client (#911, readTrustProxy). */
  trustProxy: readTrustProxy(env.ELARA_TRUST_PROXY ?? env.TRUST_PROXY),
  /**
   * `ELARA_MONITORING_TOKEN` (#705): the bearer token that reads
   * GET /api/admin/monitoring without a session (the uptime monitor). Unset,
   * or shorter than MIN_MONITORING_TOKEN_LENGTH: only an admin session
   * reads it. A getter so tests can set it after the config loads.
   */
  get monitoringToken(): string | null {
    const token = env.ELARA_MONITORING_TOKEN
    return token && token.length >= MIN_MONITORING_TOKEN_LENGTH ? token : null
  },
  /**
   * `ELARA_NOTE_MAX_BYTES` (#491): the largest note body, in UTF-8 bytes, that
   * any write path stores (REST, MCP, import, the collab relay); see
   * notes/size-cap.ts. Default 1 MiB. A getter so tests can change it after
   * the config loads.
   */
  get noteMaxBytes(): number {
    return readNoteMaxBytes(env.ELARA_NOTE_MAX_BYTES) ?? DEFAULT_NOTE_MAX_BYTES
  },
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
  /**
   * Per-file embedding budget (#496): extraction embeds a repository file and
   * at most this many of its symbols; the rest are stored without a vector
   * (keyword search and read_file still see them) and the file records why in
   * `embedding_note`. Each text is cut to 16k characters, so one file costs at
   * most 1 + this many texts. A getter so tests can set it after the config loads.
   */
  get embedMaxSymbolsPerFile(): number {
    return readEmbedMaxSymbolsPerFile(env.ELARA_EMBED_MAX_SYMBOLS_PER_FILE) ?? DEFAULT_EMBED_MAX_SYMBOLS_PER_FILE
  },
  /**
   * Search's relevance gate (#441): a vector hit counts only when its cosine
   * distance to the query is below this; a keyword hit always counts.
   * bge-small (`local`): MEASURED. The fake test embedder's bag-of-words
   * vectors: 0.8, the 0.2 similarity its semantic edges use in the tests.
   */
  get searchMaxDistance(): number {
    return Number(env.SEARCH_MAX_DISTANCE ?? (this.embeddings === 'local' ? 0.5 : 0.8))
  },
  semanticThreshold: Number(env.SEMANTIC_THRESHOLD ?? 0.75),
  semanticK: Number(env.SEMANTIC_K ?? 8),
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

