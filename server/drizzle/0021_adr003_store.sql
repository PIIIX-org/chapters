-- ADR-003 (decision/adr-003-authoritative-store, §4): schema for one
-- authoritative store. Additive only, so code from before 0021 keeps running
-- on it with no SQL (the 0019/0020 lesson, backup.md §5): no NOT NULL column
-- without a lasting default on a table old code writes, no dropped or renamed
-- column, no constraint old code can violate. Nothing reads these yet (S1);
-- S2a/S2b start using them.

-- notes: version of the authoritative text. A trigger bumps it, so old code bumps it too.
ALTER TABLE "notes" ADD COLUMN "seq" bigint NOT NULL DEFAULT 1;--> statement-breakpoint
-- key-order-preserving copy of the frontmatter, used only for rendering and reads
ALTER TABLE "notes" ADD COLUMN "frontmatter_src" json;--> statement-breakpoint
CREATE FUNCTION notes_bump_seq() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body OR NEW.frontmatter IS DISTINCT FROM OLD.frontmatter
     OR NEW.path IS DISTINCT FROM OLD.path OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    NEW.seq := OLD.seq + 1;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER notes_bump_seq BEFORE UPDATE ON "notes" FOR EACH ROW EXECUTE FUNCTION notes_bump_seq();--> statement-breakpoint

-- revisions: one per seq, idempotency for #477, actor detail for #403
ALTER TABLE "note_revisions" ADD COLUMN "seq" bigint, ADD COLUMN "idempotency_key" text, ADD COLUMN "actor_detail" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "note_revisions_note_seq" ON "note_revisions" ("note_id", "seq") WHERE "seq" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "note_revisions_note_idem" ON "note_revisions" ("note_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint

-- Yjs state, keyed by note id (today: .crdt/<path>.bin). Created on first collab load or by the S2b backfill.
CREATE TABLE "note_crdt" (
  "note_id"          uuid PRIMARY KEY REFERENCES "notes"("id") ON DELETE CASCADE,
  "snapshot"         bytea  NOT NULL,
  "snapshot_through" bigint NOT NULL DEFAULT 0,
  "folded_through"   bigint NOT NULL DEFAULT 0,
  "folded_seq"       bigint NOT NULL,
  "fold_error"       text,
  "updated_at"       timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- Yjs update log tail (collab journal + server updates), compacted into note_crdt.snapshot
CREATE TABLE "note_updates" (
  "id"            bigserial PRIMARY KEY,
  "note_id"       uuid NOT NULL REFERENCES "notes"("id") ON DELETE CASCADE,
  "update"        bytea NOT NULL,
  "actor_type"    "actor_type" NOT NULL,
  "actor_id"      uuid,
  "actor_detail"  jsonb,
  "rejected_at"   timestamptz,
  "reject_reason" text,
  "created_at"    timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX "note_updates_note_idx" ON "note_updates" ("note_id", "id");--> statement-breakpoint

-- projection state per note = the work queue ('file' | 'dir_index' | 'embedding')
CREATE TABLE "note_projections" (
  "note_id"       uuid NOT NULL REFERENCES "notes"("id") ON DELETE CASCADE,
  "projection"    text NOT NULL,
  "target_seq"    bigint NOT NULL,
  "applied_seq"   bigint NOT NULL DEFAULT 0,
  "index_version" integer NOT NULL DEFAULT 0,
  "attempts"      integer NOT NULL DEFAULT 0,
  "last_error"    text,
  "lease_until"   timestamptz,
  "updated_at"    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("note_id", "projection")
);--> statement-breakpoint
CREATE INDEX "note_projections_pending" ON "note_projections" ("projection", "updated_at") WHERE "applied_seq" < "target_seq";--> statement-breakpoint

-- what the projector last wrote at each path ('a/b.md', '.trash/<id>.md', 'a/index.md')
CREATE TABLE "projected_files" (
  "vault_id"     uuid NOT NULL REFERENCES "vaults"("id") ON DELETE CASCADE,
  "path"         text NOT NULL,
  "owner_kind"   text NOT NULL,
  "owner_id"     uuid,
  "applied_hash" text NOT NULL,
  "applied_seq"  bigint,
  "written_at"   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("vault_id", "path")
);--> statement-breakpoint
CREATE INDEX "projected_files_owner_idx" ON "projected_files" ("owner_id");--> statement-breakpoint

-- outbox for work that outlives a note row or spans notes (rename refactor, file and vault-dir removal, #494)
CREATE TABLE "jobs" (
  "id"              bigserial PRIMARY KEY,
  "kind"            text NOT NULL,
  "payload"         jsonb NOT NULL,
  "idempotency_key" text UNIQUE,
  "attempts"        integer NOT NULL DEFAULT 0,
  "last_error"      text,
  "lease_until"     timestamptz,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "done_at"         timestamptz
);--> statement-breakpoint
CREATE INDEX "jobs_pending" ON "jobs" ("kind", "created_at") WHERE "done_at" IS NULL;--> statement-breakpoint

-- backfill markers: S2a (rows, revisions, files, projections) and S2b (.crdt bins -> note_crdt)
ALTER TABLE "instance_state" ADD COLUMN "store_migrated_at" timestamptz;--> statement-breakpoint
ALTER TABLE "instance_state" ADD COLUMN "collab_migrated_at" timestamptz;
