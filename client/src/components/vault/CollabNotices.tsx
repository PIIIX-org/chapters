import type { CollabSession } from '../../hooks/useCollabDoc.js'
import { NoteDeletedNotice } from './NoteDeletedNotice.js'
import { NotMigratedNotice } from './NotMigratedNotice.js'
import { ReloadRequiredNotice } from './ReloadRequiredNotice.js'
import { RevokedNotice } from './RevokedNotice.js'
import { TooLargeNotice } from './TooLargeNotice.js'
import { UnmergedNotice } from './UnmergedNotice.js'

interface CollabNoticesProps {
  revoked: boolean
  /** The relay refused the note: the server's store migration has not processed it yet. */
  notMigrated?: boolean
  /** The relay refused this tab's document name: the page must reload (ADR-003 §5.4). */
  reloadRequired?: boolean
  /** The note was deleted or purged while open (close reason `note-deleted`). */
  deleted?: boolean
  tooLarge: CollabSession['tooLarge']
  unmerged: string | null
  onDiscard: () => void
}

/**
 * What the editor says about its collab session, above the note. A revocation
 * says it all, and so do a note the store migration has not processed and a
 * tab that must reload. Otherwise a note too large to save and a copy from
 * an earlier session that could not be merged are both shown: hiding the
 * copy until the note fits would hide the only way to discard it.
 */
export function CollabNotices({ revoked, notMigrated = false, reloadRequired = false, deleted = false, tooLarge, unmerged, onDiscard }: CollabNoticesProps) {
  if (revoked) return <RevokedNotice />
  if (deleted) return <NoteDeletedNotice />
  if (reloadRequired) return <ReloadRequiredNotice />
  if (notMigrated) return <NotMigratedNotice />
  if (!tooLarge && unmerged === null) return null
  return (
    <>
      {tooLarge && <TooLargeNotice limitBytes={tooLarge.limitBytes} bodyBytes={tooLarge.bodyBytes} />}
      {unmerged !== null && <UnmergedNotice text={unmerged} onDiscard={onDiscard} />}
    </>
  )
}
