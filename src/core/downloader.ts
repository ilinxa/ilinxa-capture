import { readdir, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DownloadFailedError,
  FormatListingFailedError,
} from "../utils/errors.js";
import { execFileAsync } from "../utils/exec.js";
import {
  isHlsUrl,
  parseHlsMasterPlaylist,
  downloadHlsStream,
  type HlsPlaylistInfo,
} from "./hls.js";

// ─── Types ──────────────────────────────────────────────────────────

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

export interface VideoFormatInfo {
  title: string;
  duration: number;
  formats: YtdlpFormat[];
}

export type VideoDownloadPreset =
  | "best"
  | "1080p"
  | "720p"
  | "480p"
  | "360p"
  | "audio_only";

export interface DownloadWithFormatOptions {
  url: string;
  outputDir: string;
  formatSelector?: string;
  mergeFormat?: string;
  headers?: Record<string, string>;
}

export interface DownloadedVideoInfo {
  filePath: string;
  filename: string;
  filesize: number;
  ext: string;
}

// ─── Presets ────────────────────────────────────────────────────────

export const VIDEO_DOWNLOAD_PRESETS: Record<
  VideoDownloadPreset,
  { formatSelector: string; label: string }
> = {
  best: {
    formatSelector: "bestvideo+bestaudio/best",
    label: "Best Quality",
  },
  "1080p": {
    formatSelector:
      "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
    label: "1080p",
  },
  "720p": {
    formatSelector:
      "bestvideo[height<=720]+bestaudio/best[height<=720]",
    label: "720p",
  },
  "480p": {
    formatSelector:
      "bestvideo[height<=480]+bestaudio/best[height<=480]",
    label: "480p",
  },
  "360p": {
    formatSelector:
      "bestvideo[height<=360]+bestaudio/best[height<=360]",
    label: "360p",
  },
  audio_only: {
    formatSelector: "bestaudio",
    label: "Audio Only",
  },
};

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Check if a source string is an HTTP/HTTPS URL.
 */
export function isUrl(source: string): boolean {
  return source.startsWith("http://") || source.startsWith("https://");
}

// ─── Existing download (used by extraction) ─────────────────────────

/**
 * Download a video from a URL using yt-dlp.
 * Returns the path to the downloaded file. Caller is responsible for cleanup.
 */
export async function downloadVideo(url: string): Promise<string> {
  const outputPath = join(tmpdir(), `ilinxa-capture-dl-${randomUUID()}.mp4`);

  try {
    await execFileAsync(
      "yt-dlp",
      ["-o", outputPath, "--no-playlist", "--merge-output-format", "mp4", url],
      { maxBuffer: 10 * 1024 * 1024 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DownloadFailedError(message);
  }

  return outputPath;
}

// ─── HLS → VideoFormatInfo conversion ────────────────────────────────

function hlsPlaylistToVideoFormatInfo(playlist: HlsPlaylistInfo): VideoFormatInfo {
  return {
    title: "HLS Stream",
    duration: 0,
    formats: playlist.variants.map((v, i) => ({
      format_id: `hls_${i}`,
      ext: "mp4",
      width: v.width,
      height: v.height,
      fps: null,
      vcodec: v.codecs?.split(",")[0] ?? "unknown",
      acodec: v.codecs?.split(",")[1]?.trim() ?? "unknown",
      filesize: null,
      filesize_approx: v.bandwidth ? Math.round(v.bandwidth / 8) : null,
      format_note: v.name ?? v.resolution ?? "unknown",
      resolution: v.resolution ?? "unknown",
    })),
  };
}

// ─── Video format listing ───────────────────────────────────────────

/**
 * List available download formats for a video URL.
 * Routes .m3u8 URLs to HLS parser; others go through yt-dlp.
 */
export async function listVideoFormats(
  url: string,
  headers?: Record<string, string>,
): Promise<VideoFormatInfo> {
  if (isHlsUrl(url)) {
    const playlist = await parseHlsMasterPlaylist(url, headers);
    return hlsPlaylistToVideoFormatInfo(playlist);
  }

  let stdout: string;
  try {
    const result = await execFileAsync(
      "yt-dlp",
      ["--dump-json", "--no-playlist", url],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new FormatListingFailedError(message);
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new FormatListingFailedError("yt-dlp returned invalid JSON");
  }

  const rawFormats = Array.isArray(data["formats"]) ? data["formats"] : [];

  const formats: YtdlpFormat[] = (rawFormats as Record<string, unknown>[])
    .filter((f) => {
      const vcodec = String(f["vcodec"] ?? "none");
      const acodec = String(f["acodec"] ?? "none");
      // Filter out storyboard/mhtml entries (no video AND no audio)
      return !(vcodec === "none" && acodec === "none");
    })
    .map((f) => ({
      format_id: String(f["format_id"] ?? ""),
      ext: String(f["ext"] ?? ""),
      width: typeof f["width"] === "number" ? f["width"] : null,
      height: typeof f["height"] === "number" ? f["height"] : null,
      fps: typeof f["fps"] === "number" ? f["fps"] : null,
      vcodec: String(f["vcodec"] ?? "none"),
      acodec: String(f["acodec"] ?? "none"),
      filesize: typeof f["filesize"] === "number" ? f["filesize"] : null,
      filesize_approx:
        typeof f["filesize_approx"] === "number"
          ? f["filesize_approx"]
          : null,
      format_note: String(f["format_note"] ?? ""),
      resolution: String(f["resolution"] ?? ""),
    }));

  return {
    title: String(data["title"] ?? "Unknown"),
    duration: typeof data["duration"] === "number" ? data["duration"] : 0,
    formats,
  };
}

// ─── Video download with format selection ───────────────────────────

/**
 * Download a video with specific format/resolution.
 * Routes .m3u8 URLs to FFmpeg; others go through yt-dlp.
 */
export async function downloadVideoWithFormat(
  opts: DownloadWithFormatOptions,
): Promise<DownloadedVideoInfo> {
  const {
    url,
    outputDir,
    formatSelector = "bestvideo+bestaudio/best",
    mergeFormat = "mp4",
    headers,
  } = opts;

  await mkdir(outputDir, { recursive: true });

  // HLS path: use FFmpeg directly
  const hlsUrl = isHlsUrl(formatSelector) ? formatSelector : isHlsUrl(url) ? url : null;
  if (hlsUrl) {
    const filename = `stream.${mergeFormat}`;
    const outputPath = join(outputDir, filename);
    await downloadHlsStream(
      isHlsUrl(formatSelector) ? formatSelector : url,
      outputPath,
      headers,
    );

    const fileStat = await stat(outputPath);
    return {
      filePath: outputPath,
      filename,
      filesize: fileStat.size,
      ext: mergeFormat,
    };
  }

  // yt-dlp path
  const outputTemplate = join(outputDir, "%(title)s.%(ext)s");

  const isAudioFormat = mergeFormat === "mp3";
  const args = ["-o", outputTemplate, "-f", formatSelector, "--no-playlist"];
  if (isAudioFormat) {
    args.push("--extract-audio", "--audio-format", mergeFormat);
  } else {
    args.push("--merge-output-format", mergeFormat);
  }
  args.push(url);

  try {
    await execFileAsync("yt-dlp", args, { maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DownloadFailedError(message);
  }

  // Scan outputDir for the downloaded file
  const entries = await readdir(outputDir);
  if (entries.length === 0) {
    throw new DownloadFailedError("No output file found after download");
  }

  const filename = entries[0]!;
  const filePath = join(outputDir, filename);
  const fileStat = await stat(filePath);

  return {
    filePath,
    filename,
    filesize: fileStat.size,
    ext: extname(filename).slice(1), // remove leading dot
  };
}
