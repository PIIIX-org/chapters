const env = process.env

export const config = {
  nodeEnv: env.NODE_ENV ?? 'development',
  isProd: env.NODE_ENV === 'production',
  port: Number(env.PORT ?? 3000),
  databaseUrl:
    env.DATABASE_URL ?? 'postgres://chapters:chapters@localhost:5432/chapters',
  /** Root directory for vault note files (OKF markdown on disk). */
  dataDir: env.DATA_DIR ?? './data',
  /** Optional pre-set one-time setup token; generated+logged if absent. */
  setupToken: env.SETUP_TOKEN,
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
