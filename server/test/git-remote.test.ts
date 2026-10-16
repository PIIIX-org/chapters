import { describe, expect, it } from 'vitest'
import { authenticatedUrl, redactGitSecrets, splitGitUrlCredential } from '../src/repositories/git-remote.js'

describe('git remote credentials (#383)', () => {
  // A credential moved out of the URL must authenticate the clone exactly as
  // the original URL did, or the fix breaks every private-repo sync.
  it.each([
    'https://x-access-token:gho_abc123@github.com/o/r.git',
    'https://gho_abc123@github.com/o/r.git',
    'https://oauth2:glpat-xyz@gitlab.com/group/sub/r.git',
    'https://us%40er:p%3Ass@git.example.com/r.git',
    // #593: an ssh:// password is a secret too (a bare ssh user is not, below).
    'ssh://git:ssh-pass@git.example.com/o/r.git',
    // An invalid percent sequence must not throw (stored rows hold them):
    // the raw form is the credential and goes back in unchanged.
    'ssh://git:%zz@git.example.com/o/r.git',
    'https://user:50%off@git.example.com/r.git',
    'https://%zz:pw@git.example.com/r.git',
  ])('round-trips %s through split + authenticatedUrl', (original) => {
    const { url, credential } = splitGitUrlCredential(original)
    expect(url).not.toContain('@')
    expect(credential).toBeTruthy()
    expect(authenticatedUrl(url, credential)).toBe(original)
  })

  it.each(['git@github.com:o/r.git', 'ssh://git@github.com/o/r.git', 'https://github.com/o/r.git', 'file:///srv/r.git'])(
    'leaves %s unchanged with no credential',
    (remote) => {
      expect(splitGitUrlCredential(remote)).toEqual({ url: remote, credential: null })
    },
  )

  it('redacts given secrets and any URL userinfo from error text', () => {
    const text = "fatal: unable to access 'https://x-access-token:gho_abc@github.com/o/r.git/': token gho_abc rejected"
    const out = redactGitSecrets(text, ['x-access-token:gho_abc', 'gho_abc'])
    expect(out).not.toContain('gho_abc')
    expect(out).toContain('https://***@github.com/o/r.git/')
  })

  // #593: git or the remote can echo the password without the user part.
  it('redacts the password of a user:password credential on its own, in every encoding', () => {
    const out = redactGitSecrets('remote: token gho_pw123 rejected; retried with p%40s$ and p%40s%24', [
      'x-access-token:gho_pw123',
      'user:p@s$',
    ])
    expect(out).toBe('remote: token *** rejected; retried with *** and ***')
  })

  it('redacts userinfo up to the last @ of the authority, so a raw @ in a password leaves no tail', () => {
    const out = redactGitSecrets("fatal: unable to access 'https://user:p@ss-tail@git.example.com/r.git/'", [])
    expect(out).toBe("fatal: unable to access 'https://***@git.example.com/r.git/'")
  })

  it('redacts query values in a URL', () => {
    const text = "fatal: unable to access 'https://git.example.com/r.git?private_token=glpat-query&x=1/': 403"
    expect(redactGitSecrets(text, [])).toBe(
      "fatal: unable to access 'https://git.example.com/r.git?private_token=***&x=***': 403",
    )
  })

  it('redacts fragment values and a bare query value, both of which git echoes verbatim', () => {
    expect(redactGitSecrets("unable to access 'https://127.0.0.1:1/o/r.git#access_token=FRAG/'", [])).toBe(
      "unable to access 'https://127.0.0.1:1/o/r.git#access_token=***'",
    )
    expect(redactGitSecrets('at https://h/r.git?a=1#access_token=X now', [])).toBe('at https://h/r.git?a=***#access_token=*** now')
    expect(redactGitSecrets('at https://h/r.git?glpat-bare-token now', [])).toBe('at https://h/r.git?*** now')
  })

  it('redacts the token of the legacy TOKEN:x-oauth-basic form on its own, but not a token-type username', () => {
    expect(redactGitSecrets('remote: token ghp_LEGACYUSER is revoked', ['ghp_LEGACYUSER:x-oauth-basic'])).toBe(
      'remote: token *** is revoked',
    )
    expect(redactGitSecrets('fatal: git could not read from git.example.com', ['git:pw1'])).toBe(
      'fatal: git could not read from git.example.com',
    )
  })

  it('is idempotent, also for a password made of `*` alone', () => {
    const text = "fatal: unable to access 'https://star-user:*@h/r.git?t=1#f=2': * rejected"
    const once = redactGitSecrets(text, ['star-user:*'])
    expect(once).toBe("fatal: unable to access 'https://***@h/r.git?t=***#f=***': * rejected")
    expect(redactGitSecrets(once, ['star-user:*'])).toBe(once)
  })
})
