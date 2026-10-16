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
})
