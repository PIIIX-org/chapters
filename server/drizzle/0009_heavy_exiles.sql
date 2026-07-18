ALTER TABLE "semantic_edges" DROP CONSTRAINT "semantic_edges_note_a_notes_id_fk";
--> statement-breakpoint
ALTER TABLE "semantic_edges" DROP CONSTRAINT "semantic_edges_note_b_notes_id_fk";
--> statement-breakpoint
DROP INDEX "semantic_edges_b_idx";--> statement-breakpoint
ALTER TABLE "semantic_edges" DROP CONSTRAINT "semantic_edges_note_a_note_b_pk";--> statement-breakpoint
ALTER TABLE "semantic_edges" ALTER COLUMN "node_a_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "semantic_edges" ALTER COLUMN "node_a_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "semantic_edges" ALTER COLUMN "node_b_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "semantic_edges" ALTER COLUMN "node_b_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "semantic_edges" ADD CONSTRAINT "semantic_edges_node_a_type_node_a_id_node_b_type_node_b_id_pk" PRIMARY KEY("node_a_type","node_a_id","node_b_type","node_b_id");--> statement-breakpoint
CREATE INDEX "semantic_edges_b_idx" ON "semantic_edges" USING btree ("node_b_type","node_b_id");--> statement-breakpoint
ALTER TABLE "semantic_edges" DROP COLUMN "note_a";--> statement-breakpoint
ALTER TABLE "semantic_edges" DROP COLUMN "note_b";