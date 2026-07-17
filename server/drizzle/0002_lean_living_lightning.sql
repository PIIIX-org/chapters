CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "note_links" (
	"source_note_id" uuid NOT NULL,
	"target_path" text NOT NULL,
	CONSTRAINT "note_links_source_note_id_target_path_pk" PRIMARY KEY("source_note_id","target_path")
);
--> statement-breakpoint
CREATE TABLE "semantic_edges" (
	"note_a" uuid NOT NULL,
	"note_b" uuid NOT NULL,
	"similarity" real NOT NULL,
	CONSTRAINT "semantic_edges_note_a_note_b_pk" PRIMARY KEY("note_a","note_b")
);
--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "embedding" vector(384);--> statement-breakpoint
ALTER TABLE "note_links" ADD CONSTRAINT "note_links_source_note_id_notes_id_fk" FOREIGN KEY ("source_note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_edges" ADD CONSTRAINT "semantic_edges_note_a_notes_id_fk" FOREIGN KEY ("note_a") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_edges" ADD CONSTRAINT "semantic_edges_note_b_notes_id_fk" FOREIGN KEY ("note_b") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_links_target_idx" ON "note_links" USING btree ("target_path");--> statement-breakpoint
CREATE INDEX "semantic_edges_b_idx" ON "semantic_edges" USING btree ("note_b");--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "fts" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("path", '') || ' ' || coalesce("frontmatter"::text, '') || ' ' || coalesce("body", ''))) STORED;--> statement-breakpoint
CREATE INDEX "notes_fts_idx" ON "notes" USING gin ("fts");--> statement-breakpoint
CREATE INDEX "notes_embedding_idx" ON "notes" USING hnsw ("embedding" vector_cosine_ops);