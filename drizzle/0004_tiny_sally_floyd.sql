ALTER TABLE "pipeline_encoding_job" ADD COLUMN IF NOT EXISTS "discover_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pipeline_encoding_job" ADD COLUMN IF NOT EXISTS "callback_after" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sh_pipeline_job_discover_after_idx" ON "pipeline_encoding_job" USING btree ("status","discover_after");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sh_pipeline_job_callback_after_idx" ON "pipeline_encoding_job" USING btree ("status","callback_after");