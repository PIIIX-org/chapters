import { copyFile, mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { McpAuth } from '../vaults/mcp-connection-routes.js'
import { applyTree } from './apply.js'
import { loadManifest } from './metadata.js'
import { vaultRemoteDir, vaultRemotesRoot } from './lifecycle.js'
import { validatedTree, type TreeFile } from './tree.js'
import { boundedGit, GitPushError, MAIN, PACK_LIMITS, parsePush, pkt } from './pack.js'
import { ensureVaultRemote, remoteHead } from './vault-remote.js'

const flush = Buffer.from('0000')
function status(error?: string): Buffer {
  // No sideband was advertised; report-status is a pkt-line stream with one final flush.
  return Buffer.concat([pkt('unpack ok\n'), pkt(`${error ? `ng ${MAIN} ${error.replace(/[\r\n\0]/g, ' ').slice(0, 1500)}` : `ok ${MAIN}`}\n`), flush])
}

/** UNDER withVaultGit. An advertisement does not move the client's base just because a person has typed since clone. */
export async function receiveHead(vaultId: string): Promise<string> {
  const dir = vaultRemoteDir(vaultId)
  const head = await remoteHead(dir)
  if (head && await loadManifest(vaultId, head)) return head
  await ensureVaultRemote(vaultId)
  return (await remoteHead(dir))!
}

/** UNDER withVaultGit; no incoming object/ref is public until every import operation is durable. */
export async function receivePush(vaultId: string, auth: McpAuth, request: Buffer): Promise<Buffer> {
  const command = parsePush(request)
  const dir = vaultRemoteDir(vaultId)
  const head = await receiveHead(vaultId)
  if (command.old !== head) return status('stale main ref; fetch and rebase before pushing')
  const manifest = await loadManifest(vaultId, command.old)
  if (!manifest) return status('served base is no longer available; fetch and rebase')
  const quarantine = await mkdtemp(join(vaultRemotesRoot(), '.push-'))
  try {
    await boundedGit(['init', '--bare', '--quiet', quarantine], vaultRemotesRoot())
    // Trusted base objects are read-only alternates, never hard links or an untrusted checkout/config/hook.
    await mkdir(join(quarantine, 'objects', 'info'), { recursive: true })
    await writeFile(join(quarantine, 'objects', 'info', 'alternates'), join(dir, 'objects') + '\n')
    await boundedGit(['index-pack', '--stdin', '--fix-thin', '--strict', `--max-input-size=${PACK_LIMITS.request}`], quarantine, command.pack, 4096)
    await boundedGit(['merge-base', '--is-ancestor', command.old, command.next], quarantine)
    const commits = (await boundedGit(['rev-list', '--max-count=33', `${command.old}..${command.next}`], quarantine, undefined, 4096)).toString().trim().split('\n').filter(Boolean)
    if (commits.length > 32) throw new GitPushError('at most 32 commits per push are supported')
    // index-pack verifies deltas; connectivity verifies every referenced object before store writes.
    const connectivity = await boundedGit(['fsck', '--connectivity-only', '--no-reflogs', command.next], quarantine, undefined, 1024 * 1024)
    if (connectivity.toString().trim()) throw new GitPushError('pack contains unreachable objects')
    const deadline = performance.now() + PACK_LIMITS.milliseconds
    let tree: Map<string, TreeFile> | undefined
    for (const commit of commits) {
      const checked = await validatedTree(quarantine, commit, deadline)
      if (commit === command.next) tree = checked
    }
    tree ??= await validatedTree(quarantine, command.next, deadline)
    const result = await applyTree(vaultId, auth, command.next, manifest, tree)
    const report = `/git/vaults/${vaultId}/pushes/${command.next}`
    if (!result.complete) {
      const conflicts = result.results.filter((entry) => entry.result.status === 'conflicted').map((entry) => entry.result.proposalId ?? entry.path).join(', ')
      return status(`import is non-atomic; applied operations are durable; ${result.error ?? `conflicts ${conflicts}`}; review ${report}`)
    }
    // Promotion after store COMMIT, before the ref transaction/ACK. No arbitrary refs, hooks, config or alternates are copied.
    await mkdir(join(dir, 'objects', 'pack'), { recursive: true })
    for (const name of await readdir(join(quarantine, 'objects', 'pack'))) {
      if (!/^pack-[0-9a-f]{40}\.(pack|idx|rev)$/.test(name)) throw new GitPushError('unexpected quarantine file')
      const destination = join(dir, 'objects', 'pack', name)
      await copyFile(join(quarantine, 'objects', 'pack', name), destination)
      const handle = await open(destination, 'r')
      try { await handle.sync() } finally { await handle.close() }
    }
    await boundedGit(['-c', 'core.fsync=all', 'update-ref', MAIN, command.next, command.old], dir)
    // Exact incoming trees retain incoming OIDs. A merged/normalised live tree is a real FF child of that OID.
    await ensureVaultRemote(vaultId)
    return status()
  } catch (err) {
    // There may already be per-note commits. NG is explicit; never pretend rollback or an atomic import.
    return status(`push refused; partial effects may exist; ${err instanceof Error ? err.message : 'store error'}; review /git/vaults/${vaultId}/pushes/${command.next}`)
  } finally {
    await rm(quarantine, { recursive: true, force: true })
  }
}
