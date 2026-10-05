DO $$ BEGIN CREATE INDEX IF NOT EXISTS "repository_file_symbols_embedding_idx" ON "repository_file_symbols" USING hnsw ("embedding" vector_cosine_ops); EXCEPTION WHEN OTHERS THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notes_vault_trash_idx" ON "notes" ("vault_id", "deleted_at") WHERE "deleted_at" IS NOT NULL;--> statement-breakpoint
DO $$ BEGIN CREATE INDEX IF NOT EXISTS "notes_missing_embeddings_idx" ON "notes" ("id") WHERE "deleted_at" IS NULL AND "embedding" IS NULL; EXCEPTION WHEN OTHERS THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vaults_owner_active_idx" ON "vaults" ("owner_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_recipient_created_idx" ON "notifications" ("recipient_id", "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "semantic_edges_node_a_id_idx" ON "semantic_edges" ("node_a_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "semantic_edges_node_b_id_idx" ON "semantic_edges" ("node_b_id");--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "last_synced_commit" text;
