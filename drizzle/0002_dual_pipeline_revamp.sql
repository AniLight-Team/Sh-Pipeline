ALTER TABLE "pipeline_encoding_batch" ADD COLUMN IF NOT EXISTS "pipeline_type" text DEFAULT 'kaggle_gpu' NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_encoding_job" ADD COLUMN IF NOT EXISTS "pipeline_type" text DEFAULT 'vm_remux' NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_encoding_job" ADD COLUMN IF NOT EXISTS "selection_tier" text;--> statement-breakpoint
ALTER TABLE "pipeline_encoding_job" ADD COLUMN IF NOT EXISTS "release_group" text;--> statement-breakpoint
ALTER TABLE "pipeline_encoding_job" ADD COLUMN IF NOT EXISTS "video_codec" text;--> statement-breakpoint
ALTER TABLE "pipeline_encoding_job" ADD COLUMN IF NOT EXISTS "is_batch_torrent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_encoding_job" ADD COLUMN IF NOT EXISTS "quality_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_encoding_job" ADD COLUMN IF NOT EXISTS "staged_qualities" jsonb;--> statement-breakpoint
ALTER TABLE "pipeline_encoding_job" ADD COLUMN IF NOT EXISTS "qualities_payload" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sh_pipeline_batch_pipeline_type_idx" ON "pipeline_encoding_batch" USING btree ("pipeline_type","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sh_pipeline_job_pipeline_status_idx" ON "pipeline_encoding_job" USING btree ("status","pipeline_type","batch_id","staged_at");
