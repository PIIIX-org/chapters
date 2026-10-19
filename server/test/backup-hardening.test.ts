// Backup hardening (#493): backups on disk are private to the server's user,
// and backup.json carries a SHA-256 and size per part that restore checks
// before it writes anything.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { sql as dsql } from 'drizzle-orm'
import { config } from '../src/config.js'
import { db } from '../src/db/client.js'
import { users, vaults } from '../src/db/schema.js'
import { buildInstanceBackup } from '../src/export/archive.js'
import { executeBackup } from '../src/export/backup-service.js'
import { BackupInvalidError, restoreBackup } from '../src/export/restore.js'
import { createNote, saveAsset } from '../src/notes/store.js'
import { createActiveUser, wipeInstance } from './helpers.js'

const root = join(process.cwd(), 'scratch/backup-hardening')

async function userCount(): Promise<number> {
  const [row] = await db.select({ n: dsql<number>`count(*)::int` }).from(users)
  return row?.n ?? 0
}

async function vaultFiles(): Promise<string[]> {
  return readdir(join(config.dataDir, 'vaults'), { recursive: true }).catch(() => [])
}

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777

describe('backup files on disk (#493)', () => {
  const umask = process.umask()

  afterEach(async () => {
    process.umask(umask)
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  it('writes the backup 0600 in a new 0700 directory under umask 022, leaving no temp file', async () => {
    const dir = join(root, 'new', 'backups')
    vi.spyOn(config.backup, 'localPath', 'get').mockReturnValue(dir)
    process.umask(0o022)
    const result = await executeBackup()
    expect((await modeOf(join(dir, result.filename))).toString(8)).toBe('600')
    expect((await modeOf(dir)).toString(8)).toBe('700')
    expect(await readdir(dir)).toEqual([result.filename])
  })

  it('tightens an existing world-readable directory, and the file, under umask 000', async () => {
    const dir = join(root, 'existing')
    await mkdir(dir, { recursive: true })
    await chmod(dir, 0o755)
    vi.spyOn(config.backup, 'localPath', 'get').mockReturnValue(dir)
    process.umask(0o000)
    const result = await executeBackup()
    expect((await modeOf(join(dir, result.filename))).toString(8)).toBe('600')
    expect((await modeOf(dir)).toString(8)).toBe('700')
  })
})

describe('backup manifest digests (#493)', () => {
  let archive: Buffer
  let vaultId: string
  let assetName: string

  beforeAll(async () => {
    await wipeInstance()
    const owner = await createActiveUser({ role: 'admin' })
    const [vault] = await db.insert(vaults).values({ name: 'Digests', ownerId: owner.id }).returning()
    vaultId = vault!.id
    await createNote(vaultId, { path: 'concepts/kept', frontmatter: { type: 'concepts' }, body: 'the original body\n' }, { type: 'user', id: owner.id })
    assetName = (await saveAsset(vaultId, 'blob.bin', Buffer.alloc(4096, 7))).fileName
    archive = await buildInstanceBackup()
  })

  afterAll(async () => {
    await wipeInstance()
  })

  const noteEntryName = () => `vaults/${vaultId}/notes/concepts/kept.md`
  const assetEntryName = () => `vaults/${vaultId}/assets/${assetName}`

  /** A copy of the archive with `change` applied; AdmZip rewrites each entry's CRC, so the zip itself stays valid. */
  function altered(change: (zip: AdmZip) => void): Buffer {
    const zip = new AdmZip(archive)
    change(zip)
    return zip.toBuffer()
  }

  async function expectRefused(bad: Buffer, message: RegExp): Promise<void> {
    await wipeInstance()
    const error = await restoreBackup(bad).then(
      () => null,
      (err: unknown) => err,
    )
    expect(error).toBeInstanceOf(BackupInvalidError)
    expect(String((error as Error).message)).toMatch(message)
    expect(await userCount()).toBe(0)
    expect(await vaultFiles()).toEqual([])
  }

  it('records the SHA-256 and size of every other entry in backup.json', () => {
    const zip = new AdmZip(archive)
    const manifest = JSON.parse(zip.getEntry('backup.json')!.getData().toString('utf8')) as {
      parts?: Record<string, { sha256: string; size: number }>
    }
    const entries = zip.getEntries().filter((e) => !e.isDirectory && e.entryName !== 'backup.json')
    expect(entries.map((e) => e.entryName)).toEqual(expect.arrayContaining(['db/users.jsonl', noteEntryName(), assetEntryName()]))
    expect(Object.keys(manifest.parts ?? {}).sort()).toEqual(entries.map((e) => e.entryName).sort())
    for (const entry of entries) {
      const data = entry.getData()
      expect(manifest.parts![entry.entryName]).toEqual({ sha256: createHash('sha256').update(data).digest('hex'), size: data.length })
    }
  })

  it('refuses a part changed after the backup (its zip CRC still valid), writing nothing', async () => {
    const bad = altered((zip) => zip.updateFile(noteEntryName(), Buffer.from('---\ntype: concepts\n---\nan edited body\n')))
    await expectRefused(bad, /vaults\/.+\/notes\/concepts\/kept\.md .*SHA-256/)
  })

  it('refuses a truncated part, writing nothing', async () => {
    const bad = altered((zip) => zip.updateFile(assetEntryName(), Buffer.alloc(1024, 7)))
    await expectRefused(bad, /assets\/.+ is 1024 bytes, backup\.json says 4096/)
  })

  it('refuses an archive with a part missing, writing nothing', async () => {
    const bad = altered((zip) => zip.deleteFile(noteEntryName()))
    await expectRefused(bad, /kept\.md is listed in backup\.json but missing/)
  })

  it('refuses an entry backup.json does not list, writing nothing', async () => {
    const bad = altered((zip) => zip.addFile(`vaults/${vaultId}/assets/extra.bin`, Buffer.from('smuggled')))
    await expectRefused(bad, /extra\.bin is not listed in backup\.json/)
  })

  it('refuses a truncated archive file, writing nothing', async () => {
    await expectRefused(archive.subarray(0, Math.floor(archive.length * 0.9)), /not a readable zip archive/)
  })

  it('restores an archive without digests (made before #493), with a warning', async () => {
    const legacy = altered((zip) => {
      const manifest = JSON.parse(zip.getEntry('backup.json')!.getData().toString('utf8')) as Record<string, unknown>
      delete manifest.parts
      zip.updateFile('backup.json', Buffer.from(JSON.stringify(manifest)))
    })
    await wipeInstance()
    const plan = await restoreBackup(legacy)
    expect(plan.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/no SHA-256 digests/)]))
    expect(await userCount()).toBe(1)
  })
})
