-- #683 (ADR-004 §2.9, D7): per-session de-duplication. An MCP read sent with `session_id`
-- remembers, per token (`mcp_connections` row) and session id, which passages it sent: a later read
-- in the same session answers a repeat with a reference instead of the text (server/src/cache/session.ts).
--
-- `mcp_sessions`: one row per token and session id. `calls` numbers the session's calls (every
-- answer names its own); passages of calls before `since` are forgotten (the session idled past its
-- window, or the permission epoch it was keyed under moved). `used_at` slides the idle window.
-- `mcp_session_passages`: what the session got, by document and content hash: the kind (text,
-- outline, symbols), the document version (a note's rev, a file's content hash), the lines, and the
-- call that sent it. No text is stored.
--
-- UNLOGGED: a crash empties both tables, and an empty memory only means full answers. A memory is
-- a few hundred rows of fixed width, bounded by session.ts (sessions per token, passages per
-- session), and expires after SESSION_IDLE_MINUTES. Deleting the token deletes its rows. Not in
-- the Drizzle model (only session.ts reads them, in SQL), nor in backups.
-- Numbered 0056 @ 1793400000000, the slot reserved for #683 on #930 (0052 landed; 0053/0054 are #1023 and #469).
CREATE UNLOGGED TABLE "mcp_sessions" (
	"connection_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"calls" integer NOT NULL,
	"since" integer NOT NULL,
	"permission_epoch" bigint NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_sessions_pkey" PRIMARY KEY ("connection_id", "session_id"),
	CONSTRAINT "mcp_sessions_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "mcp_connections"("id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX "mcp_sessions_used_at" ON "mcp_sessions" ("used_at");--> statement-breakpoint
CREATE UNLOGGED TABLE "mcp_session_passages" (
	"connection_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"doc" uuid NOT NULL,
	"hash" text NOT NULL,
	"kind" text NOT NULL,
	"version" text NOT NULL,
	"first_line" integer NOT NULL,
	"last_line" integer NOT NULL,
	"call" integer NOT NULL,
	CONSTRAINT "mcp_session_passages_pkey" PRIMARY KEY ("connection_id", "session_id", "doc", "hash"),
	CONSTRAINT "mcp_session_passages_session_fkey" FOREIGN KEY ("connection_id", "session_id") REFERENCES "mcp_sessions"("connection_id", "session_id") ON DELETE CASCADE
);
