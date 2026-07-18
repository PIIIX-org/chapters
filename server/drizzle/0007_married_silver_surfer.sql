ALTER TYPE "public"."mcp_scope" ADD VALUE 'repository';--> statement-breakpoint
CREATE TABLE "repository_file_imports" (
	"source_file_id" uuid NOT NULL,
	"target_path" text NOT NULL,
	"resolved_target_file_id" uuid,
	CONSTRAINT "repository_file_imports_source_file_id_target_path_pk" PRIMARY KEY("source_file_id","target_path")
);
--> statement-breakpoint
CREATE TABLE "repository_file_symbols" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "repository_id" uuid;--> statement-breakpoint
ALTER TABLE "repository_files" ADD COLUMN "embedding" vector(384);--> statement-breakpoint
ALTER TABLE "repository_file_imports" ADD CONSTRAINT "repository_file_imports_source_file_id_repository_files_id_fk" FOREIGN KEY ("source_file_id") REFERENCES "public"."repository_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_file_imports" ADD CONSTRAINT "repository_file_imports_resolved_target_file_id_repository_files_id_fk" FOREIGN KEY ("resolved_target_file_id") REFERENCES "public"."repository_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_file_symbols" ADD CONSTRAINT "repository_file_symbols_file_id_repository_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."repository_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repository_file_imports_resolved_idx" ON "repository_file_imports" USING btree ("resolved_target_file_id");--> statement-breakpoint
CREATE INDEX "repository_file_symbols_file_idx" ON "repository_file_symbols" USING btree ("file_id");--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_files" ADD COLUMN "fts" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("path", '') || ' ' || coalesce("content", ''))) STORED;--> statement-breakpoint
CREATE INDEX "repository_files_fts_idx" ON "repository_files" USING gin ("fts");--> statement-breakpoint
CREATE INDEX "repository_files_embedding_idx" ON "repository_files" USING hnsw ("embedding" vector_cosine_ops);