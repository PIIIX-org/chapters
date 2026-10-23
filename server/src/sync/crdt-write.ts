import { applyBodyOps, applyFrontmatterOps, isFrontmatterOp, NoteEditError, type EditOp } from './edit-ops.js'
import { mergeFrontmatter, mergeText, type LineChange } from './three-way-merge.js'
import {
  recordProposal,
  refuseSuspiciousWrite,
  keptBody,
  writeNote,
  type Actor,
  type BodyEdit,
  type NoteRow,
  type RecordKey,
  type WriteOutcome,
  type WrittenNote,
} from '../notes/store.js'
import { NoteWriteWouldQuarantineError, suspiciousWrite, type QuarantineRules } from '../notes/growth-guard.js'
import { assertBodyFits } from '../notes/size-cap.js'
import { OkfValidationError, validateNote, type Frontmatter } from '../notes/okf.js'

/** Where an edit and the changes made since its base revision meet (#475): body lines and frontmatter keys. */
export interface EditChanges {
  /** Lines numbered in the body the edit met: the live note just before it. */
  lines?: LineChange[]
  frontmatterKeys?: string[]
}

/**
 * An edit made from an older revision that overlaps changes made since then
 * (#475): nothing was written, and the edit is kept as a `proposal` revision
 * (`proposalId`; null for a `dry_run`, #477, which keeps nothing).
 */
export class NoteEditConflictError extends Error {
  readonly statusCode = 409
  constructor(
    readonly path: string,
    readonly proposalId: string | null,
    readonly conflicts: EditChanges,
  ) {
    super(
      proposalId
        ? `edit of ${path} overlaps changes made since its base revision; kept as proposal ${proposalId}`
        : `edit of ${path} overlaps changes made since its base revision (dry run: nothing kept)`,
    )
  }
}

/** The revision an edit was made from (edit_note `base_rev`, #475). */
export interface EditBase {
  id: string
  frontmatter: Record<string, unknown>
  body: string
}

/** What a write with a base did (#475): `merged` when the note had changed since the base. */
export interface WriteReport {
  status?: 'applied' | 'merged'
  concurrentChanges?: EditChanges
}

/** One write to a note. A field left out keeps its current value. */
export interface NoteEdit {
  frontmatter?: Record<string, unknown>
  /**
   * The new body, or a function of the current one (a rename's link rewrite,
   * #803), applied to the live document's text, or by updateNote under the
   * note's lock when no document is loaded.
   */
  body?: BodyEdit
  /**
   * How `frontmatter` applies. `replace` (the default, for writers that hold
   * the note's whole state: revert, rename, the collab store) swaps the whole
   * map; `merge` (edit_note and REST PUT, #438) sets only the top-level keys
   * given and keeps the others.
   */
  frontmatterMode?: 'replace' | 'merge'
  /** Top-level frontmatter keys to delete, after `frontmatter` is applied. */
  removeKeys?: string[]
  /**
   * `edit_note` ops (#408), after `frontmatter` and `removeKeys`: body ops
   * resolve against the live text when the edit is applied, frontmatter ops
   * against the merged map. Never together with `body`.
   */
  ops?: EditOp[]
  /**
   * The revision `body`, `frontmatter` and `removeKeys` were made from (#475):
   * they are three-way merged onto the live note (rebase), and an edit that
   * overlaps a change made since is kept as a proposal instead.
   */
  base?: EditBase
}

/**
 * The edit an `edit_note` or REST PUT caller asked for (#438): `frontmatter`
 * merges per top-level key unless `replace` is true, and `removeKeys` deletes
 * keys; `ops` (#408) make local changes instead of replacing the body.
 * Arguments that contradict each other are refused rather than guessed.
 */
export function requestedEdit(args: {
  frontmatter?: Record<string, unknown>
  body?: string
  replace?: boolean
  removeKeys?: string[]
  ops?: EditOp[]
}): NoteEdit {
  if (args.replace === true && args.frontmatter === undefined) {
    throw new NoteEditError('`replace: true` needs `frontmatter`, the map that replaces the whole frontmatter')
  }
  if (args.ops !== undefined && args.body !== undefined) {
    throw new NoteEditError('`ops` and `body` cannot be combined: `body` replaces the whole body; send one or the other')
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
    ops: args.ops,
  }
}

/**
 * The note's frontmatter after `edit`, or undefined when the edit leaves the
 * frontmatter alone. A merge is shallow: a key's value (a nested map too) is
 * replaced whole, and `null` is a value like any other; only `removeKeys`
 * and `frontmatter_remove` delete. Frontmatter ops apply last, in order.
 * `type` always stays the note's type, as `updateNote` enforces.
 */
function nextFrontmatter(current: Record<string, unknown>, edit: NoteEdit, type: string): Frontmatter | undefined {
  if (edit.frontmatter === undefined && !edit.removeKeys?.length && !edit.ops?.some(isFrontmatterOp)) return undefined
  const next: Record<string, unknown> =
    edit.frontmatterMode === 'merge' ? { ...current, ...edit.frontmatter } : { ...(edit.frontmatter ?? current) }
  for (const key of edit.removeKeys ?? []) delete next[key]
  return { ...applyFrontmatterOps(next, edit.ops ?? []), type }
}

/** An edit rebased onto the live note (#475): the state to write and what happened since the base, or what it overlaps. */
type Rebased = { frontmatter?: Frontmatter; body?: string; report: WriteReport } | { conflicts: EditChanges }

/**
 * `edit`, made from `edit.base`, three-way merged onto the live note (#475):
 * a `body` per line (mergeText), `frontmatter` and `removeKeys` per key on
 * the map they make from the base's (mergeFrontmatter); `ops` still resolve
 * against the live text and map, as without a base. Returns the state to
 * write (a field left undefined is not changed) with the changes made since
 * the base, or the changes of the edit's that overlap them.
 */
function rebase(edit: NoteEdit & { base: EditBase }, live: { frontmatter: Record<string, unknown>; body: string }, type: string): Rebased {
  const { base } = edit
  const text = mergeText(base.body, live.body, typeof edit.body === 'string' ? edit.body : base.body)
  const wanted = nextFrontmatter(base.frontmatter, { ...edit, ops: undefined }, type)
  const frontmatter = mergeFrontmatter(base.frontmatter, live.frontmatter, wanted ?? base.frontmatter)
  const conflicts: EditChanges = {}
  if (text.text === null) conflicts.lines = text.conflicts
  if (frontmatter.conflicts.length > 0) conflicts.frontmatterKeys = frontmatter.conflicts
  if (text.text === null || conflicts.frontmatterKeys) return { conflicts }
  const concurrent: EditChanges = {}
  if (text.concurrent.length > 0) concurrent.lines = text.concurrent
  if (frontmatter.concurrent.length > 0) concurrent.frontmatterKeys = frontmatter.concurrent
  return {
    frontmatter: wanted ? { ...applyFrontmatterOps(frontmatter.frontmatter, edit.ops ?? []), type } : nextFrontmatter(live.frontmatter, edit, type),
    body: typeof edit.body === 'string' ? text.text : undefined,
    report: concurrent.lines || concurrent.frontmatterKeys ? { status: 'merged', concurrentChanges: concurrent } : { status: 'applied' },
  }
}

/**
 * Keeps `edit`, which overlaps changes made since its base (#475), as a
 * proposal revision instead of writing it: the note as the edit would have
 * it. The frontmatter is its `frontmatter` and `removeKeys` applied to the
 * base's, then its frontmatter ops; the body is its `body`, or its body ops
 * applied to `liveBody` (ops always resolve against the live text; one that
 * does not resolve refuses the edit, as without a conflict), or else the
 * base's. Always throws.
 */
async function propose(
  note: NoteRow,
  edit: NoteEdit & { base: EditBase },
  actor: Actor,
  conflicts: EditChanges,
  liveBody: string,
  dryRun: boolean,
): Promise<never> {
  const { base } = edit
  const ops = edit.ops ?? []
  let body = base.body
  if (typeof edit.body === 'string') body = edit.body
  else if (ops.some((op) => !isFrontmatterOp(op))) body = applyBodyOps(liveBody, ops, note.body)
  if (dryRun) throw new NoteEditConflictError(note.path, null, conflicts)
  const wanted = nextFrontmatter(base.frontmatter, { ...edit, ops: undefined }, note.type) ?? base.frontmatter
  const proposal = { frontmatter: { ...applyFrontmatterOps(wanted, ops), type: note.type }, body }
  throw new NoteEditConflictError(note.path, await recordProposal(note.id, proposal, actor, base.id), conflicts)
}

/**
 * One agent or REST write (edit_note, REST PUT, revert, a rename's referrer
 * rewrite) through the transactional store (ADR-003 §5.2, `writeNote`).
 * There is no relay connection any more (§5.1: a writer holding the note's
 * lock never waits for the relay's store hook, which a `DirectConnection`'s
 * disconnect does): the edit is computed against what the editors see (the
 * relay's loaded document, else the row), committed with its own revision
 * attributed to `actor` (#403), and then pushed into the loaded document as
 * a minimal character diff (#408): characters the edit does not change keep
 * their identity, so a person typing outside the changed region keeps their
 * text and caret, and typing that reaches the relay meanwhile merges where it
 * was typed. Body ops resolve against that same text, so text typed since
 * the caller read the note is kept; one that cannot be resolved refuses the
 * whole edit before anything changes.
 *
 * A merge (#438) starts from the current frontmatter, which may hold keys a
 * person set that the relay has not stored yet. The result is validated
 * before anything is written, so a refused edit never reaches anyone.
 *
 * The size cap (#491) and `options.quarantine` (MCP edit_note, REST PUT
 * without `allowGrowth`) check the resulting body against the stored one
 * first: a suspicious write (#492) is recorded as a quarantine revision and
 * thrown, and editors never see it.
 *
 * An edit with a `base` (edit_note `base_rev`, #475) was made from an older
 * revision: its body and frontmatter are three-way merged onto the current
 * note (rebase), so only the lines and keys it changed from its base are
 * written and every change made since stays. When one of its changes
 * overlaps a change made since, nothing is written: it is kept as a
 * `proposal` revision and NoteEditConflictError is thrown.
 * `options.report` receives whether the note had changed since the base, and
 * where. `options.revertOf` (revertNote) records the write as a `revert`
 * event naming that revision (#479). `options.dryRun` (#477) computes the
 * result and refuses as the write would, but writes nothing: no proposal or
 * quarantine revision either. `options.outcome` receives the state the write
 * changed (writeNote).
 */
export async function writeThroughCollab(
  vaultId: string,
  path: string,
  input: NoteEdit,
  actor: Actor,
  options: {
    quarantine?: QuarantineRules
    revertOf?: string
    report?: WriteReport
    actorDetail?: Record<string, unknown>
    dryRun?: boolean
    outcome?: WriteOutcome
    recordKey?: RecordKey
  } = {},
): Promise<WrittenNote | null> {
  const dryRun = options.dryRun === true
  const ops = input.ops ?? []
  const bodyOps = ops.some((op) => !isFrontmatterOp(op))
  const based = input.base ? { ...input, base: input.base } : null
  return writeNote(
    vaultId,
    path,
    async (current, existing) => {
      const merged = based ? rebase(based, current, existing.type) : null
      if (based && merged && 'conflicts' in merged) return propose(existing, based, actor, merged.conflicts, current.body, dryRun)
      const rebased = merged && !('conflicts' in merged) ? merged : null
      // An edit that leaves the body alone keeps what the editors see, unless
      // the relay would refuse to store it (a doubled document, #488/#492):
      // then the stored body, so the agent's write never carries it in.
      let body = keptBody(existing, current)
      let screened = false
      if (bodyOps) {
        body = applyBodyOps(current.body, ops, existing.body)
        screened = true
      } else if (typeof input.body === 'function') {
        // Applied to the current text, which may hold typing not stored yet, and checked against it (#491).
        body = input.body(current.body)
        assertBodyFits(body, current.body)
      } else if (rebased) {
        if (rebased.body !== undefined) {
          body = rebased.body
          screened = true
        }
      } else if (input.body !== undefined) {
        body = input.body
        screened = true
      }
      if (screened) {
        // Before anything is written: a refused body must never reach the editors (#491, #492).
        assertBodyFits(body, existing.body)
        if (options.quarantine) {
          const next = { frontmatter: nextFrontmatter(current.frontmatter, input, existing.type), body }
          if (dryRun) {
            const finding = suspiciousWrite(existing.body, body, options.quarantine)
            if (finding) throw new NoteWriteWouldQuarantineError(existing.path, finding)
          } else {
            await refuseSuspiciousWrite(existing, next, actor, options.quarantine)
          }
        }
      }
      const frontmatter = (rebased ? rebased.frontmatter : nextFrontmatter(current.frontmatter, input, existing.type)) ?? {
        ...current.frontmatter,
        type: existing.type,
      }
      try {
        validateNote(existing.type, existing.name, frontmatter, body)
      } catch (err) {
        throw explainInheritedKeys(err, current.frontmatter, input, (candidate) => validateNote(existing.type, existing.name, candidate, body), frontmatter)
      }
      if (rebased && options.report) Object.assign(options.report, rebased.report)
      return { frontmatter, body }
    },
    actor,
    { revertOf: options.revertOf, actorDetail: options.actorDetail, dryRun, outcome: options.outcome, recordKey: options.recordKey },
  )
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
    err.refusal,
    err.rule,
  )
}
