# Unit 6 — Collaboration

Implements the unit 6 section of
`docs/superpowers/specs/2026-08-22-remaining-ui-design.md` against
`docs/superpowers/specs/2026-07-11-realtime-collaboration-design.md`, with
cursor and colour rules from `docs/superpowers/specs/2026-07-19-ui-design-system.md`.

Closes **#66** (the lost-update race) — by construction, not by mitigation:
two people typing in one note merge through the CRDT instead of racing two
`PUT`s.

## Already built, server-side (do not rebuild)

`server/src/sync/` is finished and covered by `server/test/collab.test.ts`:

- **The relay.** Hocuspocus on its own port (`COLLAB_PORT`, default 3001), same
  process. Document name is `<vaultId>/<path>`; the shared shapes are
  `getText('body')` and `getMap('frontmatter')` — the whole note is live-synced,
  body and property panel alike, exactly as the spec requires.
- **Load and store.** `onLoadDocument` seeds the doc from the note file;
  `onStoreDocument` writes it back, debounced 2s (`COLLAB_DEBOUNCE_MS`).
- **Auth.** `onAuthenticate` resolves live access and admits **editors only**
  (`atLeast(access, 'edit')`).
- **Per-message re-auth.** `beforeHandleMessage` re-resolves access on *every*
  inbound message. This is the audit rule and it is real.
- **The revocation kick.** `wireKick` listens on the permission-event bus and
  closes affected sockets the moment a share is revoked.
- **The read-only live view.** `GET /api/vaults/:id/live/*`, SSE, full note state
  per frame. Viewers never join the Yjs doc — that is how the audit's presence
  rule is enforced: no awareness, no identities, no cursors, structurally.
- **AI writes go through the same engine.** `mcp/crdt-write.ts` opens a direct
  connection so an MCP edit lands in the live document rather than appearing as
  a mystery change.

## Missing, client-side (this unit)

Everything. A grep of `client/src` for `yjs` or `collab` returned nothing before
this plan. `NoteView.tsx` still autosaves with a 1.2s debounced `PUT` — which is
the #66 race itself, and which **must be removed on the collab path**, because a
last-write-wins `PUT` racing a CRDT doc would clobber merged text.

Client dependencies are now installed and deduped to a single yjs:
`yjs@13.6.32` (matching the server), `y-codemirror.next@0.3.6`,
`@hocuspocus/provider@4.6.0`. `pnpm why yjs` reports **one** version — two
copies silently break merging, so re-check this if anything touches the lockfile.

## Backend gaps

Nothing in the spec's addition table belongs to this unit, so all of these are
new. 1 and 2 are blocking; the rest are judgement calls with a recommendation.

| # | Gap | Why it blocks / matters |
|---|---|---|
| 1 | **No credential a browser can use.** The session cookie is `httpOnly`, and `onAuthenticate` reads only Hocuspocus's `token` field. `server/test/collab.test.ts` passes the raw session token because a Node test can read it; browser JS cannot. | Nothing can connect at all. |
| 2 | **The relay's URL is not discoverable.** `COLLAB_PORT` is server-side config and no endpoint exposes it. | The client cannot guess where to connect, in dev or behind a reverse proxy. |
| 3 | **The kick closes with no reason.** `connection.close()` sends a bare close. | The client shows "reconnecting" until the retry's auth fails, so a revocation reads as a network blip for a beat. One-line fix: close with a code/reason. Non-blocking. |
| 4 | **No persistence acknowledgement.** `onStoreDocument` is debounced and tells nobody. | The client can honestly say *synced*, never *saved*. Copy is written accordingly (below). Alternative: a stateless message after store. |
| 5 | **Awareness identity is self-declared.** Nothing stamps the connection's real `userId` into awareness; a modified client could broadcast any name and colour. | Everyone in the document already holds `edit` on the vault, so the blast radius is small — but presence *is* identity. **Flag to Taha**; the fix is server-side stamping/validation, not client code. |
| 6 | **AI edits carry no awareness state.** `openDirectConnection(docName, { userId: 'mcp' })` has no awareness client. | The teal AI cursor has no source: MCP edits arrive as anonymous text changes. The client already colours `user.id === 'mcp'` teal, so this lights up the day the server publishes it. |
| 7 | **Users have no display name.** `users` has `email` and nothing else. | Presence labels would show full email addresses to every co-editor. Until unit 4 adds a name, **label with the local part of the address** (`taha` from `taha@…`), not the whole thing. |
| 8 | **SSE has no heartbeat.** A quiet live view is dropped by any proxy with an idle read timeout. | Degrades to a reconnect flash, not data loss. Three-line fix in `viewers.ts`: write `:\n\n` every 30s. |

**Recommended shape for 1 + 2, one endpoint:** `POST /api/collab/ticket` →
`{ token, url, expiresAt }`. Opaque, single-use, ~60s TTL, bound to the calling
user, held in an in-process `Map` (single-instance is already an accepted
constraint). `onAuthenticate` tries a ticket first and keeps the session-token
path so the existing server tests stay green. `url` is built from `COLLAB_PORT`
and the request's host. `client/src/api/collab.ts` is already written against
exactly this. Dev also needs a `/collab` websocket entry in
`client/vite.config.ts`, or the ticket URL must point straight at `:3001`.

The cheaper alternative to a ticket — reading the session cookie off the
websocket upgrade in `onAuthenticate` — was rejected: it works (`SameSite=lax`
is not sent on cross-site websocket handshakes, and cookies ignore port), but it
ties the relay to same-host deployment and gives a websocket the full 30-day
session token instead of a 60-second one.

## Load-bearing rules

- **Five ink hues, hashed per user: vermillion, indigo, plum, ochre, forest.
  Teal is never assigned to a human.** Teal means AI/MCP touched it. Already
  encoded in `client/src/lib/ink.ts`; do not add a sixth hue and do not put teal
  in `INKS`.
- **The cursor tapers to a pen nib**, not Figma's arrow. It is this product's
  own mark. `yCollab` gives the position and colour; the nib is CSS on
  `.cm-ySelectionCaret` and its dot.
- **Presence avatars live in the Editor top bar only.** Never a global
  "who's online" list — that is a different product's feature and it leaks who
  is working on what.
- **Autosave state whispers in the breadcrumb.** Never a modal, never a toast.
  And the word is **"Synced"**, not "Saved": see gap 4, the client has no
  evidence of a disk write.
- **A kick must not lose unsaved work.** The relay drops the socket the instant
  access is revoked. `useCollabDoc` stops reconnecting and reports `revoked`,
  but never destroys the `Y.Doc` — whatever is on screen stays on screen, in a
  locked state, with the reason said plainly and inline.
- **Readers never join the Yjs doc.** `canEdit(vault.access)` picks the path:
  editors get `useCollabDoc`, readers get `useLiveNote` over SSE. This is the
  audit's presence rule; it is not a performance choice to be optimised away.
- **`NoteView`'s debounced `PUT` goes away for editors.** Leaving it in
  reintroduces #66 against the very engine that fixes it.
- **No `bg-accent` / `hover:bg-accent` anywhere.** `accent` *is* the teal AI
  token. Hover and active states use `bg-muted`.
- **Nothing collaborative may be imported by the shell.** `NoteView` is a lazy
  route, which is what keeps yjs out of the initial bundle;
  `src/bundle.test.ts` enforces the 300KB budget and will catch a slip.

## Client contract (written — code against it, don't redesign it)

| File | What it gives you |
|---|---|
| `client/src/api/collab.ts` | `getCollabTicket()`, `collabDocName()`, `liveNoteUrl()`, `LiveNoteState` |
| `client/src/lib/ink.ts` | `INKS` (the five), `AI_INK` (teal), `inkFor(userId)` → `{ color, colorLight }` as `yCollab` wants them |
| `client/src/hooks/useCollabDoc.ts` | `{ ydoc, awareness, status, synced, peers }` — status is `connecting \| connected \| reconnecting \| revoked` |
| `client/src/hooks/useLiveNote.ts` | `{ status, state }` for read-only viewers — `connecting \| live \| reconnecting \| ended` |

`client/src/lib/ink.test.ts` ships with it, mutation-verified.

## Tasks

1. **Backend: the collab ticket** (gaps 1 + 2). `POST /api/collab/ticket`,
   single-use, short TTL; `onAuthenticate` accepts it. Real-database test:
   a ticket authenticates once, a second use fails, an expired one fails, and a
   ticket minted by a reader is still refused by the `edit` check.
2. **Dev plumbing.** Websocket entry in `client/vite.config.ts` (or a direct
   `:3001` URL from the ticket). No test; it is config.
3. **`useCollabDoc` wiring into the editor.** `useCodeMirrorEditor` grows an
   optional `collab: { ytext, awareness }` and adds `yCollab(...)`. When collab
   is on, drop `doc`/`history()` in favour of the Yjs undo manager — CM6's own
   history undoes other people's edits, which is a genuine bug, not a nicety.
4. **Pen-nib cursors.** CSS over `yCollab`'s caret elements; the name tag sits
   under the nib and fades after a couple of seconds of stillness.
5. **`CollaboratorAvatars`** in the Editor top bar. Ink-coloured initials, name
   on hover, `aria-label` naming each person. Teal only ever for `isAi`.
6. **Breadcrumb sync whisper.** `connecting / connected+synced / reconnecting /
   revoked`, in `text-muted-foreground`, `font-mono` for any timestamp.
7. **`NoteView` path split.** Editors: `useCollabDoc`, no `PUT`, body from the
   `Y.Text`. Readers: `useLiveNote`, locked editor and locked `PropertyPanel`
   that still update live. `isError` before any `.data` read, as everywhere.
8. **`PropertyPanel` binds `ydoc.getMap('frontmatter')`** for editors and the SSE
   frame for readers. No wrapper hook — one consumer each, nothing to share.
9. **The revoked state.** Inline, in place: what happened, that unsent edits are
   still on screen, and what to do (copy it out / ask for access again). Not a
   modal, not "Are you sure?"-shaped.
10. **README + STATE.md**, same PR.

## Testing

Client: vitest + happy-dom, an axe assertion per new component, **every test
mutation-verified** — break the implementation, watch that test fail, restore,
watch it pass. Fixtures must be uneven enough to tell working from broken: two
peers with the same ink prove nothing about hashing.

`HocuspocusProvider` and `EventSource` both need stubbing in happy-dom; stub at
the module boundary (`vi.mock('@hocuspocus/provider')`) rather than hand-rolling
a websocket.

Server: real-database integration tests for the ticket, alongside the existing
`collab.test.ts`.

And the standing rule from unit 3: the client suite stubs `fetch` and cannot see
a transport bug. This unit gets **two browser windows, two accounts, one note**,
typing at the same time, before it is called done — plus a revoke performed
while both are open.
