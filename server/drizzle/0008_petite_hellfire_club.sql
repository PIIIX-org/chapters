CREATE TYPE "public"."semantic_node_type" AS ENUM('note', 'code');--> statement-breakpoint
ALTER TABLE "semantic_edges" ADD COLUMN "node_a_type" "semantic_node_type";--> statement-breakpoint
ALTER TABLE "semantic_edges" ADD COLUMN "node_a_id" uuid;--> statement-breakpoint
ALTER TABLE "semantic_edges" ADD COLUMN "node_b_type" "semantic_node_type";--> statement-breakpoint
ALTER TABLE "semantic_edges" ADD COLUMN "node_b_id" uuid;