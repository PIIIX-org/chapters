// #677/#1087: real Git smart HTTP and the browser's real ticket/ACK path.
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { watch as watchDirectory } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Check, LabTest } from '../lib/context.ts'
import { CollabClient, collabDocName } from '../lib/collab.ts'
import { getRaw, postFile } from '../lib/portability.ts'

const exec = promisify(execFile)

const test: LabTest = {
  name: 'vault-git-push',
  description: 'Clone/edit/push a vault while a real browser client gets durable typing ACKs; real FF history, second push, attachments and token pins.',
  tier: 'fast',
  async run(ctx) {
    const checks: Check[] = []
    const data: Record<string, unknown> = {}
    const root = await mkdtemp(join(tmpdir(), 'elara-lab-vault-git-'))
    const directory = join(root, 'clone')
    const rest = ctx.rest('admin')
    const mcp = ctx.mcp('adminAccount')
    const ownedVaults: string[] = []
    const ownedTokens: string[] = []
    let tab: CollabClient | undefined
    let originalDocument: CollabClient['ydoc'] | undefined
    let inFlight: Promise<{ ok: boolean; out: string }> | undefined
    let closeGateWatch: (() => void) | undefined
    let releaseGate: string | undefined

    function check(name: string, ok: boolean, actual: unknown, severity: Check['severity'] = 'critical') {
      checks.push({ name, expected: 'true', actual: typeof actual === 'string' ? actual : JSON.stringify(actual), ok, severity })
    }
    async function git(args: string[], cwd: string | undefined, token: string) {
      const env = {
        PATH: process.env.PATH, LANG: 'C', HOME: root,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
      }
      const command = ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
        '-c', 'http.lowSpeedLimit=1', '-c', 'http.lowSpeedTime=10', ...args]
      try {
        const result = await exec('git', command, { cwd, env, timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 })
        return { ok: true, out: result.stdout + result.stderr }
      } catch (err) {
        const failure = err as { stdout?: string; stderr?: string }
        return { ok: false, out: ((failure.stdout ?? '') + (failure.stderr ?? '')).replaceAll(token, '[redacted]') }
      }
    }
    async function mustGit(args: string[], token: string, cwd = directory) {
      const result = await git(args, cwd, token)
      if (!result.ok) throw new Error(`Git ${args[0]} failed: ${result.out}`)
      return result.out.trim()
    }
    async function edit(from: string, to: string) {
      const path = join(directory, 'docs/live.md')
      const before = await readFile(path, 'utf8')
      if (!before.includes(from)) throw new Error(`missing controlled Git edit anchor ${from}`)
      await writeFile(path, before.replace(from, to))
    }
    async function commit(token: string, paths: string[]) {
      await mustGit(['add', '--', ...paths], token)
      await mustGit(['-c', 'user.name=Elara Git lab', '-c', 'user.email=git-lab@localhost', 'commit', '-qm', 'vault lab edit'], token)
      return mustGit(['rev-parse', 'HEAD'], token)
    }

    try {
      const vault = await ctx.createVault('admin', ctx.uniq('git-push'))
      ownedVaults.push(vault.id)
      const other = await ctx.createVault('admin', ctx.uniq('git-pin-control'))
      ownedVaults.push(other.id)
      const created = await mcp.must<{ id: string }>('create_note', { vaultId: vault.id, path: 'docs/live', body: 'First line.\nAgent base.\nLast line.\n' })
      const writer = await ctx.mintToken('admin', ctx.uniq('git-writer'), 'vault', { vaultId: vault.id, access: 'write', profile: 'admin' })
      ownedTokens.push(writer.id)
      const reader = await ctx.mintToken('admin', ctx.uniq('git-reader'), 'vault', { vaultId: vault.id, access: 'read', profile: 'reader' })
      ownedTokens.push(reader.id)
      const originalAsset = Buffer.from('original Git attachment\0')
      const uploaded = await postFile(ctx.baseUrl, `/api/vaults/${vault.id}/assets`, rest.cookie, 'git-proof.txt', originalAsset, 'text/plain')
      const asset = uploaded.json as { fileName?: string } | undefined
      if (uploaded.status !== 200 || !asset?.fileName || !/^[a-z0-9_-]+\.txt$/.test(asset.fileName)) throw new Error(`controlled attachment setup failed: HTTP ${uploaded.status}`)
      const assetPath = `.assets/${asset.fileName}`
      const remote = `${ctx.baseUrl}/git/vaults/${vault.id}`
      await mustGit(['clone', '--quiet', remote, directory], writer.token, root)
      check('clone exports the real attachment bytes', (await readFile(join(directory, assetPath))).equals(originalAsset), assetPath)
      tab = new CollabClient(ctx.baseUrl, collabDocName(vault.id, created.id), rest)
      originalDocument = tab.ydoc
      const connected = await tab.connect()
      check('real browser ticket connects to the note identity', connected, { connected, authFailed: tab.authFailed })
      if (!connected) return { summary: 'Git/browser setup failed; no concurrency success claimed.', checks, data }
      await edit('Agent base.', 'Agent first push.')
      const replacement = Buffer.from('replacement Git attachment\0')
      await writeFile(join(directory, assetPath), replacement)
      const incoming = await commit(writer.token, ['docs/live.md', assetPath])
      const hooks = join(directory, '.git', 'hooks')
      await mkdir(hooks, { recursive: true })
      releaseGate = join(directory, '.git', 'push-release')
      // This trusted, bounded client hook signals AFTER real remote discovery.
      await writeFile(join(hooks, 'pre-push'), '#!/bin/sh\ntouch .git/push-ready\ni=0\nwhile [ ! -f .git/push-release ] && [ "$i" -lt 500 ]; do sleep 0.02; i=$((i+1)); done\ntest -f .git/push-release\n', { mode: 0o700 })
      let signalReady!: (ready: boolean) => void
      const ready = new Promise<boolean>(resolve => { signalReady = resolve })
      const watcher = watchDirectory(join(directory, '.git'), (_event, name) => { if (name === 'push-ready') signalReady(true) })
      // Real process IPC needs a deadline; it is not a guessed readiness delay.
      const guard = setTimeout(() => signalReady(false), 10_000)
      closeGateWatch = () => { watcher.close(); clearTimeout(guard) }
      let completed = false
      inFlight = git(['-c', `core.hooksPath=${hooks}`, 'push', 'origin', 'HEAD:main'], directory, writer.token)
        .then(result => { completed = true; return result })
      const afterDiscovery = await Promise.race([ready, inFlight.then(() => false)])
      closeGateWatch()
      closeGateWatch = undefined
      check('a real Git push is held after discovery before the person types', afterDiscovery && !completed, { afterDiscovery, completed })
      if (!afterDiscovery) throw new Error('Git did not reach its controlled pre-push boundary')
      tab.type('Human leading line.\n', 0)
      tab.type('Human trailing line.\n')
      const acked = await tab.waitAcked()
      check('typing is durably ACKed while the Git push is still in flight', acked && !completed, { acked, completed, unsynced: tab.unsynced })
      await writeFile(releaseGate, '')
      const pushed = await inFlight
      inFlight = undefined
      check('the real receive-pack accepts the stale served base safely', pushed.ok, pushed.out)
      if (!pushed.ok) throw new Error(`Git push failed: ${pushed.out}`)
      const live = await mcp.must<{ body: string }>('read_note', { vaultId: vault.id, path: 'docs/live' })
      const expected = 'Human leading line.\nFirst line.\nAgent first push.\nLast line.\nHuman trailing line.\n'
      check('neither ACKed human text nor agent text is lost', acked && live.body === expected && tab.offered === null, { body: live.body, offered: tab.offered })
      await mustGit(['fetch', '--quiet', 'origin'], writer.token)
      const canonical = await mustGit(['rev-parse', 'origin/main'], writer.token)
      const ancestor = await git(['merge-base', '--is-ancestor', incoming, canonical], directory, writer.token)
      check('the acknowledged incoming OID is retained under a real fast-forward canonical child', canonical !== incoming && ancestor.ok, { incoming, canonical, ancestor: ancestor.ok })
      await mustGit(['merge', '--ff-only', 'origin/main'], writer.token)
      check('next fetch/fast-forward has all text and a clean worktree', (await readFile(join(directory, 'docs/live.md'), 'utf8')).includes(expected) && await mustGit(['status', '--porcelain'], writer.token) === '', canonical)
      const downloaded = await getRaw(ctx.baseUrl, `/api/vaults/${vault.id}/assets/${asset.fileName}`, rest.cookie)
      check('Git replacement preserves HTTP attachment bytes', downloaded.status === 200 && downloaded.bytes.length === replacement.length && downloaded.bytes.every((value, index) => value === replacement[index]), { status: downloaded.status, size: downloaded.bytes.length })
      await edit('Agent first push.', 'Agent second push.')
      await rm(join(directory, assetPath))
      const secondOid = await commit(writer.token, ['docs/live.md', assetPath])
      const secondPush = await git(['push', 'origin', 'HEAD:main'], directory, writer.token)
      check('a second real push succeeds without a force update', secondPush.ok, secondPush.out)
      const afterSecond = await mcp.must<{ body: string }>('read_note', { vaultId: vault.id, path: 'docs/live' })
      check('the second push still preserves both human markers', afterSecond.body === expected.replace('Agent first push.', 'Agent second push.'), afterSecond.body)
      const removed = await getRaw(ctx.baseUrl, `/api/vaults/${vault.id}/assets/${asset.fileName}`, rest.cookie)
      check('Git asset deletion follows the real HTTP/store policy', removed.status === 404, removed.status)
      await edit('Agent second push.', 'Read token must not write.')
      await commit(writer.token, ['docs/live.md'])
      const readPush = await git(['push', 'origin', 'HEAD:main'], directory, reader.token)
      const unchanged = await mcp.must<{ body: string }>('read_note', { vaultId: vault.id, path: 'docs/live' })
      check('read-token push is refused without changing text', !readPush.ok && unchanged.body === afterSecond.body, readPush.out)
      const wrongVault = await git(['ls-remote', `${ctx.baseUrl}/git/vaults/${other.id}`], root, writer.token)
      const repositoryPin = await git(['ls-remote', remote], root, ctx.env.tokens.adminRepoPinned.token)
      check('vault and repository pins never widen to a different resource', !wrongVault.ok && !repositoryPin.ok, { wrongVault: wrongVault.ok, repositoryPin: repositoryPin.ok })
      data.refs = { incoming, canonical, secondOid }
      data.typing = { acked, offered: tab.offered, expected, actual: afterSecond.body }
      return { summary: 'Real Git clone/push/fetch/second-push with durable browser typing, attachment replacement/deletion and scope refusals.', checks, data }
    } finally {
      const failures: string[] = []
      closeGateWatch?.()
      if (releaseGate) {
        try { await writeFile(releaseGate, '') } catch { failures.push('client gate release') }
      }
      await inFlight
      tab?.destroy()
      tab?.ydoc.destroy()
      if (originalDocument && originalDocument !== tab?.ydoc) originalDocument.destroy()
      for (const id of ownedTokens) {
        try {
          const result = await rest.request('POST', `/api/mcp-connections/${id}/revoke`)
          if (result.status >= 300 && result.status !== 404) failures.push('owned token revoke')
        } catch { failures.push('owned token revoke transport') }
      }
      for (const id of ownedVaults) {
        try {
          const result = await rest.request('DELETE', `/api/vaults/${id}`)
          if (result.status >= 300 && result.status !== 404) failures.push('owned vault purge')
        } catch { failures.push('owned vault purge transport') }
      }
      try { await rm(root, { recursive: true, force: true }) } catch { failures.push('owned clone removal') }
      if (failures.length) throw new Error(`Git lab cleanup failed: ${failures.join(', ')}`)
    }
  },
}

export default test
