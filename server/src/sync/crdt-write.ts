import { isDeepStrictEqual } from 'node:util'
import type { DirectConnection } from '@hocuspocus/server'
import { YAMLParseError } from 'yaml'
import { getCollab } from './collab-server.js'
import { getLiveNote, readNote, refuseSuspiciousWrite, resolveNotePath, updateNote, type Actor, type NoteRow } from '../notes/store.js'
import type { QuarantineRules } from '../notes/growth-guard.js'
import { assertBodyFits } from '../notes/size-cap.js'
import { OkfValidationError, validateNote, type Frontmatter } from '../notes/okf.js'
import { withKeyLock } from '../notes/key-lock.js'

/** A partial write to a note whose file cannot be parsed (#391). 409 over REST. */
export class NoteFileDamagedError extends Error {
  readonly statusCode = 409
  constructor(path: string) {
    super(
      `note file for ${path} is damaged and cannot be read; repair it by writing both frontmatter and body, or by reverting to a recorded revision`,
    )
  }
}

/** Contradictory edit arguments (#438). 400 over REST. */
export class NoteEditError extends Error {
  readonly statusCode = 400
}

/** One write to a note. A field left out keeps its current value. */
export interface NoteEdit {
  frontmatter?: Record<string, unknown>
  body?: string
  /**
   * How `frontmatter` applies. `replace` (the default, for writers that hold
   * the note's whole state: revert, rename, the collab store) swaps the whole
   * map; `merge` (edit_note and REST PUT, #438) sets only the top-level keys
   * given and keeps the others.
   */
  frontmatterMode?: 'replace' | 'merge'
  /** Top-level frontmatter keys to delete, after `frontmatter` is applied. */
  removeKeys?: string[]
}

/**
 * The edit an `edit_note` or REST PUT caller asked for (#438): `frontmatter`
 * merges per top-level key unless `replace` is true, and `removeKeys` deletes
 * keys. Arguments that contradict each other are refused rather than guessed.
 */
export function requestedEdit(args: {
  frontmatter?: Record<string, unknown>
  body?: string
  replace?: boolean
  removeKeys?: string[]
}): NoteEdit {
  if (args.replace === true && args.frontmatter === undefined) {
    throw new NoteEditError('`replace: true` needs `frontmatter`, the map that replaces the whole frontmatter')
  }
  const { frontmatter } = args
  const conflicting = (args.removeKeys ?? []).filter((key) => frontmatter !== undefined && Object.hasOwn(frontmatter, key))
  if (conflicting.length > 0) {
    throw new NoteEditError(
      `frontmatter key ${conflicting.map((key) => `"${key}"`).join(', ')} is both set in \`frontmatter\` and listed in \`removeKeys\``,
    )
  }
  return {
    frontmatter,
    body: args.body,
    frontmatterMode: args.replace === true ? 'replace' : 'merge',
    removeKeys: args.removeKeys,
  }
}

/**
 * The note's frontmatter after `edit`, or undefined when the edit leaves the
 * frontmatter alone. A merge is shallow: a key's value (a nested map too) is
 * replaced whole, and `null` is a value like any other; only `removeKeys`
 * deletes. `type` always stays the note's type, as `updateNote` enforces.
 */
function nextFrontmatter(current: Record<string, unknown>, edit: NoteEdit, type: string): Frontmatter | undefined {
  if (edit.frontmatter === undefined && !edit.removeKeys?.length) return undefined
  const next: Record<string, unknown> =
    edit.frontmatterMode === 'merge' ? { ...current, ...edit.frontmatter } : { ...(edit.frontmatter ?? current) }
  for (const key of edit.removeKeys ?? []) delete next[key]
  return { ...next, type }
}

/** True when the note's file exists but does not parse; an I/O failure is rethrown. */
async function noteFileDamaged(vaultId: string, path: string): Promise<boolean> {
  try {
    await readNote(vaultId, path)
    return false
  } catch (err) {
    if (err instanceof OkfValidationError || err instanceof YAMLParseError) return true
    throw err
  }
}

/**
 * Note writes flow through the live CRDT engine when it's running (spec 6:
 * an external/REST/AI edit is a visible participant, never a sudden unexplained
 * change, and in-memory Yjs documents must not clobber external writes). The
 * attributed store write happens immediately here; the relay's debounced store
 * of the same state dedupes in the audit trail.
 *
 * A merge (#438) starts from the live document's frontmatter, which may hold
 * keys a person set that are not stored yet; without the relay it starts from
 * the stored row. The result is validated before the document is touched, so
 * a refused edit never reaches people with the note open, and the store gets
 * the whole resulting map.
 *
 * Writes to one note run one at a time, in call order: the document edit, the
 * relay's store of it and the attributed store write form one unit, so a
 * concurrent write can neither interleave its document edit nor land its store
 * write in between. (The store write takes its own, separate note lock.)
 *
 * `options.quarantine` (MCP edit_note, REST PUT without `allowGrowth`) checks
 * the body against the stored one before it reaches the live document: a
 * suspicious write (#492) is recorded as a quarantine revision and thrown,
 * and editors never see it. When this edit replaces the body, the relay's
 * own store of the document it produces is not checked again (`directWrite`
 * in its context): the caller here decided. A frontmatter-only edit leaves
 * the body to the relay's check. `options.revertOf` (revertNote) records the
 * attributed store write as a `revert` event naming that revision (#479).
 */
export async function writeThroughCollab(
  vaultId: string,
  path: string,
  input: NoteEdit,
  actor: Actor,
  options: { quarantine?: QuarantineRules; revertOf?: string } = {},
): Promise<NoteRow | null> {
  const record = { revertOf: options.revertOf }
  return withKeyLock(`collab:${vaultId}/${resolveNotePath(path).fullPath}`, async () => {
    const existing = await getLiveNote(vaultId, path)
    if (!existing) return null
    // Before the document edit: a refused body must never reach the editors (#491).
    if (input.body !== undefined) assertBodyFits(input.body, existing.body)
    const storedFrontmatter = existing.frontmatter as Record<string, unknown>
    if (options.quarantine) {
      const frontmatter = nextFrontmatter(storedFrontmatter, input, existing.type)
      await refuseSuspiciousWrite(existing, { frontmatter, body: input.body }, actor, options.quarantine)
    }
    const collab = getCollab()
    if (!collab) {
      const frontmatter = nextFrontmatter(storedFrontmatter, input, existing.type)
      return updateNote(vaultId, path, { frontmatter, body: input.body }, actor, record)
    }
    let connection: DirectConnection
    try {
      connection = await collab.openDirectConnection(`${vaultId}/${path}`, {
        userId: actor.type === 'user' ? actor.id : 'mcp',
        directWrite: input.body !== undefined,
      })
    } catch (err) {
      // Loading the collab document parses the note's file. When the file is
      // damaged (e.g. #384's fence-less index), no document can load, so no
      // live editor holds one: a full write (edit with frontmatter and body,
      // or a revert) is written straight to the store, which rewrites, and so
      // repairs, the file; a frontmatter merge merges onto the stored row. A
      // body-only or frontmatter-only write would have to keep content that
      // cannot be read.
      if (!(await noteFileDamaged(vaultId, path))) throw err
      if (input.frontmatter === undefined || input.body === undefined) throw new NoteFileDamagedError(path)
      const frontmatter = nextFrontmatter(storedFrontmatter, input, existing.type)
      return updateNote(vaultId, path, { frontmatter, body: input.body }, actor, record)
    }
    const next: { frontmatter?: Frontmatter } = {}
    try {
      await connection.transact((document) => {
        const fm = document.getMap('frontmatter')
        const current = fm.toJSON() as Record<string, unknown>
        next.frontmatter = nextFrontmatter(current, input, existing.type)
        const nextNote = next.frontmatter ?? { ...storedFrontmatter, type: existing.type }
        const body = input.body ?? existing.body
        try {
          validateNote(existing.type, existing.name, nextNote, body)
        } catch (err) {
          throw explainInheritedKeys(err, current, input, (candidate) => validateNote(existing.type, existing.name, candidate, body), nextNote)
        }
        if (input.body !== undefined) {
          const text = document.getText('body')
          text.delete(0, text.length)
          text.insert(0, input.body)
        }
        if (next.frontmatter !== undefined) {
          for (const key of Object.keys(current)) if (!Object.hasOwn(next.frontmatter, key)) fm.delete(key)
          for (const [key, value] of Object.entries(next.frontmatter)) {
            if (!isDeepStrictEqual(current[key], value)) fm.set(key, value)
          }
        }
      })
    } finally {
      await connection.disconnect()
    }
    return updateNote(vaultId, path, { frontmatter: next.frontmatter, body: input.body }, actor, record)
  })
}

/**
 * A merge can fail on a key the caller never sent: the live document may
 * hold a value a person typed that the relay refused to store (it keeps the
 * last valid file). Name such keys, and the ways out, instead of leaving the
 * caller with an error about a key it did not touch. Any other error is
 * returned unchanged.
 */
function explainInheritedKeys(
  err: unknown,
  current: Record<string, unknown>,
  edit: NoteEdit,
  validate: (frontmatter: Frontmatter) => void,
  merged: Frontmatter,
): unknown {
  if (!(err instanceof OkfValidationError) || edit.frontmatterMode !== 'merge') return err
  const inherited = Object.keys(current).filter(
    (key) => key !== 'type' && Object.hasOwn(merged, key) && !(edit.frontmatter && Object.hasOwn(edit.frontmatter, key)),
  )
  const culprits = inherited.filter((key) => {
    const without: Frontmatter = { ...merged }
    delete without[key]
    try {
      validate(without)
      return true
    } catch {
      return false
    }
  })
  if (culprits.length === 0) return err
  const keys = culprits.map((key) => `"${key}"`).join(', ')
  return new OkfValidationError(
    `${err.message} (frontmatter ${keys} is already on the note, not in this edit; send a valid value, list it in \`removeKeys\`, or pass \`replace: true\` with the whole map)`,
  )
}
