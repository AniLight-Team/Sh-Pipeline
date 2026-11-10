import {
  pgTable,
  bigserial,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  index,
  jsonb,
} from "drizzle-orm/pg-core";

/* =========================================================
   STANDALONE PIPELINE QUEUE & DUAL-PIPELINE BATCH TABLES
   Maintained independently by SH Pipeline.
   - Pipeline 1 ("vm_remux"): H.264 multi-quality (1080p/720p/480p) or single 1080p direct container/audio remux on VM
   - Pipeline 2 ("kaggle_gpu"): HEVC/AV1 1080p -> 1080p/720p/480p Dual-T4 NVENC GPU encode on Kaggle
========================================================= */

export const pipelineBatch = pgTable(
  "pipeline_encoding_batch",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    pipelineType: text("pipeline_type").notNull().default("kaggle_gpu"), // "vm_remux" | "kaggle_gpu"
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
    index("sh_pipeline_batch_pipeline_type_idx").on(table.pipelineType, table.status),
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
    status: text("status").notNull().default("queued"), // queued | downloading | staged | encoding | completed | failed | download_paused
    pipelineType: text("pipeline_type").notNull().default("vm_remux"), // "vm_remux" | "kaggle_gpu"
    selectionTier: text("selection_tier"), // "h264_multi" | "h264_single_1080p" | "hevc_av1_gpu"
    releaseGroup: text("release_group"),
    videoCodec: text("video_codec"), // "h264" | "hevc" | "av1"
    isBatchTorrent: boolean("is_batch_torrent").notNull().default(false),
    qualityCount: integer("quality_count").notNull().default(1),
    stagedQualities: jsonb("staged_qualities").$type<
      Partial<Record<"1080p" | "720p" | "480p", string>>
    >(),
    qualitiesPayload: jsonb("qualities_payload").$type<Record<string, any>>(),
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
    index("sh_pipeline_job_pipeline_status_idx").on(
      table.status,
      table.pipelineType,
      table.batchId,
      table.stagedAt,
    ),
    index("sh_pipeline_job_anilist_idx").on(table.anilistId, table.episodeNumber),
    index("sh_pipeline_job_anime_idx").on(table.animeId),
    index("sh_pipeline_job_anidb_idx").on(table.anidbId, table.episodeNumber),
    index("sh_pipeline_job_batch_idx").on(table.batchId),
  ],
);
