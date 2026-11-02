-- #891 (ADR-003 §5.4): the items of the latest rebase of a note's CRDT state. A rebase compiles the row's
-- out-of-band change as new items of the server process's client id (`rebaseLocked`); a tab left open across it
-- may hold the original items of that same text (its own typing, removed from `note_updates` by a manual
-- restore), and syncing both would put the text in twice. `rebase_client` is the client id the latest rebase
-- wrote its items under (the server process's SERVER_CLIENT_ID, random per process) and `rebase_clock` that
-- client's clock just past them: a client lacks the rebase exactly when its state vector has less than
-- `rebase_clock` for `rebase_client`. The relay refuses such a client's first sync with `note-rebased` when it
-- also holds items the document does not (server/src/sync/collab-server.ts). Null: no rebase recorded.
-- Numbered 0062 with a `when` (1793700000000) above every migration before it, after 0061; reserved on #930.
ALTER TABLE "note_crdt" ADD COLUMN "rebase_client" bigint;--> statement-breakpoint
ALTER TABLE "note_crdt" ADD COLUMN "rebase_clock" bigint;
