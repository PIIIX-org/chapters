import { mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { failpoint } from '../failpoints.js'
import { ensureDirectory, syncDirectory } from '../notes/atomic-write.js'
import { storeTransaction } from '../notes/store-tx.js'
import type { McpAuth } from '../vaults/mcp-connection-routes.js'
import { applyTree } from './apply.js'
import { loadManifest } from './metadata.js'
import { vaultRemoteDir, vaultRemotesRoot } from './lifecycle.js'
import { validatedTree, type TreeFile } from './tree.js'
import { boundedGit, GitPushError, gitTimeLimit, MAIN, PACK_LIMITS, parsePush, pkt, withGitBudget } from './pack.js'
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
  return (await ensureVaultRemote(vaultId)).head
}

/** A transport error, not an NG claim that the ref stayed unchanged. */
class GitRefOutcomeUnknown extends Error {
  readonly statusCode = 503
  readonly expose = true
  constructor() { super('Git ref publication outcome is uncertain; fetch before retrying') }
}

async function rollbackRef(dir: string, old: string, incoming: string, canonical: string): Promise<void> {
  // Cleanup gets one separately bounded window even when ordinary work expired.
  await withGitBudget(async () => {
    const current = (await boundedGit(['rev-parse', '--verify', MAIN], dir, undefined, 4096)).toString().trim()
    if (current === old) return
    if (current !== incoming && current !== canonical) throw new GitRefOutcomeUnknown()
    failpoint('git.before-ref-rollback')
    await boundedGit(['update-ref', MAIN, old, current], dir)
    await syncDirectory(join(dir, 'refs', 'heads'))
  }, PACK_LIMITS.milliseconds)
}

/** UNDER withVaultGit; no incoming object/ref is public until every import operation is durable. */
export async function receivePush(vaultId: string, request: Buffer, checkWrite: () => Promise<McpAuth>): Promise<Buffer> {
  const command = parsePush(request)
  const dir = vaultRemoteDir(vaultId)
  const head = await receiveHead(vaultId)
  if (command.old !== head) return status('stale main ref; fetch and rebase before pushing')
  const manifest = await loadManifest(vaultId, command.old)
  if (!manifest) return status('served base is no longer available; fetch and rebase')
  const quarantine = await mkdtemp(join(vaultRemotesRoot(), '.push-'))
  try {
    await boundedGit(['init', '--bare', '--quiet', '--object-format=sha1', quarantine], vaultRemotesRoot())
    // Trusted base objects are read-only alternates, never hard links or an untrusted checkout/config/hook.
    await mkdir(join(quarantine, 'objects', 'info'), { recursive: true })
    await writeFile(join(quarantine, 'objects', 'info', 'alternates'), join(dir, 'objects') + '\n')
    await boundedGit(['index-pack', '--stdin', '--fix-thin', '--strict', `--max-input-size=${PACK_LIMITS.request}`], quarantine, command.pack, 4096)
    await boundedGit(['merge-base', '--is-ancestor', command.old, command.next], quarantine)
    const commits = (await boundedGit(['rev-list', '--max-count=33', `${command.old}..${command.next}`], quarantine, undefined, 4096)).toString().trim().split('\n').filter(Boolean)
    if (commits.length > 32) throw new GitPushError('at most 32 commits per push are supported')
    // index-pack verifies deltas; connectivity verifies every referenced object before store writes.
    const connectivity = (await boundedGit(['fsck', '--connectivity-only', '--no-reflogs', command.next], quarantine, undefined, 1024 * 1024)).toString().trim()
    if (connectivity) {
      // Failed, unacknowledged publication can leave valid server packs in the
      // trusted alternate. Reject dangling objects from THIS incoming pack,
      // not those earlier private canonical children.
      const indexes = (await readdir(join(quarantine, 'objects', 'pack'))).filter(name => /^pack-[0-9a-f]{40}\.idx$/.test(name))
      const incoming = new Set<string>()
      for (const index of indexes) {
        const listing = (await boundedGit(['verify-pack', '-v', join(quarantine, 'objects', 'pack', index)], quarantine, undefined, 1024 * 1024)).toString()
        for (const line of listing.split('\n')) {
          const oid = /^([0-9a-f]{40}) /.exec(line)?.[1]
          if (oid) incoming.add(oid)
        }
      }
      if (connectivity.split('\n').some(line => {
        const warning = /^(?:dangling|unreachable) (?:commit|tree|blob|tag) ([0-9a-f]{40})$/.exec(line)
        return !warning || incoming.has(warning[1]!)
      })) throw new GitPushError('pack contains unreachable objects')
    }
    const deadline = performance.now() + gitTimeLimit()
    let tree: Map<string, TreeFile> | undefined
    for (const commit of commits) {
      const checked = await validatedTree(quarantine, commit, deadline)
      if (commit === command.next) tree = checked
    }
    tree ??= await validatedTree(quarantine, command.next, deadline)
    const result = await applyTree(vaultId, await checkWrite(), command.next, manifest, tree, checkWrite)
    const report = `/git/vaults/${vaultId}/pushes/${command.next}`
    if (!result.complete) {
      const conflicts = result.results.filter((entry) => entry.result.status === 'conflicted').map((entry) => entry.result.proposalId ?? entry.path).join(', ')
      return status(`import is non-atomic; applied operations are durable; ${result.error ?? `conflicts ${conflicts}`}; review ${report}`)
    }
    // Prepare the actual FF child and its durable identity map privately FIRST.
    // Recovery reuses the journal's timestamp/OID even after this directory is lost.
    await boundedGit(['update-ref', MAIN, command.next], quarantine)
    const prepared = await ensureVaultRemote(vaultId, quarantine)
    failpoint('git.after-mapping-before-publication')
    await ensureDirectory(join(dir, 'objects', 'pack'), true)
    const packs = await readdir(join(quarantine, 'objects', 'pack'))
    if (packs.some(name => !/^pack-[0-9a-f]{40}\.(pack|idx|rev)$/.test(name))) throw new GitPushError('unexpected quarantine file')
    // An index makes a pack discoverable: publish every pack before any index.
    packs.sort((a, b) => Number(a.endsWith('.idx')) - Number(b.endsWith('.idx')))
    for (const name of packs) {
      const destination = join(dir, 'objects', 'pack', name)
      // Same managed filesystem: atomic rename never truncates an already
      // retained hash-named pack, including on a retry or interrupted promotion.
      await rename(join(quarantine, 'objects', 'pack', name), destination)
      const handle = await open(destination, 'r')
      try { await handle.sync() } finally { await handle.close() }
    }
    await syncDirectory(join(dir, 'objects', 'pack'))
    await checkWrite()
    let publicationStarted = false
    try {
      await storeTransaction([], async tx => {
        await tx.execute(sql`SELECT set_config('statement_timeout', ${`${Math.ceil(gitTimeLimit())}ms`}, true)`)
        const [fence] = (await tx.execute(sql`
          SELECT EXISTS (SELECT 1 FROM vaults WHERE id = ${vaultId}) AND NOT EXISTS (
            SELECT 1 FROM jsonb_each_text(${JSON.stringify(prepared.epochs)}::jsonb) expected
            LEFT JOIN notes n ON n.id = expected.key::uuid AND n.vault_id = ${vaultId}
            WHERE n.id IS NULL OR n.purge_epoch::text <> expected.value
          ) AS ok`)) as unknown as Array<{ ok: boolean }>
        if (!fence?.ok) throw new GitPushError('content was purged before Git ref publication')
        publicationStarted = true
        // Retain the exact acknowledged OID as the real main ref, followed only
        // by its prepared real child. Readers cannot observe the interim state.
        await boundedGit(['update-ref', MAIN, command.next, command.old], dir)
        await syncDirectory(join(dir, 'refs', 'heads'))
        failpoint('git.after-incoming-ref-before-canonical')
        if (prepared.head !== command.next) {
          await boundedGit(['update-ref', MAIN, prepared.head, command.next], dir)
          await syncDirectory(join(dir, 'refs', 'heads'))
        }
      }, [vaultId])
    } catch (err) {
      if (publicationStarted) {
        try { await rollbackRef(dir, command.old, command.next, prepared.head) }
        catch { throw new GitRefOutcomeUnknown() }
      }
      throw err
    }
    return status()
  } catch (err) {
    if (err instanceof GitRefOutcomeUnknown) throw err
    // There may already be per-note commits. NG is explicit; never pretend rollback or an atomic import.
    return status(`push refused; partial effects may exist; ${err instanceof Error ? err.message : 'store error'}; review /git/vaults/${vaultId}/pushes/${command.next}`)
  } finally {
    await rm(quarantine, { recursive: true, force: true })
  }
}
