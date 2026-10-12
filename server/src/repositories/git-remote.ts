import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repositories } from '../db/schema.js'
import { EncryptionKeyMissingError, encryptCredential } from './credentials.js'

/**
 * Splits `https://user:token@host/owner/repo.git` into the remote without its
 * userinfo and the userinfo itself (`user:token`, or just `token`). Anything
 * else (no userinfo, scp-style `git@host:path`, `ssh://`, `file://`, or a
 * string that does not parse) comes back unchanged with no credential: only
 * http(s) userinfo is ever a secret (#383).
 */
export function splitGitUrlCredential(gitUrl: string): { url: string; credential: string | null } {
  let parsed: URL
  try {
    parsed = new URL(gitUrl)
  } catch {
    return { url: gitUrl, credential: null }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { url: gitUrl, credential: null }
  if (!parsed.username && !parsed.password) return { url: gitUrl, credential: null }
  const user = decodeURIComponent(parsed.username)
  const password = decodeURIComponent(parsed.password)
  parsed.username = ''
  parsed.password = ''
  return { url: parsed.toString(), credential: password ? `${user}:${password}` : user }
}

/**
 * Puts a stored credential back into the remote for a clone. A bare token goes
 * in as the username (the PAT convention); `user:password` (what
 * `splitGitUrlCredential` extracts from `https://x-access-token:TOKEN@…`) goes
 * back in as both parts, so a moved-out credential authenticates exactly as the
 * original URL did.
 */
export function authenticatedUrl(gitUrl: string, credential: string | null): string {
  if (!credential) return gitUrl
  try {
    const url = new URL(gitUrl)
    const colon = credential.indexOf(':')
    if (colon === -1) {
      url.username = credential
    } else {
      url.username = credential.slice(0, colon)
      url.password = credential.slice(colon + 1)
    }
    return url.toString()
  } catch {
    return gitUrl
  }
}

/**
 * The stored form of a remote: never the URL as given. An explicit
 * `gitCredential` wins; otherwise a credential embedded in the URL is moved
 * into encrypted storage. Throws `EncryptionKeyMissingError` rather than keep a
 * token in plaintext when no key is configured.
 */
export function prepareGitRemote(
  gitUrl: string,
  gitCredential?: string,
): { gitUrl: string; gitCredentialEncrypted?: string } {
  const split = splitGitUrlCredential(gitUrl)
  const credential = gitCredential ?? split.credential
  return {
    gitUrl: split.url,
    gitCredentialEncrypted: credential ? encryptCredential(credential) : undefined,
  }
}

/**
 * Removes secrets from text bound for storage or logs (git error messages can
 * echo the authenticated clone URL): every given secret, plus any userinfo in
 * a `scheme://userinfo@` URL.
 */
export function redactGitSecrets(text: string, secrets: Array<string | null | undefined>): string {
  let out = text
  for (const secret of secrets) {
    if (!secret) continue
    for (const form of new Set([secret, encodeURIComponent(secret)])) out = out.split(form).join('***')
  }
  return out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***@')
}

/**
 * Boot-time cleanup for remotes stored before #383 was fixed: moves URL
 * credentials into encrypted storage (keeping an existing explicit credential),
 * strips them from `gitUrl`, and redacts them from `lastSyncError`. Idempotent.
 * A row whose credential cannot be encrypted (no key configured) is left as is
 * and counted in `skipped`, because stripping it would break the next sync.
 */
export async function scrubStoredGitCredentials(): Promise<{ scrubbed: number; skipped: number }> {
  const rows = await db.select().from(repositories).where(eq(repositories.ingestionMethod, 'git'))
  let scrubbed = 0
  let skipped = 0
  for (const row of rows) {
    if (!row.gitUrl) continue
    const split = splitGitUrlCredential(row.gitUrl)
    let gitCredentialEncrypted = row.gitCredentialEncrypted
    if (split.credential && !gitCredentialEncrypted) {
      try {
        gitCredentialEncrypted = encryptCredential(split.credential)
      } catch (err) {
        if (!(err instanceof EncryptionKeyMissingError)) throw err
        console.warn(
          `[repositories] repository ${row.id} has a credential in its git URL and CREDENTIALS_ENCRYPTION_KEY is not set; left unchanged`,
        )
        skipped += 1
        continue
      }
    }
    const lastSyncError = row.lastSyncError ? redactGitSecrets(row.lastSyncError, [split.credential]) : null
    if (split.url === row.gitUrl && lastSyncError === row.lastSyncError) continue
    await db
      .update(repositories)
      .set({ gitUrl: split.url, gitCredentialEncrypted, lastSyncError })
      .where(eq(repositories.id, row.id))
    scrubbed += 1
  }
  return { scrubbed, skipped }
}
