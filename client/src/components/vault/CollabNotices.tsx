import type { CollabSession } from '../../hooks/useCollabDoc.js'
import { RevokedNotice } from './RevokedNotice.js'
import { TooLargeNotice } from './TooLargeNotice.js'
import { UnmergedNotice } from './UnmergedNotice.js'

interface CollabNoticesProps {
  revoked: boolean
  tooLarge: CollabSession['tooLarge']
  unmerged: string | null
  onDiscard: () => void
}

/**
 * What the editor says about its collab session, above the note. A revocation
 * says it all. Otherwise a note too large to save and a copy from an earlier
 * session that could not be merged are both shown: hiding the copy until the
 * note fits would hide the only way to discard it.
 */
export function CollabNotices({ revoked, tooLarge, unmerged, onDiscard }: CollabNoticesProps) {
  if (revoked) return <RevokedNotice />
  if (!tooLarge && unmerged === null) return null
  return (
    <>
      {tooLarge && <TooLargeNotice limitBytes={tooLarge.limitBytes} bodyBytes={tooLarge.bodyBytes} />}
      {unmerged !== null && <UnmergedNotice text={unmerged} onDiscard={onDiscard} />}
    </>
  )
}
