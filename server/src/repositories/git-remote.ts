import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repositories } from '../db/schema.js'
import { EncryptionKeyMissingError, encryptCredential } from './credentials.js'

/**
 * `decodeURIComponent`, or the text as it is when it holds an invalid percent
 * sequence (`ssh://git:%zz@…`, a raw `50%off`). Such remotes were accepted and
 * stored before #593; a throw here would stop the boot scrub, every listing of
 * the row and its sync. `authenticatedUrl` puts the raw form back unchanged.
 */
function decodeUserinfo(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Splits `https://user:token@host/owner/repo.git` into the remote without its
 * userinfo and the userinfo itself (`user:token`, or just `token`). An
 * `ssh://user:password@` remote is split the same way (#593); a bare ssh user
 * (`ssh://git@host`) is not a secret and stays. Anything else (no userinfo,
 * scp-style `git@host:path`, `file://`, or a string that does not parse) comes
 * back unchanged with no credential (#383).
 */
export function splitGitUrlCredential(gitUrl: string): { url: string; credential: string | null } {
  let parsed: URL
  try {
    parsed = new URL(gitUrl)
  } catch {
    return { url: gitUrl, credential: null }
  }
  const http = parsed.protocol === 'https:' || parsed.protocol === 'http:'
  const sshWithPassword = parsed.protocol === 'ssh:' && parsed.password !== ''
  if (!http && !sshWithPassword) return { url: gitUrl, credential: null }
  if (!parsed.username && !parsed.password) return { url: gitUrl, credential: null }
  const user = decodeUserinfo(parsed.username)
  const password = decodeUserinfo(parsed.password)
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

/** How a URL serializes `value` as its password (`@` and `:` escaped, `$` not). */
function userinfoEncoded(value: string): string {
  const url = new URL('http://h')
  url.password = value
  return url.password
}

/**
 * Every query and fragment value in every URL in `text` replaced:
 * `?private_token=X` becomes `?private_token=***`, `#access_token=X` becomes
 * `#access_token=***` and a bare `?X` becomes `?***` (#593). Neither part is
 * userinfo, so nothing moves a token there into encrypted storage, and git
 * echoes both verbatim in its errors.
 */
export function redactUrlQuery(text: string): string {
  return text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, (url) => {
    const start = url.search(/[?#]/)
    if (start === -1) return url
    const tail = url
      .slice(start)
      .replace(/([?&#])([^=?&#]*=)?[^?&#]+/g, (_match, sep: string, key: string | undefined) => `${sep}${key ?? ''}***`)
    return url.slice(0, start) + tail
  })
}

/**
 * Usernames that name a kind of token rather than being one (compared
 * lower-cased). Redacting them would mangle every error that mentions them,
 * and they are not secret.
 */
const NON_SECRET_USERNAMES: Record<string, true> = {
  git: true,
  'x-access-token': true,
  oauth2: true,
  'x-token-auth': true,
  'gitlab-ci-token': true,
}

/**
 * Shortest user part redacted on its own. A token used as the user (the
 * legacy GitHub `TOKEN:x-oauth-basic` form) is always longer; a login such as
 * `alice` is not secret, and starring it would mangle every path it is in.
 */
const MIN_TOKEN_USER_LENGTH = 8

/**
 * Removes secrets from text bound for storage or logs (git error messages can
 * echo the authenticated clone URL). First the URL-shaped parts: any userinfo
 * in a `scheme://userinfo@` URL, up to the last `@` of the authority so a raw
 * `@` in a password leaves no tail, and every URL query and fragment value.
 * Then every given credential in each form a URL or an echo may carry it; on
 * its own, the password of a `user:password` one, and its user too when that
 * looks like a token (`MIN_TOKEN_USER_LENGTH`, not a token-type name). In that
 * order, because a short credential replaced first (user `s`, password `?`)
 * would break the URLs the regexes look for and let their tokens through.
 */
export function redactGitSecrets(text: string, secrets: Array<string | null | undefined>): string {
  const forms = new Set<string>()
  for (const secret of secrets) {
    if (!secret) continue
    const parts = [secret]
    const colon = secret.indexOf(':')
    if (colon !== -1) {
      const user = secret.slice(0, colon)
      parts.push(secret.slice(colon + 1))
      if (user.length >= MIN_TOKEN_USER_LENGTH && !Object.hasOwn(NON_SECRET_USERNAMES, user.toLowerCase())) {
        parts.push(user)
      }
    }
    for (const part of parts) {
      if (!part) continue
      forms.add(part)
      forms.add(userinfoEncoded(part))
      try {
        forms.add(encodeURIComponent(part))
      } catch {
        // A lone surrogate has no URI-encoded form; the raw form is enough.
      }
    }
  }
  let out = redactUrlQuery(text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/gi, '$1***@'))
  // Longest first, so a password never leaves the rest of its credential
  // behind. A form made of `*` alone is skipped: replacing it would only grow
  // the marker on every pass, and `***` already shows nothing.
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    if (/^\*+$/.test(form)) continue
    out = out.split(form).join('***')
  }
  return out
}

/**
 * Boot-time cleanup for remotes stored before #383 was fixed: moves URL
 * credentials into encrypted storage (keeping an existing explicit credential),
 * strips them from `gitUrl`, and redacts them from `lastSyncError`. Idempotent.
 * A row whose credential cannot be encrypted (no key configured) keeps its
 * `gitUrl` and is counted in `skipped`, because stripping it would break the
 * next sync; its `lastSyncError` is still redacted, which needs no key (#593).
 */
export async function scrubStoredGitCredentials(): Promise<{ scrubbed: number; skipped: number }> {
  const rows = await db.select().from(repositories).where(eq(repositories.ingestionMethod, 'git'))
  let scrubbed = 0
  let skipped = 0
  for (const row of rows) {
    if (!row.gitUrl) continue
    const split = splitGitUrlCredential(row.gitUrl)
    const lastSyncError = row.lastSyncError ? redactGitSecrets(row.lastSyncError, [split.credential]) : null
    let gitCredentialEncrypted = row.gitCredentialEncrypted
    if (split.credential && !gitCredentialEncrypted) {
      try {
        gitCredentialEncrypted = encryptCredential(split.credential)
      } catch (err) {
        if (!(err instanceof EncryptionKeyMissingError)) throw err
        console.warn(
          `[repositories] repository ${row.id} has a credential in its git URL and CREDENTIALS_ENCRYPTION_KEY is not set; URL left unchanged`,
        )
        skipped += 1
        if (lastSyncError !== row.lastSyncError) {
          await db.update(repositories).set({ lastSyncError }).where(eq(repositories.id, row.id))
        }
        continue
      }
    }
    if (split.url === row.gitUrl && lastSyncError === row.lastSyncError) continue
    await db
      .update(repositories)
      .set({ gitUrl: split.url, gitCredentialEncrypted, lastSyncError })
      .where(eq(repositories.id, row.id))
    scrubbed += 1
  }
  return { scrubbed, skipped }
}
