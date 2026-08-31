import { useEffect, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { useNavigate, useOutletContext, useParams } from 'react-router'
import { EditorView } from '@codemirror/view'
import { useNote } from '../../hooks/useNote.js'
import { useCreateNote } from '../../hooks/useCreateNote.js'
import { useVaultTree } from '../../hooks/useVaultTree.js'
import { useCodeMirrorEditor } from '../../hooks/useCodeMirrorEditor.js'
import { useCollabDoc } from '../../hooks/useCollabDoc.js'
import { useLiveNote } from '../../hooks/useLiveNote.js'
import type { LiveStatus } from '../../hooks/useLiveNote.js'
import { useSession } from '../../hooks/useSession.js'
import { canEdit } from '../../api/vaults.js'
import type { Vault, VaultAccess } from '../../api/vaults.js'
import { CollabPropertyPanel, LivePropertyPanel } from '../../components/vault/PropertyPanel.js'
import { CollabStatusLine } from '../../components/vault/CollabStatusLine.js'
import { CollaboratorAvatars } from '../../components/vault/CollaboratorAvatars.js'
import { NoteActions } from '../../components/vault/NoteActions.js'
import { RevokedNotice } from '../../components/vault/RevokedNotice.js'
import { RevisionHistory } from '../../components/vault/RevisionHistory.js'
import { SharingPanel } from '../../components/vault/SharingPanel.js'
import { Inspector } from '../../components/shell/ShellPanels.js'
import { Pill } from '../../components/ui/pill.js'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js'
import { handleWikilinkClick } from '../../lib/handleWikilinkClick.js'

/**
 * Neither path saves through the notes API any more. Editors' keystrokes go
 * into the Y.Text and the relay persists it; readers make none. The debounced
 * `PUT` this file used to run *was* issue #66, and against a CRDT it would
 * clobber merged text with one client's snapshot.
 *
 * `useCodeMirrorEditor` never calls this when a `ytext` is bound; it exists
 * because the option is required.
 */
const NO_SAVE = () => {}

export function NoteView() {
  const { vaultId } = useParams<{ vaultId: string }>()
  const path = useParams()['*']
  const vault = useOutletContext<Vault | undefined>()
  const note = useNote(vaultId!, path!)

  // Conservative default: unknown access (vault undefined) => reader.
  // `canEdit(vault.access)` is what picks the transport, and that is the
  // audit's presence rule, not a performance choice: readers never join the
  // Yjs document, so they have no awareness and no identity in it at all.
  const editable = canEdit(vault?.access)

  /**
   * Which transport this note is open on. Decided from `editable` once per
   * vault and then held — deliberately not re-read every render.
   *
   * `useVaults` refetches on window focus, so a revocation arrives here as a
   * prop change mid-session. Acting on it by swapping the path (or by keying
   * the child on `editable`, which this file used to do) unmounts
   * `CollabNote`, `useCollabDoc`'s cleanup destroys the `Y.Doc`, and every
   * character typed since the last sync is gone — repainted over by the stale
   * REST body, with no warning and nothing to copy out. Losing unsaved work is
   * the one thing this must never do, so an access change downgrades the
   * session in place instead: locked editor plus the revoked notice, which is
   * exactly what the relay's kick already does without destroying the
   * document.
   *
   * *Gaining* access is safe to act on immediately — a reader has nothing
   * unsent.
   *
   * The decision is held per NOTE, not per vault. What it protects is an open
   * document with unsent characters in it; navigating to a different note
   * leaves nothing to protect, so that note decides afresh from current
   * access. Holding it per vault instead made the downgrade sticky: after one
   * revocation, every *other* note in that vault also opened on the collab
   * path, where the relay refuses the connection and the reader gets a blank
   * body under an "access removed" notice.
   */
  const noteKey = `${vaultId}/${path}`
  const [session, setSession] = useState({ noteKey, editing: editable })
  if (session.noteKey !== noteKey) setSession({ noteKey, editing: editable })
  else if (editable && !session.editing) setSession({ noteKey, editing: true })

  if (note.isPending) return null
  if (note.isError) return <div className="p-8 text-muted-foreground">Note not found.</div>

  // Remount key is the full note identity (vault + path), and nothing else:
  // keying on path alone would reuse a stale editor across a cross-vault
  // switch to the same path, and keying on access would destroy a live
  // document the moment access changed. See `session` above.
  const key = noteKey

  return session.editing ? (
    <CollabNote
      key={key}
      vaultId={vaultId!}
      path={path!}
      vaultName={vault?.name}
      accessRevoked={!editable}
      initialBody={note.data!.body}
      access={vault?.access ?? 'read'}
    />
  ) : (
    <LiveNote
      key={key}
      vaultId={vaultId!}
      path={path!}
      vaultName={vault?.name}
      initialFrontmatter={note.data!.frontmatter}
      initialBody={note.data!.body}
    />
  )
}

interface NoteFrameProps {
  /** The 40px note bar over the editor: path, status, presence, actions. */
  bar: ReactNode
  /** Sits between the note bar and the editor, in the flow — never over
   *  the document, which is where the unsent text is. */
  notice?: ReactNode
  editorRef: RefObject<HTMLDivElement | null>
  /** The inspector tabs for this note (Properties · History · Sharing). */
  inspector: ReactNode
}

function NoteFrame({ bar, notice, editorRef, inspector }: NoteFrameProps) {
  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        {/* min-h-10, not h-10: an inline rename form wraps to a second row
            instead of clipping inside the bar. */}
        <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-1">
          {bar}
        </div>
        {notice}
        <div ref={editorRef} className="min-h-0 min-w-0 flex-1 overflow-auto" />
      </div>
      <Inspector label="Note" className="min-h-0">
        {inspector}
      </Inspector>
    </>
  )
}

/** The note bar's path: `vault / path`, mono like every machine label. */
function NotePath({ vaultName, vaultId, path }: { vaultName: string | undefined; vaultId: string; path: string }) {
  return (
    <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
      {vaultName ?? vaultId} / <span className="text-foreground">{path}</span>
    </span>
  )
}

interface NoteInspectorProps {
  properties: ReactNode
  history: ReactNode
  /** Owner-only: shares are the owner's to grant, so nobody else gets the tab. */
  sharing?: ReactNode
}

/** The note's detail, as inspector tabs — the property panel, the revision
 *  history and (for the owner) sharing all fold in here. */
function NoteInspector({ properties, history, sharing }: NoteInspectorProps) {
  return (
    <Tabs defaultValue="properties" className="flex min-h-0 flex-1 flex-col">
      <TabsList>
        <TabsTrigger value="properties">Properties</TabsTrigger>
        <TabsTrigger value="history">History</TabsTrigger>
        {sharing != null && <TabsTrigger value="sharing">Sharing</TabsTrigger>}
      </TabsList>
      <TabsContent value="properties" className="flex-1 overflow-y-auto p-3">
        {properties}
      </TabsContent>
      <TabsContent value="history" className="flex-1 overflow-y-auto p-3">
        {history}
      </TabsContent>
      {sharing != null && (
        <TabsContent value="sharing" className="flex-1 overflow-y-auto p-3">
          {sharing}
        </TabsContent>
      )}
    </Tabs>
  )
}

/** Shared by both paths: the wikilink target list and what a click on one does. */
function useWikilinks(vaultId: string, canCreate: boolean) {
  const navigate = useNavigate()
  const createNote = useCreateNote(vaultId)
  const tree = useVaultTree(vaultId)
  const targets = tree.data ? Object.values(tree.data).flat().map((n) => n.path) : []

  return {
    targets,
    onClick: (target: string) =>
      handleWikilinkClick(
        target,
        vaultId,
        targets,
        canCreate,
        (to) => navigate(to),
        (input, onSettled) => createNote.mutate(input, { onSettled }),
      ),
  }
}

interface NoteIdentity {
  vaultId: string
  path: string
  vaultName: string | undefined
}

interface CollabNoteProps extends NoteIdentity {
  /** The REST view of this vault says the edit access is gone. Same news the
   *  relay's kick carries, arriving over a different wire — a window-focus
   *  refetch can beat a dropped socket's next reconnect — and either one is
   *  enough to lock the session. Never a reason to unmount it. */
  accessRevoked: boolean
  /** Only ever rendered when the relay could not be reached at all — see
   *  `strandedOffline`. Never seeded into the shared document. */
  initialBody: string
  /** Drives the History tab (revision purge is owner-only) and the Sharing
   *  tab (owner-only outright). */
  access: VaultAccess
}

/**
 * The editor path: one Yjs document, shared with everyone else holding `edit`.
 * No `PUT`, no local copy of the body — the `Y.Text` is the document.
 */
function CollabNote({ vaultId, path, vaultName, accessRevoked, initialBody, access }: CollabNoteProps) {
  const session = useSession()
  // isError before .data, as everywhere.
  const me = session.isPending || session.isError ? null : session.data

  const collab = useCollabDoc({
    vaultId,
    path,
    // Until unit 4 gives users a display name, the presence label is the local
    // part of the address (unit 6 plan, gap 7) — never the full email, which
    // would show every co-editor's address to everyone in the note.
    user: { id: me?.id ?? '', name: me ? (me.email.split('@')[0] ?? me.email) : '' },
    // No identity, no connection: awareness is broadcast at connect time, so
    // joining before the session resolves would label this person as nobody.
    enabled: me !== null,
  })

  const revoked = accessRevoked || collab.status === 'revoked'
  // `writable` — not `status === 'revoked'`. Enumerating statuses at the call
  // site is how 'offline' got missed once already, and the failure mode is a
  // person typing into a document that is not syncing anywhere.
  const locked = revoked || !collab.writable
  const wikilinks = useWikilinks(vaultId, !locked)
  const ytext = collab.ydoc.getText('body')

  // Never connected, and not because access was taken away: the relay or the
  // ticket endpoint is down. The Y.Text is empty, so the collab editor would
  // show a BLANK note over a note that has content — worse than useless on the
  // screen someone opened to read it.
  //
  // The REST body is shown instead, read-only. It is not seeded into the
  // Y.Text: doing that would merge a local copy into the shared document on
  // eventual connect and duplicate the whole note. `writable` is already false
  // while offline, so nothing can be typed into this and lost on the swap.
  const strandedOffline = collab.status === 'offline' && !collab.synced

  const editorRef = useCodeMirrorEditor({
    // Ignored under collab (the hook seeds from the Y.Text): a REST body would
    // be inserted a second time when the document loads.
    doc: strandedOffline ? initialBody : '',
    onChange: NO_SAVE,
    readOnly: locked,
    wikilinkTargets: wikilinks.targets,
    onWikilinkClick: wikilinks.onClick,
    collab: strandedOffline ? undefined : { ytext, awareness: collab.awareness },
  })

  // "Synced 10:04" needs the moment `synced` last became true. Tracked with
  // React's adjust-state-during-render pattern (the same one `useCollabDoc`
  // uses for the document swap): setting it from an effect is a cascading
  // render, and the time it would stamp is the render's, not the event's.
  const [mark, setMark] = useState<{ synced: boolean; at: Date | null }>({ synced: false, at: null })
  if (mark.synced !== collab.synced) {
    setMark({ synced: collab.synced, at: collab.synced ? new Date() : mark.at })
  }

  return (
    <NoteFrame
      editorRef={editorRef}
      bar={
        <>
          <NotePath vaultName={vaultName} vaultId={vaultId} path={path} />
          <CollabStatusLine status={collab.status} synced={collab.synced} syncedAt={mark.at} />
          {/* Presence lives in this bar and nowhere else — never a global
              "who's online", which leaks who is working on what. */}
          <CollaboratorAvatars peers={collab.peers} />
          {/* Rename/delete need edit server-side, and `locked` covers offline
              too — a rename that cannot reach the API is a door to an error. */}
          {!locked && (
            <div className="ml-auto">
              <NoteActions vaultId={vaultId} note={{ path, name: path.split('/').pop() ?? path }} />
            </div>
          )}
        </>
      }
      notice={revoked ? <RevokedNotice /> : null}
      inspector={
        <NoteInspector
          properties={<CollabPropertyPanel frontmatter={collab.ydoc.getMap('frontmatter')} readOnly={locked} />}
          // RevisionHistory explains itself to a downgraded (now read) viewer
          // instead of firing a request that can only 403.
          history={<RevisionHistory vaultId={vaultId} path={path} access={access} />}
          sharing={access === 'owner' ? <SharingPanel vaultId={vaultId} /> : undefined}
        />
      }
    />
  )
}

const LIVE_WHISPER: Record<LiveStatus, string> = {
  connecting: 'Connecting…',
  live: 'Live — updates as others type',
  reconnecting: 'Reconnecting…',
  ended: 'Live updates stopped — your access to this note may have changed',
}

interface LiveNoteProps extends NoteIdentity {
  initialFrontmatter: Record<string, unknown>
  initialBody: string
}

/**
 * The reader path: the SSE live view, which sends whole note states and no
 * presence data of any kind. Locked, but never stale.
 */
function LiveNote({ vaultId, path, vaultName, initialFrontmatter, initialBody }: LiveNoteProps) {
  const live = useLiveNote({ vaultId, path, enabled: true })
  // The REST fetch is what is on screen until the first frame arrives.
  const state = live.state ?? { frontmatter: initialFrontmatter, body: initialBody }
  const wikilinks = useWikilinks(vaultId, false)

  const editorRef = useCodeMirrorEditor({
    doc: state.body,
    onChange: NO_SAVE,
    readOnly: true,
    wikilinkTargets: wikilinks.targets,
    onWikilinkClick: wikilinks.onClick,
  })

  // The editor is built once, around the first body it is given. Later frames
  // are dispatched into it rather than remounting it, so a reader's scroll
  // position survives other people typing. `readOnly` blocks user input, not
  // an explicit transaction.
  useEffect(() => {
    const view = editorRef.current && EditorView.findFromDOM(editorRef.current)
    if (!view || view.state.doc.toString() === state.body) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: state.body } })
  }, [editorRef, state.body])

  return (
    <NoteFrame
      editorRef={editorRef}
      bar={
        <>
          <NotePath vaultName={vaultName} vaultId={vaultId} path={path} />
          <Pill>Read-only</Pill>
          <span role="status" className="truncate text-xs text-muted-foreground">
            {LIVE_WHISPER[live.status]}
          </span>
        </>
      }
      inspector={
        <NoteInspector
          properties={<LivePropertyPanel frontmatter={state.frontmatter} />}
          // Same layout as an editor's, locked: RevisionHistory says why a
          // read-only viewer gets no list instead of rendering a 403.
          history={<RevisionHistory vaultId={vaultId} path={path} access="read" />}
        />
      }
    />
  )
}
