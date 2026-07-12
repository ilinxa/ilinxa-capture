export interface SourceMetadata {
  duration: number;
  width: number;
  height: number;
  fps: number;
}

export interface MetadataResponse extends SourceMetadata {
  codec: string;
  size_bytes: number;
  format: string;
}

export interface FramesInfo {
  count: number;
  files: string[];
  urls: string[];
}

export interface SheetsInfo {
  count: number;
  mode: number;
  grid: string;
  files: string[];
  urls: string[];
}

export interface ExtractResponse {
  job_id: string;
  status: "completed";
  frames: FramesInfo;
  source_metadata: SourceMetadata;
  processing_time_ms: number;
}

export interface ComposeResponse {
  job_id: string;
  status: "completed";
  sheets: SheetsInfo;
  processing_time_ms: number;
}

export interface CombinedResponse {
  job_id: string;
  status: "completed";
  frames: FramesInfo;
  sheets: SheetsInfo;
  source_metadata: SourceMetadata;
  processing_time_ms: number;
}

export interface AsyncJobResponse {
  job_id: string;
  status: "pending";
  poll_url: string;
}

export interface JobPollPending {
  job_id: string;
  status: "pending" | "processing";
  progress: null;
  started_at: string | null;
}

export interface JobPollFailed {
  job_id: string;
  status: "failed";
  error: string | null;
  failed_at: string | null;
}

// Completed returns raw ExtractResponse (has status: "completed")
// All three share `status` field → discriminated union
export type JobPollResponse = ExtractResponse | JobPollPending | JobPollFailed;

// Compose jobs return ComposeResponse (with `sheets`) when completed
export type ComposeJobPollResponse = ComposeResponse | JobPollPending | JobPollFailed;

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

// ─── Video Download ──────────────────────────────────────────────────

export interface YtdlpFormat {
  format_id: string;
  ext: string;
  width: number | null;
  height: number | null;
  fps: number | null;
  vcodec: string;
  acodec: string;
  filesize: number | null;
  filesize_approx: number | null;
  format_note: string;
  resolution: string;
}

export interface VideoFormatsResponse {
  title: string;
  duration: number;
  formats: YtdlpFormat[];
}

export interface VideoDownloadResponse {
  job_id: string;
  status: "completed";
  video: {
    filename: string;
    filesize: number;
    ext: string;
    download_url: string;
  };
  processing_time_ms: number;
}

export type VideoDownloadJobPollResponse =
  | VideoDownloadResponse
  | JobPollPending
  | JobPollFailed;

// ─── HLS Discovery ──────────────────────────────────────────────────

export interface DiscoveredStream {
  url: string;
  source: string;
}

export interface HlsDiscoverResponse {
  page_url: string;
  page_title: string | null;
  streams: DiscoveredStream[];
}
