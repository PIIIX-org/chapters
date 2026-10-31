import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

/**
 * Session memory (#683, ADR-004 §2.9 D7; backend-reference.md §5.11,
 * "Session memory"): which passages an MCP read sent under an agent's
 * `session_id`, so a later read in the same session answers a repeat with a
 * reference (mcp/session-reads.ts). Kept in Postgres (migration 0060, the
 * unlogged `mcp_sessions` and `mcp_session_passages`), so every server
 * instance shares it and the transport stays stateless; a crash empties it,
 * which only means full answers.
 *
 * - Scope: a token (`mcp_connections` row, so one account) and a session id.
 *   Another token, account or session id has a memory of its own. Callers
 *   open a session only after the call's live checks passed: the memory
 *   decides how an answer is sent, never whether.
 * - Calls: every call opening the session gets the next number, the `call`
 *   its answer names and references point to.
 * - Forgetting: passages of calls before `since` are not held. `since` moves
 *   to the current call when the session idled past SESSION_IDLE_MINUTES or
 *   the permission epoch (#680) moved since its last call. Sessions idle
 *   past the window are deleted by any session call; a token keeps at most
 *   MAX_SESSIONS (least recently used dropped), a session at most
 *   MAX_PASSAGES (oldest calls dropped). A row is ids, a hash, a version and
 *   four integers (no text), so a session holds at most about 100 kB.
 */
export const SESSION_IDLE_MINUTES = 30
export const MAX_SESSIONS = 16
export const MAX_PASSAGES = 500

/** Text by lines; a read's outline; read_file's symbol list. */
export type PassageKind = 'text' | 'outline' | 'symbols'

/** A passage a session got: its content hash, the document version (a note's rev, a file's content hash) and lines (0-0 for a list) it had, and the call. */
export interface HeldPassage {
  kind: PassageKind
  hash: string
  version: string
  first: number
  last: number
  call: number
}

export interface Session {
  connectionId: string
  sessionId: string
  /** The note or repository file the call reads. */
  doc: string
  /** This call's number in the session. */
  call: number
  /** The first call whose passages the session holds. */
  since: number
  /** What the session holds of `doc`, newest call first. */
  held: HeldPassage[]
}

/** 128 bits of sha256 over the kind and the text: equal only for the same text (or list) of the same kind. */
export function passageHash(kind: PassageKind, text: string): string {
  return createHash('sha256').update(`${kind}\0${text}`).digest('hex').slice(0, 32)
}

/**
 * Counts a call of session `sessionId` of token `connectionId` reading
 * document `doc`, and answers its number with what the session holds of
 * `doc`: one statement, which also deletes idle sessions and the token's
 * sessions past MAX_SESSIONS.
 */
export async function openSession(connectionId: string, sessionId: string, doc: string): Promise<Session> {
  const [row] = (await db.execute(sql`
    WITH pruned AS (
      DELETE FROM mcp_sessions
      WHERE NOT (connection_id = ${connectionId} AND session_id = ${sessionId})
        AND (used_at < now() - make_interval(mins => ${SESSION_IDLE_MINUTES})
          OR (connection_id = ${connectionId} AND session_id IN (
            SELECT session_id FROM mcp_sessions WHERE connection_id = ${connectionId} AND session_id <> ${sessionId}
            ORDER BY used_at DESC OFFSET ${MAX_SESSIONS - 1})))
    ), opened AS (
      INSERT INTO mcp_sessions AS m (connection_id, session_id, calls, since, permission_epoch)
      SELECT ${connectionId}, ${sessionId}, 1, 1, coalesce((SELECT permission_epoch FROM instance_state WHERE id = 'singleton'), 0)
      ON CONFLICT (connection_id, session_id) DO UPDATE SET
        calls = m.calls + 1,
        since = CASE
          WHEN m.used_at < now() - make_interval(mins => ${SESSION_IDLE_MINUTES}) OR m.permission_epoch <> EXCLUDED.permission_epoch THEN m.calls + 1
          ELSE m.since END,
        permission_epoch = EXCLUDED.permission_epoch,
        used_at = now()
      RETURNING m.calls, m.since
    )
    SELECT o.calls AS call, o.since,
      coalesce((
        SELECT json_agg(json_build_object('kind', p.kind, 'hash', p.hash, 'version', p.version, 'first', p.first_line, 'last', p.last_line, 'call', p.call)
          ORDER BY p.call DESC)
        FROM mcp_session_passages p
        WHERE p.connection_id = ${connectionId} AND p.session_id = ${sessionId} AND p.doc = ${doc} AND p.call >= o.since), '[]') AS held
    FROM opened o`)) as unknown as [{ call: number; since: number; held: HeldPassage[] }]
  return { connectionId, sessionId, doc, call: row.call, since: row.since, held: row.held }
}

/**
 * Records that `session`'s call sent `passages` of its document, in one
 * statement that also drops what the session no longer holds (calls before
 * `since`) and its oldest passages past MAX_PASSAGES. A passage sent again
 * moves to this call. A session deleted meanwhile (its token deleted)
 * records nothing.
 */
export async function rememberPassages(session: Session, passages: ReadonlyArray<Omit<HeldPassage, 'call'>>): Promise<void> {
  const unique = [...new Map(passages.map((p) => [p.hash, p])).values()]
  if (unique.length === 0) return
  const { connectionId, sessionId, doc } = session
  const rows = JSON.stringify(unique)
  await db.execute(sql`
    WITH sent AS (
      SELECT * FROM jsonb_to_recordset(${rows}::jsonb) AS x(kind text, hash text, version text, first int, last int)
    ), dropped AS (
      DELETE FROM mcp_session_passages p
      WHERE p.connection_id = ${connectionId} AND p.session_id = ${sessionId}
        AND NOT (p.doc = ${doc} AND p.hash IN (SELECT hash FROM sent))
        AND (p.call < ${session.since} OR (p.doc, p.hash) IN (
          SELECT o.doc, o.hash FROM mcp_session_passages o
          WHERE o.connection_id = ${connectionId} AND o.session_id = ${sessionId}
            AND NOT (o.doc = ${doc} AND o.hash IN (SELECT hash FROM sent))
          ORDER BY o.call DESC OFFSET ${Math.max(MAX_PASSAGES - unique.length, 0)}))
    )
    INSERT INTO mcp_session_passages (connection_id, session_id, doc, hash, kind, version, first_line, last_line, call)
    SELECT ${connectionId}, ${sessionId}, ${doc}, s.hash, s.kind, s.version, s.first, s.last, ${session.call}
    FROM sent s
    WHERE EXISTS (SELECT 1 FROM mcp_sessions WHERE connection_id = ${connectionId} AND session_id = ${sessionId})
    ON CONFLICT (connection_id, session_id, doc, hash) DO UPDATE SET
      kind = EXCLUDED.kind, version = EXCLUDED.version, first_line = EXCLUDED.first_line, last_line = EXCLUDED.last_line, call = EXCLUDED.call`)
}
