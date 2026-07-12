import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, mcpHttpPlugin } from "./server.js";
import type { Env } from "../lib/env.js";
import type { JobManager, JobState, TaskFunction } from "../core/job-manager.js";

// ─── Mock core modules ───────────────────────────────────────────────

vi.mock("../core/metadata.js", () => ({
  getVideoMetadata: vi.fn(),
}));

vi.mock("../core/extractor.js", () => ({
  extractFrames: vi.fn(),
}));

vi.mock("../core/composer.js", () => ({
  composeGrid: vi.fn(),
}));

vi.mock("../core/downloader.js", () => ({
  isUrl: vi.fn(
    (s: string) => s.startsWith("http://") || s.startsWith("https://"),
  ),
  downloadVideo: vi.fn().mockResolvedValue("/tmp/ilinxa-capture-dl-mock.mp4"),
  listVideoFormats: vi.fn().mockResolvedValue({
    title: "Test Video",
    duration: 120,
    formats: [
      {
        format_id: "18",
        ext: "mp4",
        width: 640,
        height: 360,
        fps: 30,
        vcodec: "avc1",
        acodec: "mp4a",
        filesize: 5000000,
        filesize_approx: null,
        format_note: "360p",
        resolution: "640x360",
      },
    ],
  }),
  downloadVideoWithFormat: vi.fn().mockResolvedValue({
    filePath: "/data/jobs/cap_test1234/video/Test Video.mp4",
    filename: "Test Video.mp4",
    filesize: 12345678,
    ext: "mp4",
  }),
  VIDEO_DOWNLOAD_PRESETS: {
    best: { formatSelector: "bestvideo+bestaudio/best", label: "Best Quality" },
    "1080p": { formatSelector: "bestvideo[height<=1080]+bestaudio/best[height<=1080]", label: "1080p" },
    "720p": { formatSelector: "bestvideo[height<=720]+bestaudio/best[height<=720]", label: "720p" },
    "480p": { formatSelector: "bestvideo[height<=480]+bestaudio/best[height<=480]", label: "480p" },
    "360p": { formatSelector: "bestvideo[height<=360]+bestaudio/best[height<=360]", label: "360p" },
    audio_only: { formatSelector: "bestaudio", label: "Audio Only" },
  },
}));

vi.mock("../core/hls.js", () => ({
  discoverHlsUrls: vi.fn().mockResolvedValue({
    page_url: "https://example.com/watch",
    page_title: "Test Video Page",
    streams: [
      { url: "https://cdn.example.com/master.m3u8", source: "script_tag" },
    ],
  }),
}));

// Mock fs/promises for readdir (compose with job_id) + unlink (temp cleanup)
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readdir: vi.fn().mockResolvedValue([
      "frame_0001.jpg",
      "frame_0002.jpg",
      "frame_0003.jpg",
    ]),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
});

import { getVideoMetadata } from "../core/metadata.js";
import { extractFrames } from "../core/extractor.js";
import { composeGrid } from "../core/composer.js";
import {
  downloadVideo,
  listVideoFormats,
  downloadVideoWithFormat,
} from "../core/downloader.js";
import { discoverHlsUrls } from "../core/hls.js";
import { readdir, unlink } from "node:fs/promises";

const mockGetVideoMetadata = vi.mocked(getVideoMetadata);
const mockExtractFrames = vi.mocked(extractFrames);
const mockListVideoFormats = vi.mocked(listVideoFormats);
const mockDownloadVideoWithFormat = vi.mocked(downloadVideoWithFormat);
const mockComposeGrid = vi.mocked(composeGrid);
const mockDownloadVideo = vi.mocked(downloadVideo);
const mockDiscoverHlsUrls = vi.mocked(discoverHlsUrls);
const mockReaddir = vi.mocked(readdir);
const mockUnlink = vi.mocked(unlink);

// ─── Test Helpers ────────────────────────────────────────────────────

function createTestEnv(overrides?: Partial<Env>): Env {
  return {
    PORT: 3000,
    HOST: "0.0.0.0",
    NODE_ENV: "test",
    LOG_LEVEL: "error",
    STORAGE_MODE: "local",
    LOCAL_OUTPUT_DIR: "./data/jobs",
    LOCAL_TTL_SECONDS: 3600,
    S3_BUCKET: undefined,
    S3_REGION: undefined,
    S3_ACCESS_KEY_ID: undefined,
    S3_SECRET_ACCESS_KEY: undefined,
    S3_ENDPOINT: undefined,
    S3_URL_EXPIRY: undefined,
    MAX_VIDEO_DURATION: 600,
    MAX_UPLOAD_SIZE: 524288000,
    MAX_CONCURRENT_JOBS: 3,
    JOB_TIMEOUT: 300,
    MCP_SESSION_TTL: 1800,
    UI_DIR: "./ui/dist",
    ...overrides,
  };
}

function createMockJobManager(): JobManager {
  return {
    generateJobId: vi.fn().mockReturnValue("cap_test1234"),
    createJob: vi.fn().mockResolvedValue({
      id: "cap_test1234",
      status: "pending",
    } as JobState),
    getJob: vi.fn().mockReturnValue({
      id: "cap_test1234",
      type: "extract",
      status: "completed",
      created_at: "2026-03-20T00:00:00.000Z",
      started_at: "2026-03-20T00:00:01.000Z",
      completed_at: "2026-03-20T00:00:05.000Z",
      failed_at: null,
      error: null,
      webhook_url: null,
      result: null,
      processing_time_ms: 4000,
    } as JobState),
    runSync: vi.fn().mockImplementation(
      async <T>(_jobId: string, task: TaskFunction<T>) => task(_jobId),
    ),
    runAsync: vi.fn(),
    deleteJob: vi.fn(),
    recover: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    getJobDir: vi.fn().mockReturnValue("/data/jobs/cap_test1234"),
  } as unknown as JobManager;
}

const sampleMetadata = {
  duration: 60,
  width: 1920,
  height: 1080,
  fps: 29.97,
  codec: "h264",
  size_bytes: 15234567,
  format: "mov",
};

// ─── Test Suite ──────────────────────────────────────────────────────

describe("MCP Server", () => {
  let client: Client;
  let clientTransport: InstanceType<typeof InMemoryTransport>;
  let serverTransport: InstanceType<typeof InMemoryTransport>;
  let mockJobManager: JobManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockJobManager = createMockJobManager();

    // Default mocks
    mockGetVideoMetadata.mockResolvedValue(sampleMetadata);
    mockExtractFrames.mockResolvedValue({
      frameFiles: [
        "/data/jobs/cap_test1234/frames/frame_0001.jpg",
        "/data/jobs/cap_test1234/frames/frame_0002.jpg",
      ],
      frameCount: 2,
    });
    mockComposeGrid.mockResolvedValue({
      sheetFiles: ["/data/jobs/cap_test1234/sheets/sheet_001.jpg"],
      sheetCount: 1,
      mode: 4,
      grid: "2x2",
    });

    const mcpServer = createMcpServer({
      env: createTestEnv(),
      jobManager: mockJobManager,
    });
    [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await clientTransport.close();
    await serverTransport.close();
  });

  // ─── Server Setup ────────────────────────────────────────────────

  describe("server setup", () => {
    it("lists all 8 tools", async () => {
      const result = await client.listTools();
      expect(result.tools).toHaveLength(8);
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "capture_compose",
        "capture_extract",
        "capture_extract_and_compose",
        "capture_hls_discover",
        "capture_job_status",
        "capture_metadata",
        "capture_video_download",
        "capture_video_formats",
      ]);
    });

    it("each tool has a non-empty description", async () => {
      const result = await client.listTools();
      for (const tool of result.tools) {
        expect(tool.description).toBeTruthy();
        expect(tool.description!.length).toBeGreaterThan(10);
      }
    });
  });

  // ─── capture_metadata ────────────────────────────────────────────

  describe("capture_metadata", () => {
    it("returns metadata JSON for valid source", async () => {
      const result = await client.callTool({
        name: "capture_metadata",
        arguments: { source: "/path/to/video.mp4" },
      });

      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.type).toBe("text");
      const parsed = JSON.parse(content[0]!.text) as typeof sampleMetadata;
      expect(parsed.duration).toBe(60);
      expect(parsed.width).toBe(1920);
    });

    it("returns all 7 metadata fields", async () => {
      const result = await client.callTool({
        name: "capture_metadata",
        arguments: { source: "/path/to/video.mp4" },
      });

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual([
        "codec",
        "duration",
        "format",
        "fps",
        "height",
        "size_bytes",
        "width",
      ]);
    });

    it("returns isError when ffprobe fails", async () => {
      mockGetVideoMetadata.mockRejectedValue(new Error("ffprobe failed"));

      const result = await client.callTool({
        name: "capture_metadata",
        arguments: { source: "/nonexistent.mp4" },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain("ffprobe failed");
    });
  });

  // ─── capture_extract ─────────────────────────────────────────────

  describe("capture_extract", () => {
    it("extracts frames and returns job_id + file paths", async () => {
      const result = await client.callTool({
        name: "capture_extract",
        arguments: { source: "/path/to/video.mp4", fps: 5 },
      });

      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as {
        job_id: string;
        frames: { count: number; files: string[] };
      };
      expect(parsed.job_id).toBe("cap_test1234");
      expect(parsed.frames.count).toBe(2);
      expect(parsed.frames.files).toHaveLength(2);
    });

    it("downloads URL via yt-dlp when source is HTTP URL", async () => {
      const result = await client.callTool({
        name: "capture_extract",
        arguments: { source: "https://example.com/video.mp4", fps: 5 },
      });

      expect(result.isError).toBeFalsy();
      expect(mockDownloadVideo).toHaveBeenCalledWith(
        "https://example.com/video.mp4",
      );
      // Verify extraction used the downloaded temp path
      expect(mockExtractFrames).toHaveBeenCalledWith(
        expect.objectContaining({
          videoPath: "/tmp/ilinxa-capture-dl-mock.mp4",
        }),
      );
    });

    it("returns isError when video exceeds MAX_VIDEO_DURATION", async () => {
      mockGetVideoMetadata.mockResolvedValue({
        ...sampleMetadata,
        duration: 9999,
      });

      const result = await client.callTool({
        name: "capture_extract",
        arguments: { source: "/path/to/long-video.mp4", fps: 5 },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain("exceeds maximum");
    });

    it("returns isError when extractFrames fails", async () => {
      mockExtractFrames.mockRejectedValue(new Error("FFmpeg crashed"));

      const result = await client.callTool({
        name: "capture_extract",
        arguments: { source: "/path/to/video.mp4", fps: 5 },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain("FFmpeg crashed");
    });

    it("cleans up temp file after URL download", async () => {
      await client.callTool({
        name: "capture_extract",
        arguments: { source: "https://example.com/video.mp4", fps: 5 },
      });

      expect(mockUnlink).toHaveBeenCalledWith("/tmp/ilinxa-capture-dl-mock.mp4");
    });
  });

  // ─── capture_compose ─────────────────────────────────────────────

  describe("capture_compose", () => {
    it("composes with job_id — reads frames from directory", async () => {
      const result = await client.callTool({
        name: "capture_compose",
        arguments: { job_id: "cap_existing", mode: 4 },
      });

      expect(result.isError).toBeFalsy();
      expect(mockReaddir).toHaveBeenCalled();
      expect(mockComposeGrid).toHaveBeenCalledWith(
        expect.objectContaining({
          frameFiles: expect.arrayContaining([
            expect.stringContaining("frame_0001.jpg"),
          ]) as string[],
          mode: 4,
        }),
      );

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as {
        sheets: { count: number };
      };
      expect(parsed.sheets.count).toBe(1);
    });

    it("composes with frames array — uses provided paths", async () => {
      const frames = ["/path/frame1.jpg", "/path/frame2.jpg"];
      const result = await client.callTool({
        name: "capture_compose",
        arguments: { frames, mode: 4 },
      });

      expect(result.isError).toBeFalsy();
      expect(mockReaddir).not.toHaveBeenCalled();
      expect(mockComposeGrid).toHaveBeenCalledWith(
        expect.objectContaining({
          frameFiles: frames,
        }),
      );
    });

    it("returns isError when both job_id and frames provided", async () => {
      const result = await client.callTool({
        name: "capture_compose",
        arguments: {
          job_id: "cap_test",
          frames: ["/path/frame1.jpg"],
          mode: 4,
        },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain("not both");
    });

    it("returns isError when neither job_id nor frames provided", async () => {
      const result = await client.callTool({
        name: "capture_compose",
        arguments: { mode: 4 },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain("must be provided");
    });

    it("returns isError when overlay_timestamp=true but fps missing", async () => {
      const result = await client.callTool({
        name: "capture_compose",
        arguments: {
          frames: ["/path/frame1.jpg"],
          mode: 4,
          overlay_timestamp: true,
        },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain("fps");
    });
  });

  // ─── capture_extract_and_compose ─────────────────────────────────

  describe("capture_extract_and_compose", () => {
    it("returns both frames and sheets in response", async () => {
      const result = await client.callTool({
        name: "capture_extract_and_compose",
        arguments: { source: "/path/to/video.mp4", fps: 5, mode: 4 },
      });

      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as {
        job_id: string;
        frames: { count: number; files: string[] };
        sheets: { count: number; files: string[] };
      };
      expect(parsed.job_id).toBe("cap_test1234");
      expect(parsed.frames.count).toBe(2);
      expect(parsed.sheets.count).toBe(1);
    });

    it("downloads URL before processing", async () => {
      await client.callTool({
        name: "capture_extract_and_compose",
        arguments: {
          source: "https://example.com/video.mp4",
          fps: 5,
          mode: 4,
        },
      });

      expect(mockDownloadVideo).toHaveBeenCalledWith(
        "https://example.com/video.mp4",
      );
      expect(mockExtractFrames).toHaveBeenCalledWith(
        expect.objectContaining({
          videoPath: "/tmp/ilinxa-capture-dl-mock.mp4",
        }),
      );
    });

    it("validates video duration", async () => {
      mockGetVideoMetadata.mockResolvedValue({
        ...sampleMetadata,
        duration: 9999,
      });

      const result = await client.callTool({
        name: "capture_extract_and_compose",
        arguments: { source: "/path/to/long.mp4", fps: 5, mode: 4 },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain("exceeds maximum");
    });

    it("returns isError on extraction failure", async () => {
      mockExtractFrames.mockRejectedValue(new Error("FFmpeg crashed"));

      const result = await client.callTool({
        name: "capture_extract_and_compose",
        arguments: { source: "/path/to/video.mp4", fps: 5, mode: 4 },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain("FFmpeg crashed");
    });
  });

  // ─── capture_job_status ──────────────────────────────────────────

  describe("capture_job_status", () => {
    it("returns full job state for existing job", async () => {
      const result = await client.callTool({
        name: "capture_job_status",
        arguments: { job_id: "cap_test1234" },
      });

      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as JobState;
      expect(parsed.id).toBe("cap_test1234");
      expect(parsed.status).toBe("completed");
    });

    it("returns isError for non-existent job", async () => {
      vi.mocked(mockJobManager.getJob).mockImplementation(() => {
        throw new Error("Job 'cap_nonexistent' not found");
      });

      const result = await client.callTool({
        name: "capture_job_status",
        arguments: { job_id: "cap_nonexistent" },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain("not found");
    });

    it("returns all job fields", async () => {
      const result = await client.callTool({
        name: "capture_job_status",
        arguments: { job_id: "cap_test1234" },
      });

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as Record<string, unknown>;
      expect(parsed).toHaveProperty("id");
      expect(parsed).toHaveProperty("type");
      expect(parsed).toHaveProperty("status");
      expect(parsed).toHaveProperty("created_at");
      expect(parsed).toHaveProperty("started_at");
      expect(parsed).toHaveProperty("completed_at");
      expect(parsed).toHaveProperty("processing_time_ms");
    });
  });

  // ─── capture_video_formats ────────────────────────────────────────

  describe("capture_video_formats", () => {
    it("returns format list for valid URL", async () => {
      const result = await client.callTool({
        name: "capture_video_formats",
        arguments: { url: "https://youtube.com/watch?v=abc" },
      });

      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as {
        title: string;
        duration: number;
        formats: unknown[];
      };
      expect(parsed.title).toBe("Test Video");
      expect(parsed.duration).toBe(120);
      expect(parsed.formats).toHaveLength(1);
    });

    it("returns isError on listing failure", async () => {
      mockListVideoFormats.mockRejectedValue(
        new Error("Failed to list video formats: yt-dlp crashed"),
      );

      const result = await client.callTool({
        name: "capture_video_formats",
        arguments: { url: "https://example.com/bad" },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain("Failed to list video formats");
    });
  });

  // ─── capture_video_download ───────────────────────────────────────

  describe("capture_video_download", () => {
    it("downloads video and returns file info", async () => {
      const result = await client.callTool({
        name: "capture_video_download",
        arguments: {
          url: "https://youtube.com/watch?v=abc",
          preset: "720p",
        },
      });

      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as {
        job_id: string;
        video: { filename: string; filesize: number; ext: string; file_path: string };
      };
      expect(parsed.job_id).toBe("cap_test1234");
      expect(parsed.video.filename).toBe("Test Video.mp4");
      expect(parsed.video.filesize).toBe(12345678);
      expect(parsed.video.ext).toBe("mp4");
      expect(parsed.video.file_path).toContain("cap_test1234");
    });

    it("returns isError when both preset and format_selector provided", async () => {
      const result = await client.callTool({
        name: "capture_video_download",
        arguments: {
          url: "https://example.com/v",
          preset: "720p",
          format_selector: "137+140",
        },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain("not both");
    });

    it("returns isError on download failure", async () => {
      mockDownloadVideoWithFormat.mockRejectedValue(
        new Error("Failed to download video: network error"),
      );

      const result = await client.callTool({
        name: "capture_video_download",
        arguments: { url: "https://example.com/bad" },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain("Failed to download video");
    });

    it("passes headers to downloadVideoWithFormat", async () => {
      await client.callTool({
        name: "capture_video_download",
        arguments: {
          url: "https://example.com/v",
          headers: { Referer: "https://example.com/" },
        },
      });

      expect(mockDownloadVideoWithFormat).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: { Referer: "https://example.com/" },
        }),
      );
    });
  });

  // ─── capture_hls_discover ─────────────────────────────────────────

  describe("capture_hls_discover", () => {
    it("returns discovered HLS streams", async () => {
      const result = await client.callTool({
        name: "capture_hls_discover",
        arguments: { url: "https://example.com/watch" },
      });

      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as {
        page_url: string;
        page_title: string | null;
        streams: Array<{ url: string; source: string }>;
      };
      expect(parsed.page_url).toBe("https://example.com/watch");
      expect(parsed.page_title).toBe("Test Video Page");
      expect(parsed.streams).toHaveLength(1);
      expect(parsed.streams[0]!.url).toBe("https://cdn.example.com/master.m3u8");
    });

    it("passes headers to discoverHlsUrls", async () => {
      await client.callTool({
        name: "capture_hls_discover",
        arguments: {
          url: "https://example.com/watch",
          headers: { Cookie: "session=abc" },
        },
      });

      expect(mockDiscoverHlsUrls).toHaveBeenCalledWith(
        "https://example.com/watch",
        { Cookie: "session=abc" },
      );
    });

    it("returns isError on discovery failure", async () => {
      mockDiscoverHlsUrls.mockRejectedValue(
        new Error("Failed to fetch page: HTTP 500"),
      );

      const result = await client.callTool({
        name: "capture_hls_discover",
        arguments: { url: "https://example.com/bad" },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain("Failed to fetch page");
    });
  });
});

// ─── mcpHttpPlugin session TTL sweep ───────────────────────────────────

describe("mcpHttpPlugin session TTL sweep", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes idle sessions after MCP_SESSION_TTL and a subsequent GET 400s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const app = Fastify();
    const mockJobManager = createMockJobManager();

    await app.register(mcpHttpPlugin, {
      env: createTestEnv({ MCP_SESSION_TTL: 2 }), // 2 seconds — short TTL for the test
      jobManager: mockJobManager,
    });

    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as AddressInfo;
    const baseUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);

    try {
      // Create a session via a real MCP initialize handshake
      const clientTransport = new StreamableHTTPClientTransport(baseUrl);
      const client = new Client({ name: "ttl-test-client", version: "1.0.0" });
      await client.connect(clientTransport);

      const sessionId = clientTransport.sessionId;
      expect(sessionId).toBeTruthy();

      // Drop the client connection (aborts its standing SSE stream WITHOUT
      // sending the DELETE that would remove the session directly). While a
      // stream is open the session counts as in-flight and the sweep must
      // not touch it — only once idle can the TTL reap it.
      await client.close();

      // Advance well past both the TTL (2s) and the 60s sweep interval so the
      // idle sweep fires and removes the session
      await vi.advanceTimersByTimeAsync(65_000);

      const staleResponse = await fetch(baseUrl, {
        method: "GET",
        headers: {
          "mcp-session-id": sessionId!,
          accept: "text/event-stream",
        },
      });

      expect(staleResponse.status).toBe(400);
    } finally {
      await app.close();
    }
  });
});
