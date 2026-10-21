// #484: edits hold the note's lock (`note:<vault>/<path>`), but rename, move,
// delete, restore and purge did not, so each could interleave with an edit or
// with another of them: an acknowledged edit overwritten by a rename's stale
// copy, or written back to the path the note had just left; two renames into
// one path where the loser's rollback unlinked the winner's file; a file left
// at a deleted note's path; a restore reported done on a note a purge removed.
//
// Every fs rename (the last step of an atomic write, and the moves to and from
// the trash) waits a beat, and writes onto the files in `fsHooks.late` wait
// longer, so each race is hit on every run rather than by chance. Real time on
// purpose: the writes hit real Postgres and disk, which fake timers cannot drive.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import type * as FsPromises from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { notes } from '../src/db/schema.js'
import { OkfValidationError, parseNote } from '../src/notes/okf.js'
import {
  createNote,
  getLiveNote,
  noteFile,
  purgeNote,
  readNote,
  renameNote,
  restoreNote,
  softDeleteNote,
  trashFile,
  updateNote,
  type NoteRow,
} from '../src/notes/store.js'
import { flushProjections } from '../src/notes/projector.js'
import { createActiveUser, loginCookie } from './helpers.js'

const fsHooks = vi.hoisted(() => ({
  /** Renames onto a file ending in one of these wait 80 ms instead of 10. */
  late: new Set<string>(),
  /** Started (not awaited) before the first rename onto a file ending in the key. */
  before: new Map<string, () => void>(),
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const to = String(args[1])
      for (const [suffix, hook] of fsHooks.before) {
        if (!to.endsWith(suffix)) continue
        fsHooks.before.delete(suffix)
        hook()
      }
      await sleep([...fsHooks.late].some((suffix) => to.endsWith(suffix)) ? 80 : 10)
      return actual.rename(...args)
    },
  }
})

let app: FastifyInstance
let vaultId: string

const ORIGINAL = 'The body before the race.'
const EDITED = 'The body an edit wrote during the race.'

type Settled<T> = PromiseSettledResult<T>
const settle = <T>(promise: Promise<T>): Promise<Settled<T>> => Promise.allSettled([promise]).then(([result]) => result!)
const value = <T>(result: Settled<T>): T => {
  if (result.status === 'rejected') throw result.reason
  return result.value
}

/** The note body in `file` once the projector has written every committed write (ADR-003 §7), or null when there is no such file. */
async function bodyIn(file: string): Promise<string | null> {
  await flushProjections()
  try {
    return parseNote(await readFile(file, 'utf8')).body
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

const fileBody = (path: string) => bodyIn(noteFile(vaultId, path))

const seed = (path: string, body = ORIGINAL) => createNote(vaultId, { path, body })

beforeAll(async () => {
  app = await buildApp()
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  vaultId = (
    await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'Lifecycle race vault' } })
  ).json().id
})

afterAll(async () => {
  await app.close()
})

describe('edit and rename of one note at the same time (#484)', () => {
  it('an edit started first ends up in the renamed note, and nothing is written at the old path', async () => {
    const from = 'docs/edit-then-rename'
    const to = 'docs/edit-then-rename-moved'
    await seed(from)
    fsHooks.late.add(`/${from}.md`)

    const [edit, rename] = await Promise.all([
      settle(updateNote(vaultId, from, { body: EDITED })),
      settle(renameNote(vaultId, from, 'edit-then-rename-moved')),
    ])

    expect(value(edit)).not.toBeNull()
    expect(value(rename)?.path).toBe(to)
    expect((await getLiveNote(vaultId, to))?.body).toBe(EDITED)
    expect(await fileBody(to)).toBe(EDITED)
    expect(await getLiveNote(vaultId, from)).toBeNull()
    expect(await fileBody(from)).toBeNull()
  }, 15_000)

  it('an edit started during a rename is refused or lands in the renamed note, never at the old path', async () => {
    const from = 'docs/rename-then-edit'
    const to = 'docs/rename-then-edit-moved'
    await seed(from)
    fsHooks.late.add(`/${from}.md`)

    const [rename, edit] = await Promise.all([
      settle(renameNote(vaultId, from, 'rename-then-edit-moved')),
      settle(updateNote(vaultId, from, { body: EDITED })),
    ])

    expect(value(rename)?.path).toBe(to)
    const expected = value(edit) === null ? ORIGINAL : EDITED
    expect((await getLiveNote(vaultId, to))?.body).toBe(expected)
    expect(await fileBody(to)).toBe(expected)
    expect(await fileBody(from)).toBeNull()
  }, 15_000)
})

describe('two writers making one path live at the same time (#484)', () => {
  it('two renames into one path: exactly one wins, and the winner keeps its file', async () => {
    const target = 'docs/contested'
    await seed('docs/contender-a', 'Contender A.')
    await seed('docs/contender-b', 'Contender B.')

    const results = await Promise.all([
      settle(renameNote(vaultId, 'docs/contender-a', 'contested')),
      settle(renameNote(vaultId, 'docs/contender-b', 'contested')),
    ])

    const won = results.flatMap((r, i) => (r.status === 'fulfilled' ? [i] : []))
    expect(won).toHaveLength(1)
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(lost.reason).toBeInstanceOf(OkfValidationError)
    expect(String(lost.reason.message)).toMatch(/already exists/)

    const [winner, loser] = won[0] === 0 ? ['a', 'b'] : ['b', 'a']
    const winnerBody = `Contender ${winner!.toUpperCase()}.`
    expect((await getLiveNote(vaultId, target))?.body).toBe(winnerBody)
    expect(await fileBody(target)).toBe(winnerBody)
    expect((await getLiveNote(vaultId, `docs/contender-${loser}`))?.body).toBe(`Contender ${loser!.toUpperCase()}.`)
    expect(await fileBody(`docs/contender-${loser}`)).toBe(`Contender ${loser!.toUpperCase()}.`)
    expect(await fileBody(`docs/contender-${winner}`)).toBeNull()
  }, 15_000)

  it('a create at the path a rename is moving into: exactly one wins, and the winner keeps its file', async () => {
    const target = 'docs/claimed'
    await seed('docs/claimant', 'Moved here by a rename.')
    let create: Promise<Settled<unknown>> | undefined
    // The create starts once the rename has checked the target is free and is writing its file.
    fsHooks.before.set(`/${target}.md`, () => {
      create = settle(createNote(vaultId, { path: target, body: 'Created here.' }))
    })

    const rename = await settle(renameNote(vaultId, 'docs/claimant', 'claimed'))
    const created = await create!

    expect([rename, created].filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const lost = [rename, created].find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(lost.reason).toBeInstanceOf(OkfValidationError)
    expect(String(lost.reason.message)).toMatch(/already exists/)
    const winnerBody = rename.status === 'fulfilled' ? 'Moved here by a rename.' : 'Created here.'
    expect((await getLiveNote(vaultId, target))?.body).toBe(winnerBody)
    expect(await fileBody(target)).toBe(winnerBody)
    if (rename.status === 'rejected') expect(await fileBody('docs/claimant')).toBe('Moved here by a rename.')
  }, 15_000)

  it('renames of two notes that link to each other, at the same time, both finish', async () => {
    // Each rewrites the other as a referrer. Under its own locks, each would
    // wait for the lock the other holds.
    await seed('docs/linked-x', 'Links to [[docs/linked-y]].')
    await seed('docs/linked-y', 'Links to [[docs/linked-x]].')

    const renamed = await Promise.all([
      renameNote(vaultId, 'docs/linked-x', 'linked-x2'),
      renameNote(vaultId, 'docs/linked-y', 'linked-y2'),
    ])

    expect(renamed.map((row) => row?.path)).toEqual(['docs/linked-x2', 'docs/linked-y2'])
  }, 15_000)
})

describe('delete, restore and purge against other writes (#484)', () => {
  it('an edit and a delete at the same time leave no file at the deleted path, and the trash holds the stored body', async () => {
    const path = 'docs/edited-while-deleted'
    const created = await seed(path)
    fsHooks.late.add(`/${path}.md`)

    const [edit, deleted] = await Promise.all([
      settle(updateNote(vaultId, path, { body: EDITED })),
      settle(softDeleteNote(vaultId, path)),
    ])

    expect(value(deleted)?.id).toBe(created.id)
    const expected = value(edit) === null ? ORIGINAL : EDITED
    const [row] = await db.select().from(notes).where(eq(notes.id, created.id))
    expect(row?.deletedAt).not.toBeNull()
    expect(row?.body).toBe(expected)
    expect(await bodyIn(trashFile(vaultId, created.id))).toBe(expected)
    expect(await fileBody(path)).toBeNull()
  }, 15_000)

  it('a restore and a purge at the same time: exactly one acts, and the note is either live with its file or gone', async () => {
    const path = 'docs/restored-while-purged'
    const created = await seed(path)
    await softDeleteNote(vaultId, path)

    const [restore, purge] = await Promise.all([
      settle(restoreNote(vaultId, created.id)),
      settle(purgeNote(vaultId, created.id)),
    ])

    const restored = value(restore) !== null
    const purged = value(purge)
    expect([restored, purged].filter(Boolean)).toHaveLength(1)
    const [row] = await db.select().from(notes).where(eq(notes.id, created.id))
    if (restored) {
      expect(row?.deletedAt).toBeNull()
      expect((await readNote(vaultId, path))?.body).toBe(ORIGINAL)
      expect(await fileBody(path)).toBe(ORIGINAL)
    } else {
      expect(row).toBeUndefined()
      expect(await fileBody(path)).toBeNull()
    }
    expect(await bodyIn(trashFile(vaultId, created.id))).toBeNull()
  }, 15_000)
})

describe('renames of notes that link to each other, at the same time (#803)', () => {
  // A rename rewrites the links in the notes that link to it after its locks
  // are released. It found them by path and skipped one with no note there,
  // so a referrer the other rename had moved kept the old link, and it wrote
  // a body read before the other rename's rewrite of the same note landed.
  const seedPair = async (name: string) => {
    await seed(`docs/${name}-x`, `Links to [[docs/${name}-y]].`)
    await seed(`docs/${name}-y`, `Links to [[docs/${name}-x]].`)
  }

  async function expectLinkedAtNewPaths(name: string) {
    for (const [note, other] of [
      ['x2', 'y2'],
      ['y2', 'x2'],
    ]) {
      const body = `Links to [[docs/${name}-${other}]].`
      expect((await getLiveNote(vaultId, `docs/${name}-${note}`))?.body).toBe(body)
      expect(await fileBody(`docs/${name}-${note}`)).toBe(body)
    }
  }

  it('each renamed note links the other at its new path', async () => {
    const names = ['pair-1', 'pair-2', 'pair-3']
    for (const name of names) await seedPair(name)

    await Promise.all(
      names.flatMap((name) => [
        renameNote(vaultId, `docs/${name}-x`, `${name}-x2`),
        renameNote(vaultId, `docs/${name}-y`, `${name}-y2`),
      ]),
    )

    for (const name of names) await expectLinkedAtNewPaths(name)
  }, 15_000)

  it('a rewrite queued behind the other rename finds the moved note at its new path', async () => {
    await seedPair('queued')
    // y's move holds y's lock while x's rewrite of y waits for it.
    fsHooks.late.add('/docs/queued-y2.md')

    await Promise.all([
      renameNote(vaultId, 'docs/queued-x', 'queued-x2'),
      renameNote(vaultId, 'docs/queued-y', 'queued-y2'),
    ])

    await expectLinkedAtNewPaths('queued')
  }, 15_000)

  it('a note linking both renamed notes keeps both rewritten links', async () => {
    await seed('docs/hub-x', 'X.')
    await seed('docs/hub-y', 'Y.')
    await seed('docs/hub', 'Links to [[docs/hub-x]] and [[docs/hub-y]].')
    // The first rewrite of the hub lands late: the second reads the hub meanwhile.
    fsHooks.late.add('/docs/hub.md')

    await Promise.all([renameNote(vaultId, 'docs/hub-x', 'hub-x2'), renameNote(vaultId, 'docs/hub-y', 'hub-y2')])

    const body = 'Links to [[docs/hub-x2]] and [[docs/hub-y2]].'
    expect((await getLiveNote(vaultId, 'docs/hub'))?.body).toBe(body)
    expect(await fileBody('docs/hub')).toBe(body)
  }, 15_000)

  it('a note renamed again while its first rename rewrites a link ends up linked at its newest path', async () => {
    await seed('docs/chain', 'Renamed twice.')
    await seed('docs/chain-referrer', 'Links to [[docs/chain]].')
    let second: Promise<NoteRow | null> | undefined
    // The second rename looks for links to chain-2 while the first one's
    // rewrite of the referrer is landing, before its links are stored.
    fsHooks.late.add('/docs/chain-referrer.md')
    fsHooks.before.set('/docs/chain-referrer.md', () => {
      second = renameNote(vaultId, 'docs/chain-2', 'chain-3')
    })

    await renameNote(vaultId, 'docs/chain', 'chain-2')
    expect((await second)?.path).toBe('docs/chain-3')

    const body = 'Links to [[docs/chain-3]].'
    expect((await getLiveNote(vaultId, 'docs/chain-referrer'))?.body).toBe(body)
    expect(await fileBody('docs/chain-referrer')).toBe(body)
  }, 15_000)
})
