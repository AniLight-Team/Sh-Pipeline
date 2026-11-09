import type {
  EnqueueRequest,
  EnqueueResponse,
  PipelineStats,
  PipelineEpisodeResult,
  AnimeResolvedMetadata,
} from "./backend/engine/types.js";

export class KiraPipelineClient {
  private baseUrl: string;
  private secret: string;

  constructor(options: { baseUrl?: string; secret?: string } = {}) {
    this.baseUrl = (
      options.baseUrl ||
      process.env.PIPELINE_SERVICE_URL ||
      "http://127.0.0.1:4050"
    ).replace(/\/+$/, "");
    this.secret = options.secret || process.env.INTERNAL_SECRET || "anilight-pipeline-internal-secret-2026";
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      "Content-Type": "application/json",
      "x-internal-secret": this.secret,
      ...(options.headers || {}),
    };

    const res = await fetch(url, { ...options, headers });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Pipeline API Error [${res.status}]: ${errBody || res.statusText}`);
    }

    return (await res.json()) as T;
  }

  public async ping(): Promise<boolean> {
    try {
      const res = await this.request<{ ok: boolean }>("/api/health");
      return Boolean(res?.ok);
    } catch {
      return false;
    }
  }

  public async enqueue(req: EnqueueRequest): Promise<EnqueueResponse> {
    return await this.request<EnqueueResponse>("/api/pipeline/enqueue", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  public async resolveMetadata(anilistId: number): Promise<{ ok: boolean; metadata: AnimeResolvedMetadata }> {
    return await this.request<{ ok: boolean; metadata: AnimeResolvedMetadata }>(
      `/api/anime/resolve?anilistId=${anilistId}`,
    );
  }

  public async getStats(): Promise<PipelineStats> {
    return await this.request<PipelineStats>("/api/stats");
  }

  public async forceFlush(): Promise<{ ok: boolean; message: string }> {
    return await this.request<{ ok: boolean; message: string }>("/api/batches/flush", {
      method: "POST",
    });
  }

  public async triggerRecovery(): Promise<{ ok: boolean; message: string }> {
    return await this.request<{ ok: boolean; message: string }>("/api/system/recovery", {
      method: "POST",
    });
  }
}

export const pipelineClient = new KiraPipelineClient();
export type {
  EnqueueRequest,
  EnqueueResponse,
  PipelineStats,
  PipelineEpisodeResult,
  AnimeResolvedMetadata,
};

