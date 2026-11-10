export interface KaggleAccount {
  username: string;
  key: string;
}

export interface HuggingFaceAccount {
  owner: string;
  bucket: string;
  token: string;
}

export interface AnimeToshoItem {
  id?: number;
  title: string;
  link?: string;
  torrent_url?: string;
  magnet_uri?: string;
  seeders?: number;
  leechers?: number;
  size?: number;
  info_hash?: string;
  article_url?: string;
  date?: number;
  num_files?: number;
  is_seadex?: boolean;
  provider?: "animetosho" | "tsukihime";
  tsukihime_id?: number;
  tsukihime_episode_no?: number | null;
  audiolangs?: string[];
  sublangs?: string[];
  group_name?: string;
}

export type VideoResolutionQuality = "1080p" | "720p" | "480p";

export interface ParsedReleaseTitle {
  group: string;
  groupLower: string;
  singleEp: number | null;
  epRange: [number, number] | null;
  seasonNum: number | null;
  isBatch: boolean;
  isSeasonBatch?: boolean;
  isDualAudio: boolean;
  isEnglishDub: boolean;
  isForeign: boolean;
  isCam: boolean;
  isBluray: boolean;
  isWeb: boolean;
  isHevcOrAv1: boolean;
  isH264?: boolean;
  isHevc?: boolean;
  isAv1?: boolean;
  is1080p?: boolean;
  is720p?: boolean;
  is480p?: boolean;
  resolution?: VideoResolutionQuality;
  isBonusOrExtra: boolean;
  isWeirdOrPromo: boolean;
  isUnsupportedContainer: boolean;
  titleRaw?: string;
}

export interface ReleaseQualityEntry {
  quality: VideoResolutionQuality;
  item: AnimeToshoItem;
  effectiveEp: number | string;
  score: number;
}

export interface ReleaseCandidateBundle {
  group: string;
  groupLower: string;
  isH264: boolean;
  isDualAudio: boolean;
  isEnglishDub: boolean;
  bundleScore: number;
  primaryEntry: ReleaseQualityEntry;
  qualities: Partial<Record<VideoResolutionQuality, ReleaseQualityEntry>>;
}

export interface ClassifiedAudioTrack {
  streamIndex: number;
  audioIndex: number;
  language: string;
  title: string;
  channels: number;
  codec: string;
  isCommentary: boolean;
  isDefault: boolean;
}

export interface MkvStreamProbe {
  video: any[];
  audio: any[];
  subtitles: any[];
  isDualAudio: boolean;
  classifiedAudio: ClassifiedAudioTrack[];
  japaneseStreamIndex: number;
  englishStreamIndex: number | null;
  videoCodec?: string;
  pixelFormat?: string;
  width?: number;
  height?: number;
  isBrowserCompatibleH264?: boolean;
}

export interface R2SubtitleRecord {
  anime_id: number;
  episode_number: number;
  type: "sub" | "dub";
  language: string;
  path: string;
  role?: string;
  label?: string;
  url?: string;
  default_sub?: boolean;
  default_dub?: boolean;
}

export interface HfStoreRecord {
  anime_id: number;
  episode_number: number;
  type: string;
  quality: string;
  sha256: string;
  metadata: Record<string, any>;
  huggingface: {
    owner: string;
    repo: string;
    path: string;
    downloadUrl: string;
  };
}

export interface KiraBatchUploadItem {
  jobId: number;
  localFilePath: string;
  remoteFilename: string;
  sizeBytes: number;
}

export interface KiraBatchManifestItem {
  jobId: number;
  filename: string;
  animeId: number;
  anilistId?: number;
  anidbId?: number;
  episodeNumber: number;
  tracks: [string, number][];
  hf: HuggingFaceAccount;
  mode?: "remux" | "transcode";
  qualityFiles?: Partial<Record<VideoResolutionQuality, string>>;
}

export interface KiraBatchHfRecord extends HfStoreRecord {
  job_id?: number;
}

export interface KiraBatchKernelOutput {
  records: KiraBatchHfRecord[];
  completedJobIds: number[];
  failedJobs: { jobId: number; error: string }[];
}

export interface PipelineEncodedSource {
  quality: string;
  url: string;
  downloadUrl: string;
  sha256: string;
  sizeBytes?: number;
}

export interface PipelineSubtitleTrack {
  language: string;
  label: string;
  role: "dialogue" | "signs" | "sdh";
  path: string;
  url: string;
  isDefault: boolean;
}

export interface PipelineEpisodeResult {
  jobId: number;
  anilistId?: number | null;
  animeId?: number | null;
  anidbId?: number | null;
  episodeNumber: number;
  type: "sub" | "dub";
  sources: PipelineEncodedSource[];
  subtitles: PipelineSubtitleTrack[];
  metadata?: Record<string, any>;
  completedAt: string;
  allTrackPayloads?: PipelineEpisodeResult[];
}

export interface EnqueueRequest {
  anilistId?: number;
  animeId?: number;
  anidbId?: number;
  episodeNumbers: number[];
  types?: ("sub" | "dub")[];
  knownTitles?: string[];
  metadata?: Record<string, any>;
  callbackUrl?: string;
}

export interface EnqueueResponse {
  queuedJobs: {
    id: number;
    anilistId?: number | null;
    animeId?: number | null;
    anidbId?: number | null;
    episodeNumber: number;
    types: ("sub" | "dub")[];
  }[];
  skippedExisting: number;
}

export interface ActiveBatchSummary {
  id: number;
  status: string;
  kaggleUsername: string | null;
  datasetSlug: string | null;
  kernelSlug: string | null;
  jobCount: number;
  totalBytes: number;
  elapsedSeconds: number;
  heartbeatAt: string;
  mode?: "vm_remux" | "kaggle_gpu";
}

export interface KaggleAccountStatus {
  username: string;
  activeTasks: number; // 0, 1, or 2
  maxTasks: number; // strictly 2
  isBusy: boolean; // activeTasks >= 2
  slots: [boolean, boolean]; // [slot1Occupied, slot2Occupied]
}

export interface PipelineStats {
  activeBatch: ActiveBatchSummary | null;
  activeBatches: ActiveBatchSummary[];
  concurrency: {
    active: number;
    max: number; // total kaggle accounts * 2
    accountsCount: number;
    maxPerAccount: number; // 2
    vmActive?: number;
    vmMax?: number;
  };
  queue: {
    queued: number;
    downloading: number;
    staged: number;
    encoding: number;
    completed: number;
    failed: number;
    paused: number;
    total: number;
    stagedRemux?: number;
    stagedGpu?: number;
  };
  storage: {
    stagedBytes: number;
    stagedCount: number;
    maxBatchItems: number;
    maxStagingBytes: number;
    minFreeBytes: number;
    stagingDir: string;
    isAtCapacity?: boolean;
  };
  accounts: {
    kaggle: KaggleAccountStatus[];
    huggingFace: { owner: string; bucket: string }[];
  };
  engine: {
    isRunning: boolean;
    isPaused: boolean;
    uptimeSeconds: number;
    lastWatchdogRun: string | null;
    pendingCallbacks?: number;
  };
}

export interface AnimeResolvedMetadata {
  anilistId: number;
  animeId?: number;
  anidbId?: number;
  malId?: number;
  tsukihimeId?: number;
  titleRomaji?: string;
  titleEnglish?: string;
  titleNative?: string;
  primaryTitle: string;
  synonyms: string[];
  totalEpisodes?: number;
  coverImage?: string;
  status?: string;
  source: string;
}
