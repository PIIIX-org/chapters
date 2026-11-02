-- #471 (ADR-004 §2.9, D11): the history the index keeps of itself, for `browse_repository`'s `changed_since`.
-- `repository_versions`: one row per index version a sync recorded (the commit it named, the tree hash, when), in
-- order of `seq`; `repository_changes`: the files that version added, changed or deleted against the one before
-- (written with each file, so a sync that stops midway leaves its changes under the next `seq`: no row of the
-- versions table references them). A repository keeps its last 200 versions (store.ts `VERSIONS_KEPT`).
-- A repository's first version is its baseline and has no changes. The git mirror is depth 1, so this is the index's
-- history (sync time), not git's. Existing repositories get one baseline version from their recorded commit and tree.
-- Numbered 0063 (0062 is taken), reserved on #930.
ALTER TABLE "repositories" ADD COLUMN "version_seq" integer NOT NULL DEFAULT 0;--> statement-breakpoint
CREATE TABLE "repository_versions" (
	"repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
	"seq" integer NOT NULL,
	"commit" text,
	"tree_hash" text,
	"indexed_at" timestamp with time zone NOT NULL DEFAULT now(),
	PRIMARY KEY ("repository_id", "seq")
);--> statement-breakpoint
CREATE TABLE "repository_changes" (
	"repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
	"seq" integer NOT NULL,
	"path" text NOT NULL,
	"kind" text NOT NULL CHECK ("kind" IN ('added', 'modified', 'deleted')),
	PRIMARY KEY ("repository_id", "seq", "path")
);--> statement-breakpoint
INSERT INTO "repository_versions" ("repository_id", "seq", "commit", "tree_hash", "indexed_at")
SELECT "id", 1, "last_synced_commit", "tree_hash", COALESCE("last_synced_at", "created_at") FROM "repositories" WHERE "tree_hash" IS NOT NULL;--> statement-breakpoint
UPDATE "repositories" SET "version_seq" = 1 WHERE "tree_hash" IS NOT NULL;
