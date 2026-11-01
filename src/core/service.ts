import { readdir, rm, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Env } from "../lib/env.js";
import {
  JobBusyError,
  UnsupportedFormatError,
  ValidationError,
  VideoTooLongError,
} from "../utils/errors.js";
import { extractAudio } from "./audio.js";
import { buildFileUrls } from "./file-urls.js";
import { composeGrid, type FrameLabel } from "./composer.js";
import {
  VIDEO_DOWNLOAD_PRESETS,
  downloadVideo,
  downloadVideoWithFormat,
  isUrl,
  type VideoDownloadPreset,
} from "./downloader.js";
import { extractFrames } from "./extractor.js";
import type { TimeRange } from "./ffmpeg.js";
import type { InputPolicy } from "./input-policy.js";
import type {
  JobContext,
  JobManager,
  JobProgress,
  JobState,
  JobType,
  TaskFunction,
} from "./job-manager.js";
import {
  readManifest,
  writeManifest,
  type Manifest,
  type ManifestFrame,
} from "./manifest.js";
import { getVideoMetadata, type VideoMetadata } from "./metadata.js";
import { compareNatural } from "./natural-sort.js";
import type {
  AudioOptions,
  CombinedOptions,
  ComposeOptions,
  ExtractOptions,
  ShotsOptions,
  VideoDownloadOptions,
} from "./options.js";
import { resolvePreset, type PresetName, type ResolvedPreset } from "./presets.js";
import { detectShots, extractShotFrames, planShotFrames } from "./shots.js";
import { resolveRange } from "./timecode.js";

// Readable as "video" by FFmpeg, but they pull in other files or streams.
const INDIRECT_FORMATS = new Set(["hls", "applehttp", "concat", "lavfi", "tty"]);

const PROBE_TIMEOUT_MS = 10 * 60 * 1000;

export type SourceInput =
  | { kind: "local"; path: string }
  | { kind: "url"; url: string }
  | { kind: "upload"; path: string };

export interface RunOptions {
  async?: boolean | undefined;
  webhookUrl?: string | undefined;
  onProgress?: ((progress: JobProgress) => void) | undefined;
}

export type Submission<T> =
  | { status: "accepted"; jobId: string }
  | { status: "completed"; jobId: string; result: T };

export interface SourceSummary {
  duration: number;
  width: number;
  height: number;
  fps: number;
}

export interface FrameSet {
  count: number;
  files: string[];
  urls: string[];
  /** Source time of each frame in seconds. Parallel to files. */
  timestamps: number[];
}

export interface SheetSet {
  count: number;
  mode: number;
  grid: string;
  files: string[];
  urls: string[];
}

export interface ExtractResult {
  job_id: string;
  status: "completed";
  frames: FrameSet;
  source_metadata: SourceSummary;
  range: TimeRange | null;
  manifest_url: string;
  processing_time_ms: number;
}

export interface ComposeResult {
  job_id: string;
  status: "completed";
  sheets: SheetSet;
  processing_time_ms: number;
}

export interface CombinedResult extends ExtractResult {
  sheets: SheetSet;
}

export interface ShotEntry {
  index: number;
  start: number;
  end: number;
  duration: number;
  /** Indexes into the job's frames. */
  frames: number[];
}

export interface ShotsResult {
  job_id: string;
  status: "completed";
  shots: { count: number; items: ShotEntry[] };
  frames: FrameSet;
  source_metadata: SourceSummary;
  range: TimeRange | null;
  manifest_url: string;
  processing_time_ms: number;
}

export interface AudioResult {
  job_id: string;
  status: "completed";
  audio: {
    file: string;
    url: string;
    format: string;
    stream: number;
    sample_rate: number;
    channels: number;
    duration: number;
    size_bytes: number;
  };
  /** Add this to a time in the audio to get a time in the source video. */
  timeline_offset: number;
  source_metadata: SourceSummary;
  range: TimeRange | null;
  processing_time_ms: number;
}

export interface VideoDownloadResult {
  job_id: string;
  status: "completed";
  video: {
    filename: string;
    filesize: number;
    ext: string;
    download_url: string;
    file_path: string;
  };
  processing_time_ms: number;
}

/** Rate in frames per second from either way of asking for it. */
export function resolveFps(options: {
  fps?: number | undefined;
  every_seconds?: number | undefined;
}): number {
  const { fps, every_seconds: everySeconds } = options;
  if (fps !== undefined && everySeconds !== undefined) {
    throw new ValidationError("Provide either 'fps' or 'every_seconds', not both");
  }
  if (everySeconds !== undefined) return 1 / everySeconds;
  if (fps !== undefined) return fps;
  throw new ValidationError("Provide 'fps' or 'every_seconds'");
}

function roundTime(seconds: number): number {
  return Math.round(seconds * 1_000_000) / 1_000_000;
}

function summarize(metadata: VideoMetadata): SourceSummary {
  return {
    duration: metadata.duration,
    width: metadata.width,
    height: metadata.height,
    fps: metadata.fps,
  };
}

function toManifestFrames(files: string[], times: number[]): ManifestFrame[] {
  return files.map((file, index) => ({
    index,
    file: file.split(/[\\/]/).pop() ?? file,
    pts_time: roundTime(times[index] ?? 0),
  }));
}

function manifestUrl(jobId: string): string {
  return `/api/v1/files/${jobId}/manifest.json`;
}

/**
 * Every pipeline, in one place. REST handlers and MCP tools translate requests
 * and responses around these methods and hold no processing logic of their own,
 * so the two interfaces cannot drift apart.
 *
 * Requests fail fast on anything checkable up front. Downloading and everything
 * after it happens inside the job, where timeout, cancel and the concurrency
 * limit all apply.
 */
export class CaptureService {
  private readonly env: Env;
  private readonly jobs: JobManager;
  private readonly policy: InputPolicy;

  constructor(env: Env, jobs: JobManager, policy: InputPolicy) {
    this.env = env;
    this.jobs = jobs;
    this.policy = policy;
  }

  /** Classify a source string, refusing it now if policy forbids it. */
  async resolveSource(source: string): Promise<SourceInput> {
    if (isUrl(source)) return { kind: "url", url: source };
    return { kind: "local", path: await this.policy.resolve(source) };
  }

  /** Metadata for a path or URL. Outside the queue: it is short and read-only. */
  async probe(source: string): Promise<VideoMetadata> {
    const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    const input = await this.resolveSource(source);

    if (input.kind === "url") {
      const path = await downloadVideo(input.url, { signal });
      try {
        return checkInput(await getVideoMetadata(path, { signal }));
      } finally {
        await unlink(path).catch(() => {
          // Temp file cleanup is best-effort
        });
      }
    }

    return checkInput(await getVideoMetadata(input.path, { signal }));
  }

  /** Metadata for a file this server already holds, such as an upload. */
  async probeFile(path: string): Promise<VideoMetadata> {
    const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    return checkInput(await getVideoMetadata(path, { signal }));
  }

  async extract(
    source: SourceInput,
    options: ExtractOptions,
    run: RunOptions = {},
  ): Promise<Submission<ExtractResult>> {
    const fps = resolveFps(options);
    const preset = resolvePreset(options.preset, options);

    return this.submit("extract", run, (ctx, jobId) =>
      this.withSource(source, options, ctx, run, async (path, metadata, range) => {
        const startTime = Date.now();
        const frames = await this.extractStage(
          jobId,
          path,
          metadata,
          range,
          fps,
          preset,
          ctx,
          run,
        );

        await writeManifest(this.jobs.getJobDir(jobId), {
          version: 1,
          preset: options.preset,
          fps,
          range: range ?? null,
          frames: toManifestFrames(frames.files, frames.timestamps),
        });

        return {
          job_id: jobId,
          status: "completed",
          frames,
          source_metadata: summarize(metadata),
          range: range ?? null,
          manifest_url: manifestUrl(jobId),
          processing_time_ms: Date.now() - startTime,
        };
      }),
    );
  }

  async extractAndCompose(
    source: SourceInput,
    options: CombinedOptions,
    run: RunOptions = {},
  ): Promise<Submission<CombinedResult>> {
    const fps = resolveFps(options);
    const preset = resolvePreset(options.preset, options);

    return this.submit("combined", run, (ctx, jobId) =>
      this.withSource(source, options, ctx, run, async (path, metadata, range) => {
        const startTime = Date.now();
        const frames = await this.extractStage(
          jobId,
          path,
          metadata,
          range,
          fps,
          preset,
          ctx,
          run,
        );

        const manifest: Manifest = {
          version: 1,
          preset: options.preset,
          fps,
          range: range ?? null,
          frames: toManifestFrames(frames.files, frames.timestamps),
        };
        const sheets = await this.composeStage(
          jobId,
          frames.files,
          frames.timestamps.map((time) => ({ time })),
          fps,
          this.sheetEdge(options.max_sheet_edge, options.preset),
          options,
          manifest,
          ctx,
          run,
        );

        return {
          job_id: jobId,
          status: "completed",
          frames,
          sheets,
          source_metadata: summarize(metadata),
          range: range ?? null,
          manifest_url: manifestUrl(jobId),
          processing_time_ms: Date.now() - startTime,
        };
      }),
    );
  }

  async detectShots(
    source: SourceInput,
    options: ShotsOptions,
    run: RunOptions = {},
  ): Promise<Submission<ShotsResult>> {
    const preset = resolvePreset(options.preset, options);

    return this.submit("shots", run, (ctx, jobId) =>
      this.withSource(source, options, ctx, run, async (path, metadata, range) => {
        const startTime = Date.now();
        const span = range ?? { start: 0, end: metadata.duration };

        const shots = await detectShots({
          videoPath: path,
          threshold: options.scene_threshold,
          minShotSeconds: options.min_shot_seconds,
          span,
          range,
          signal: ctx.signal,
          onProgress: (percent) =>
            report(ctx, run, { stage: "detecting", percent: Math.floor(percent) }),
        });

        const targets = planShotFrames(
          shots,
          options.frame_positions,
          metadata.fps > 0 ? 1 / metadata.fps : 0.04,
        );
        const captured = await extractShotFrames({
          videoPath: path,
          outputDir: join(this.jobs.getJobDir(jobId), "frames"),
          targets,
          preset,
          signal: ctx.signal,
          onProgress: (percent) =>
            report(ctx, run, { stage: "capturing", percent: Math.floor(percent) }),
        });

        const frames: FrameSet = {
          count: captured.length,
          files: captured.map((frame) => frame.file),
          urls: buildFileUrls(jobId, captured.map((frame) => frame.file)),
          timestamps: captured.map((frame) => roundTime(frame.time)),
        };

        const items: ShotEntry[] = shots.map((shot) => ({
          index: shot.index,
          start: roundTime(shot.start),
          end: roundTime(shot.end),
          duration: roundTime(shot.duration),
          frames: captured.flatMap((frame, i) =>
            frame.shot === shot.index ? [i] : [],
          ),
        }));

        await writeManifest(this.jobs.getJobDir(jobId), {
          version: 1,
          preset: options.preset,
          fps: null,
          range: range ?? null,
          frames: captured.map((frame, index) => ({
            index,
            file: basename(frame.file),
            pts_time: roundTime(frame.time),
            shot: frame.shot,
            position: frame.position,
          })),
          shots: items,
        });

        return {
          job_id: jobId,
          status: "completed",
          shots: { count: items.length, items },
          frames,
          source_metadata: summarize(metadata),
          range: range ?? null,
          manifest_url: manifestUrl(jobId),
          processing_time_ms: Date.now() - startTime,
        };
      }),
    );
  }

  async extractAudio(
    source: SourceInput,
    options: AudioOptions,
    run: RunOptions = {},
  ): Promise<Submission<AudioResult>> {
    return this.submit("audio", run, (ctx, jobId) =>
      this.withSource(source, options, ctx, run, async (path, metadata, range) => {
        const startTime = Date.now();

        const stream = metadata.audio_streams[options.stream];
        if (!stream) {
          throw new ValidationError(
            metadata.audio_streams.length === 0
              ? "This video has no audio"
              : `No audio stream ${options.stream}: this video has ${metadata.audio_streams.length}`,
          );
        }

        const duration = range ? range.end - range.start : metadata.duration;
        const audio = await extractAudio({
          videoPath: path,
          outputDir: join(this.jobs.getJobDir(jobId), "audio"),
          format: options.format,
          stream: options.stream,
          sampleRate: options.sample_rate,
          channels: options.channels,
          range,
          durationSeconds: duration,
          signal: ctx.signal,
          onProgress: (percent) =>
            report(ctx, run, { stage: "extracting", percent: Math.floor(percent) }),
        });

        return {
          job_id: jobId,
          status: "completed",
          audio: {
            file: audio.file,
            url: `/api/v1/files/${jobId}/audio/${basename(audio.file)}`,
            format: options.format,
            stream: options.stream,
            sample_rate: options.sample_rate ?? stream.sample_rate,
            channels: options.channels ?? stream.channels,
            duration: roundTime(duration),
            size_bytes: audio.sizeBytes,
          },
          timeline_offset: range?.start ?? 0,
          source_metadata: summarize(metadata),
          range: range ?? null,
          processing_time_ms: Date.now() - startTime,
        };
      }),
    );
  }

  async compose(
    options: ComposeOptions,
    run: RunOptions = {},
  ): Promise<Submission<ComposeResult>> {
    const { job_id: inputJobId, frames: inputFrames, timestamps, fps } = options;

    if (inputJobId && inputFrames) {
      throw new ValidationError("Provide either 'job_id' or 'frames', not both");
    }
    if (!inputJobId && !inputFrames) {
      throw new ValidationError("Either 'job_id' or 'frames' must be provided");
    }
    if (timestamps && timestamps.length !== inputFrames?.length) {
      throw new ValidationError("'timestamps' must match 'frames' one to one");
    }

    if (inputJobId) {
      const job = this.jobs.getJob(inputJobId);
      if (job.status === "pending" || job.status === "processing") {
        throw new JobBusyError(inputJobId);
      }

      const source = await this.loadJobFrames(job);
      await this.jobs.reopenJob(inputJobId, {
        type: job.type === "extract" ? "combined" : job.type,
        webhookUrl: run.webhookUrl,
      });

      // Earlier results stay on the job: composing adds sheets, it loses nothing.
      const previous = (job.result ?? {}) as Record<string, unknown>;
      return this.run(inputJobId, run, async (ctx) => {
        const startTime = Date.now();
        await rm(join(this.jobs.getJobDir(inputJobId), "sheets"), {
          recursive: true,
          force: true,
        });

        const sheets = await this.composeStage(
          inputJobId,
          source.files,
          source.labels,
          fps ?? source.manifest?.fps ?? 1,
          this.sheetEdge(options.max_sheet_edge, source.manifest?.preset ?? null),
          options,
          source.manifest,
          ctx,
          run,
        );

        return {
          ...previous,
          job_id: inputJobId,
          status: "completed",
          sheets,
          processing_time_ms: Date.now() - startTime,
        };
      });
    }

    if (options.overlay_timestamp && !fps && !timestamps) {
      throw new ValidationError(
        "'fps' or 'timestamps' is required when 'overlay_timestamp' is enabled with 'frames'",
      );
    }

    const frames = await Promise.all(
      (inputFrames ?? []).map((frame) => this.policy.resolve(frame)),
    );
    const labels = timestamps?.map((time) => ({ time }));

    return this.submit("compose", run, async (ctx, jobId) => {
      const startTime = Date.now();
      const sheets = await this.composeStage(
        jobId,
        frames,
        labels,
        fps ?? 1,
        this.sheetEdge(options.max_sheet_edge, null),
        options,
        null,
        ctx,
        run,
      );

      return {
        job_id: jobId,
        status: "completed",
        sheets,
        processing_time_ms: Date.now() - startTime,
      };
    });
  }

  async downloadVideo(
    options: VideoDownloadOptions,
    run: RunOptions = {},
  ): Promise<Submission<VideoDownloadResult>> {
    const { url, preset, format_selector: formatSelector } = options;

    if (preset && formatSelector) {
      throw new ValidationError(
        "Provide either 'preset' or 'format_selector', not both",
      );
    }

    const presetKey: VideoDownloadPreset = preset ?? "best";
    const resolvedSelector =
      formatSelector ?? VIDEO_DOWNLOAD_PRESETS[presetKey].formatSelector;

    return this.submit("video_download", run, async (ctx, jobId) => {
      const startTime = Date.now();
      report(ctx, run, { stage: "downloading", percent: null });

      const result = await downloadVideoWithFormat({
        url,
        outputDir: join(this.jobs.getJobDir(jobId), "video"),
        formatSelector: resolvedSelector,
        mergeFormat: options.merge_format,
        headers: options.headers,
        signal: ctx.signal,
      });

      return {
        job_id: jobId,
        status: "completed",
        video: {
          filename: result.filename,
          filesize: result.filesize,
          ext: result.ext,
          download_url: `/api/v1/jobs/${jobId}/video`,
          file_path: result.filePath,
        },
        processing_time_ms: Date.now() - startTime,
      };
    });
  }

  /** Create a job for a new piece of work and run it. */
  private async submit<T>(
    type: JobType,
    run: RunOptions,
    task: (ctx: JobContext, jobId: string) => Promise<T>,
  ): Promise<Submission<T>> {
    const jobId = this.jobs.generateJobId();
    await this.jobs.createJob(jobId, { type, webhookUrl: run.webhookUrl });
    return this.run(jobId, run, (ctx) => task(ctx, jobId));
  }

  private async run<T>(
    jobId: string,
    run: RunOptions,
    task: TaskFunction<T>,
  ): Promise<Submission<T>> {
    if (run.async) {
      this.jobs.runAsync(jobId, task);
      return { status: "accepted", jobId };
    }
    return {
      status: "completed",
      jobId,
      result: await this.jobs.runSync(jobId, task),
    };
  }

  /** Make the source a local file, check it, run the work, drop any temp file. */
  private async withSource<T>(
    source: SourceInput,
    times: { start?: number | string | undefined; end?: number | string | undefined },
    ctx: JobContext,
    run: RunOptions,
    work: (
      path: string,
      metadata: VideoMetadata,
      range: TimeRange | undefined,
    ) => Promise<T>,
  ): Promise<T> {
    let tempPath = source.kind === "upload" ? source.path : null;

    try {
      let path: string;
      if (source.kind === "url") {
        report(ctx, run, { stage: "downloading", percent: null });
        tempPath = await downloadVideo(source.url, { signal: ctx.signal });
        path = tempPath;
      } else {
        path = source.path;
      }

      const metadata = checkInput(
        await getVideoMetadata(path, { signal: ctx.signal }),
      );
      const range = resolveRange(times.start, times.end, metadata.duration);

      // The limit is on the work to do, so a scene from a long film is fine.
      const span = range ? range.end - range.start : metadata.duration;
      const limit = this.env.MAX_VIDEO_DURATION;
      if (limit > 0 && span > limit) {
        throw new VideoTooLongError(String(limit));
      }

      return await work(path, metadata, range);
    } finally {
      if (tempPath) {
        await unlink(tempPath).catch(() => {
          // Temp file cleanup is best-effort
        });
      }
    }
  }

  private async extractStage(
    jobId: string,
    path: string,
    metadata: VideoMetadata,
    range: TimeRange | undefined,
    fps: number,
    preset: ResolvedPreset,
    ctx: JobContext,
    run: RunOptions,
  ): Promise<FrameSet> {
    const result = await extractFrames({
      videoPath: path,
      outputDir: join(this.jobs.getJobDir(jobId), "frames"),
      fps,
      preset,
      range,
      durationSeconds: range ? range.end - range.start : metadata.duration,
      signal: ctx.signal,
      onProgress: (percent) =>
        report(ctx, run, { stage: "extracting", percent: Math.floor(percent) }),
    });

    return {
      count: result.frameCount,
      files: result.frameFiles,
      urls: buildFileUrls(jobId, result.frameFiles),
      timestamps: result.frameTimes.map(roundTime),
    };
  }

  private async composeStage(
    jobId: string,
    frameFiles: string[],
    labels: Array<FrameLabel | undefined> | undefined,
    fps: number,
    maxSheetEdge: number,
    options: {
      mode: number;
      overlay_frame_number: boolean;
      overlay_timestamp: boolean;
    },
    manifest: Manifest | null,
    ctx: JobContext,
    run: RunOptions,
  ): Promise<SheetSet> {
    const result = await composeGrid({
      frameFiles,
      outputDir: join(this.jobs.getJobDir(jobId), "sheets"),
      mode: options.mode as 1 | 4 | 16,
      overlays: {
        frameNumber: options.overlay_frame_number,
        timestamp: options.overlay_timestamp,
      },
      fps,
      labels,
      maxSheetEdge,
      signal: ctx.signal,
      onProgress: (percent) =>
        report(ctx, run, { stage: "composing", percent: Math.floor(percent) }),
    });

    if (manifest) {
      await writeManifest(this.jobs.getJobDir(jobId), {
        ...manifest,
        sheets: result.sheets,
      });
    }

    return {
      count: result.sheetCount,
      mode: result.mode,
      grid: result.grid,
      files: result.sheetFiles,
      urls: buildFileUrls(jobId, result.sheetFiles),
    };
  }

  /** Frames of a finished job, with their true times where they are known. */
  private async loadJobFrames(job: JobState): Promise<{
    files: string[];
    labels: Array<FrameLabel | undefined> | undefined;
    manifest: Manifest | null;
  }> {
    const jobDir = this.jobs.getJobDir(job.id);
    const framesDir = join(jobDir, "frames");
    const manifest = await readManifest(jobDir);

    if (manifest && manifest.frames.length > 0) {
      return {
        files: manifest.frames.map((frame) => join(framesDir, frame.file)),
        labels: manifest.frames.map((frame) => ({
          time: frame.pts_time,
          shot: frame.shot,
        })),
        manifest,
      };
    }

    // Jobs from before manifests existed have frames but no timeline.
    const entries =
      job.status === "completed" ? await readdir(framesDir).catch(() => []) : [];
    const files = entries
      .filter((f) => f.startsWith("frame_"))
      .sort(compareNatural)
      .map((f) => join(framesDir, f));

    if (files.length === 0) {
      throw new ValidationError(`No frame files found for job '${job.id}'`);
    }
    return { files, labels: undefined, manifest: null };
  }

  /** Sheets made for vision models fit model limits unless told otherwise. */
  private sheetEdge(
    requested: number | undefined,
    preset: PresetName | null,
  ): number {
    return requested ?? (preset === "llm" ? this.env.MAX_SHEET_EDGE : 0);
  }
}

function report(ctx: JobContext, run: RunOptions, progress: JobProgress): void {
  ctx.reportProgress(progress);
  run.onProgress?.(progress);
}

function checkInput(metadata: VideoMetadata): VideoMetadata {
  if (INDIRECT_FORMATS.has(metadata.format)) {
    throw new UnsupportedFormatError(
      `'${metadata.format}' files are not accepted as a video source`,
    );
  }
  return metadata;
}
