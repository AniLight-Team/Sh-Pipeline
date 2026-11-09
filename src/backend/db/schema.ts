import {
  pgTable,
  bigserial,
  text,
  integer,
  bigint,
  timestamp,
  index,
  jsonb,
} from "drizzle-orm/pg-core";

/* =========================================================
   STANDALONE PIPELINE QUEUE & BATCH TABLES
   Maintained independently by SH Pipeline.
========================================================= */

export const pipelineBatch = pgTable(
  "pipeline_encoding_batch",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    status: text("status").notNull().default("created"), // created | uploading | waiting_dataset | kernel_running | completed | failed
    triggerReason: text("trigger_reason").notNull().default("window_30m"),
    kaggleUsername: text("kaggle_username"),
    datasetSlug: text("dataset_slug"),
    kernelSlug: text("kernel_slug"),
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull().default(0),
    jobCount: integer("job_count").notNull().default(0),
    attempt: integer("attempt").notNull().default(1),
    lastError: text("last_error"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("sh_pipeline_batch_status_idx").on(table.status),
    index("sh_pipeline_batch_user_idx").on(table.kaggleUsername, table.status),
    index("sh_pipeline_batch_heartbeat_idx").on(table.status, table.heartbeatAt),
  ],
);

export const pipelineJob = pgTable(
  "pipeline_encoding_job",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    anilistId: integer("anilist_id"),
    animeId: integer("anime_id"),
    anidbId: integer("anidb_id"),
    episodeNumber: integer("episode_number").notNull(),
    types: jsonb("types").$type<("sub" | "dub")[]>().notNull(),
    status: text("status").notNull().default("queued"), // queued | downloading | staged | encoding | completed | failed | paused
    knownTitles: jsonb("known_titles").$type<string[]>(),
    metadata: jsonb("metadata").$type<Record<string, any>>(),
    callbackUrl: text("callback_url"),
    attempt: integer("attempt").notNull().default(1),
    torrentMagnet: text("torrent_magnet"),
    torrentTitle: text("torrent_title"),
    torrentId: integer("torrent_id"),
    stagedFilePath: text("staged_file_path"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    tracksConfig: jsonb("tracks_config").$type<any>(),
    subtitlesPayload: jsonb("subtitles_payload").$type<any[]>(),
    resultPayload: jsonb("result_payload").$type<any>(),
    batchId: bigint("batch_id", { mode: "number" }).references(
      () => pipelineBatch.id,
      { onDelete: "set null" },
    ),
    lastError: text("last_error"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    stagedAt: timestamp("staged_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("sh_pipeline_job_status_idx").on(table.status),
    index("sh_pipeline_job_anilist_idx").on(table.anilistId, table.episodeNumber),
    index("sh_pipeline_job_anime_idx").on(table.animeId),
    index("sh_pipeline_job_anidb_idx").on(table.anidbId, table.episodeNumber),
    index("sh_pipeline_job_batch_idx").on(table.batchId),
  ],
);
