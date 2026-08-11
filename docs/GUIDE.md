<!-- wl:guide.overview -->
# ilinxa capture Configuration & Usage Guide

This guide covers all three ilinxa capture interfaces in detail: the Web UI, MCP Server, and REST API. For project overview and setup instructions, see the [README](../README.md).

## Table of Contents

- [Web UI](#web-ui)
  - [Accessing the UI](#accessing-the-ui)
  - [Step 1: Extract Frames](#step-1-extract-frames)
  - [Video Download (URL Mode)](#video-download-url-mode)
  - [Step 2: Preview & Compose](#step-2-preview--compose)
  - [Step 3: Output](#step-3-output)
  - [Tips](#tips)
- [MCP Server](#mcp-server)
  - [Overview](#overview)
  - [Setup: Stdio Transport](#setup-stdio-transport)
  - [Setup: Streamable HTTP Transport](#setup-streamable-http-transport)
  - [Tool Reference](#tool-reference)
  - [Example Workflows](#example-workflows)
  - [Error Handling (MCP)](#error-handling-mcp)
- [REST API](#rest-api)
  - [API Overview](#api-overview)
  - [Sync vs Async](#sync-vs-async)
  - [Job Lifecycle](#job-lifecycle)
  - [Endpoints](#endpoints)
  - [Webhook Integration](#webhook-integration)
  - [Error Handling (API)](#error-handling-api)
  - [Complete Workflow Examples](#complete-workflow-examples)

---

<!-- /wl -->

<!-- wl:guide.webui -->
# Web UI

The Web UI provides a visual, step-by-step workflow for extracting frames and composing grid sheets.

## Accessing the UI

**Docker (production):**

```
http://localhost:3000
```

**Local development:**

1. Start the backend: `npm run dev` (port 3000)
2. Start the UI dev server: `cd ui && npm run dev` (port 5173)
3. Open `http://localhost:5173` (Vite proxies API requests to port 3000)

The UI is organized as a **3-step wizard**:

1. **Extract** -- Select video source, configure extraction, get frames
2. **Preview & Compose** -- Review frames, configure grid composition
3. **Output** -- View composed sheets, download results

---

## Step 1: Extract Frames

### Source Input

Two input modes are available via tabs:

**File Upload:**
- Drag and drop a video file onto the upload area, or click to browse
- Supported: any video format FFmpeg can decode (MP4, MKV, WebM, AVI, MOV, etc.)
- Maximum file size: 500 MB (configurable via `MAX_UPLOAD_SIZE`)
- Shows file name and size after selection

**URL:**
- Paste any video URL (YouTube, Vimeo, Twitter/X, direct links, and 1,000+ more)
- yt-dlp handles the download automatically
- Supports age-restricted and playlist URLs (playlists download first video only)

### Metadata Check

After selecting a source, click **Check Metadata** to preview the video information:

- **Duration** -- Formatted as MM:SS
- **Resolution** -- Width x Height in pixels
- **FPS** -- Original frame rate
- **Codec** -- Video codec (e.g., h264, vp9)
- **File Size** -- Formatted in KB/MB/GB
- **Format** -- Container format (e.g., mp4, webm)

A warning appears if the video exceeds the 10-minute maximum duration.

### Extraction Configuration

**FPS (Frames Per Second):**
- Slider from 1 to 30
- Default: 2
- Lower FPS = fewer frames = faster processing
- Recommendation: 2-4 FPS for most use cases

**Quality Presets:**

| Preset | Width | Format | Quality | Best For |
|--------|-------|--------|---------|----------|
| **LLM** (default) | 1024px | JPEG | 80% | AI vision models (LLM multimodal inputs) |
| **High** | Original | PNG | Lossless | Maximum quality preservation |
| **Custom** | User-defined | User-defined | User-defined | Specific requirements |

When **Custom** is selected, additional controls appear:
- **Width** -- Target width in pixels (0 = original). Height scales proportionally.
- **Format** -- JPEG or PNG
- **Quality** -- 1-100 slider (JPEG only; higher = better quality, larger files)

### Extract Button

Click **Extract Frames** to begin. The UI shows a spinner during processing. When complete, it automatically advances to Step 2.

---

## Video Download (URL Mode)

When a URL is entered as the source, a **Download Video** card appears below the metadata preview. This lets you download the source video in your preferred format and resolution.

Video download is **independent from frame extraction** -- you can download the video AND extract frames from the same URL.

### Opening the Panel

Click the "Download Video" header to expand the card. Formats are fetched automatically when the panel opens.

### Preset Selection

Quick-select buttons for common resolutions:

| Preset | Description |
|--------|-------------|
| **Best** | Highest available quality |
| **1080p** | Up to 1920x1080 |
| **720p** | Up to 1280x720 |
| **480p** | Up to 854x480 |
| **360p** | Up to 640x360 |
| **Audio** | Audio track only |

### Advanced Format Selection

Click **Show all formats** to see a detailed table of every format yt-dlp found:

| Column | Description |
|--------|-------------|
| ID | yt-dlp format identifier |
| Ext | File extension (mp4, webm, m4a, etc.) |
| Resolution | Width x Height |
| FPS | Frame rate |
| Video | Video codec (avc1, vp9, av01, or "none") |
| Audio | Audio codec (mp4a, opus, or "none") |
| Size | Estimated file size |
| Note | yt-dlp format note (e.g., "720p", "medium") |

Select any format by clicking its radio button. This overrides the preset selection.

### Output Format

Choose the container format for the downloaded file:

| Format | Use Case |
|--------|----------|
| **MP4** (default) | Most compatible; works everywhere |
| **WebM** | Open format; smaller files for web |
| **MKV** | Supports all codecs; best for archiving |
| **MP3** | Audio only; use with the "Audio" preset |

### Downloading

Click **Download** to start. The server downloads the video, then your browser automatically saves the file. A spinner shows progress during the download.

---

## Step 2: Preview & Compose

After frame extraction, you're taken to the Preview & Compose page.

### Frame Gallery

A thumbnail grid displays all extracted frames. Each frame shows its number in the bottom-left corner. The total frame count is displayed in a badge above the gallery.

### Grid Mode

Select how frames are arranged on each sheet:

| Mode | Grid | Frames per Sheet | Description |
|------|------|------------------|-------------|
| **1** | 1x1 | 1 | Single frame per sheet (overlay-only mode) |
| **4** | 2x2 | 4 | Four frames arranged in a 2x2 grid |
| **16** | 4x4 | 16 | Sixteen frames in a 4x4 grid |

### Overlays

Optional text overlays on each frame cell:

- **Frame Number** -- Displays "Frame N" on each cell
- **Timestamp** -- Displays the calculated timestamp (MM:SS.mmm) based on frame index and FPS

When **Timestamp** is enabled, an FPS input appears. This is pre-filled from the extraction metadata but can be adjusted.

### Compose Button

Click **Compose Sheets** to generate the grid sheets. Progress is shown during composition. On completion, the UI automatically advances to Step 3.

---

## Step 3: Output

### Sheet Gallery

A visual grid displays all composed sheets. Click any sheet to open the full-size image in a new tab. The header shows the grid mode (e.g., "2x2"), sheet count, and processing time.

### Download Options

| Action | Description |
|--------|-------------|
| **Download Sheets (ZIP)** | ZIP archive containing only the composed sheet images |
| **Download All (ZIP)** | ZIP archive with all frames + sheets |
| **Individual Sheets** | Direct links to each sheet (shown when multiple sheets exist) |

---

## Tips

- **For AI vision models:** Use the LLM preset (1024px, JPEG 80%) with 4x4 grid mode. This packs 16 frames per sheet, reducing the number of API calls to vision models while maintaining enough detail for analysis.
- **FPS selection:** 2 FPS is sufficient for most videos. Use higher FPS (5-10) for fast-action content where you need more temporal detail.
- **Large videos:** For videos longer than 5 minutes, consider using async mode (available via API) to avoid timeout issues.
- **Video download:** Always check available formats first. Some videos may not have all resolutions available.

---

<!-- /wl -->

<!-- wl:guide.mcp -->
# MCP Server

## Overview

The [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) enables AI agents to call ilinxa capture tools programmatically. ilinxa capture exposes its tools for video frame extraction, composition, and download to any MCP-compatible client.

**Two transports are available:**
- **Stdio** -- For local MCP clients (Claude Desktop, Cursor, VS Code, and other MCP-compatible agents)
- **Streamable HTTP** -- For remote agents (available when the Fastify server is running)

---

## Setup: Stdio Transport

The stdio transport communicates over standard input/output. Build the project first:

```bash
npm run build
```

### Desktop MCP clients (Claude Desktop, and similar)

Add to the client's MCP configuration (for Claude Desktop this is `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ilinxa-capture": {
      "command": "node",
      "args": ["/absolute/path/to/ilinxa-capture/dist/mcp-entry.js"],
      "env": {
        "LOCAL_OUTPUT_DIR": "/absolute/path/to/ilinxa-capture/data/jobs"
      }
    }
  }
}
```

### Project-scoped MCP config (`.mcp.json`)

Many coding agents read a project-level `.mcp.json`:

```json
{
  "mcpServers": {
    "ilinxa-capture": {
      "command": "node",
      "args": ["dist/mcp-entry.js"],
      "cwd": "/absolute/path/to/ilinxa-capture"
    }
  }
}
```

### Docker

Run the MCP stdio server inside Docker:

```bash
docker run -i --rm ilinxa-capture node dist/mcp-entry.js
```

> **Note:** The stdio transport reserves stdout for JSON-RPC messages. All logging is directed to stderr.

---

## Setup: Streamable HTTP Transport

The Streamable HTTP transport is available automatically when the Fastify server is running.

**Endpoint:** `http://localhost:3000/mcp`

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/mcp` | Send tool call requests / initialize session |
| `GET` | `/mcp` | SSE stream for server-to-client notifications |
| `DELETE` | `/mcp` | Close session |

Sessions are tracked via the `mcp-session-id` header (UUID format). The server creates a session on the first `POST` and returns the session ID in the response header.

---

## Tool Reference

### capture_metadata

Get video metadata without downloading or processing.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source` | string | Yes | Video file path or URL |

**Example call:**

```json
{
  "source": "/path/to/video.mp4"
}
```

**Example response:**

```json
{
  "duration": 125.5,
  "width": 1920,
  "height": 1080,
  "fps": 29.97,
  "codec": "h264",
  "size_bytes": 15728640,
  "format": "mov"
}
```

> Read-only. No job created. ffprobe handles URLs natively, so no download is needed.

---

### capture_extract

Extract frames from a video at a specified FPS rate.

**Input:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `source` | string | Yes | -- | Video file path or URL |
| `fps` | int | Yes | -- | Frames per second (1-30) |
| `preset` | enum | No | `"llm"` | `llm`, `high`, or `custom` |
| `width` | int | No | -- | Custom width in pixels (preset=custom only) |
| `format` | enum | No | -- | `jpeg` or `png` (preset=custom only) |
| `quality` | int | No | -- | JPEG quality 1-100 (preset=custom only) |

**Example call:**

```json
{
  "source": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "fps": 2,
  "preset": "llm"
}
```

**Example response:**

```json
{
  "job_id": "cap_a1b2c3d4",
  "frames": {
    "count": 250,
    "files": [
      "/app/data/jobs/cap_a1b2c3d4/frames/frame_0001.jpg",
      "/app/data/jobs/cap_a1b2c3d4/frames/frame_0002.jpg"
    ]
  }
}
```

> URLs are auto-downloaded via yt-dlp and cleaned up after extraction. Video duration is validated against `MAX_VIDEO_DURATION`.

---

### capture_compose

Compose extracted frames into grid sheets.

**Input:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `job_id` | string | No* | -- | Job ID from a previous extraction |
| `frames` | string[] | No* | -- | Array of absolute frame file paths |
| `mode` | int | Yes | -- | Grid mode: `1`, `4`, or `16` |
| `overlay_frame_number` | bool | No | `false` | Overlay frame number on each cell |
| `overlay_timestamp` | bool | No | `false` | Overlay timestamp on each cell |
| `fps` | number | No | -- | FPS for timestamp calculation ** |

\* Exactly one of `job_id` or `frames` must be provided, not both.

\** Required when `overlay_timestamp` is `true`.

**Example call (using job_id from extraction):**

```json
{
  "job_id": "cap_a1b2c3d4",
  "mode": 4,
  "overlay_frame_number": true
}
```

**Example response:**

```json
{
  "job_id": "cap_a1b2c3d4",
  "sheets": {
    "count": 63,
    "mode": 4,
    "grid": "2x2",
    "files": [
      "/app/data/jobs/cap_a1b2c3d4/sheets/sheet_0001.jpg",
      "/app/data/jobs/cap_a1b2c3d4/sheets/sheet_0002.jpg"
    ]
  }
}
```

**Grid modes:**

| Mode | Grid | Frames per Sheet |
|------|------|------------------|
| `1` | 1x1 | 1 (overlay-only) |
| `4` | 2x2 | 4 |
| `16` | 4x4 | 16 |

---

### capture_extract_and_compose

Extract frames and compose them into grid sheets in one operation.

**Input:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `source` | string | Yes | -- | Video file path or URL |
| `fps` | int | Yes | -- | Frames per second (1-30) |
| `mode` | int | Yes | -- | Grid mode: `1`, `4`, or `16` |
| `preset` | enum | No | `"llm"` | `llm`, `high`, or `custom` |
| `overlay_frame_number` | bool | No | `false` | Overlay frame numbers |
| `overlay_timestamp` | bool | No | `false` | Overlay timestamps |
| `width` | int | No | -- | Custom width (preset=custom) |
| `format` | enum | No | -- | `jpeg` or `png` (preset=custom) |
| `quality` | int | No | -- | JPEG quality 1-100 (preset=custom) |

**Example call:**

```json
{
  "source": "/path/to/video.mp4",
  "fps": 2,
  "mode": 16,
  "preset": "llm",
  "overlay_frame_number": true,
  "overlay_timestamp": true
}
```

**Example response:**

```json
{
  "job_id": "cap_e5f6g7h8",
  "frames": {
    "count": 250,
    "files": ["/app/data/jobs/cap_e5f6g7h8/frames/frame_0001.jpg", "..."]
  },
  "sheets": {
    "count": 16,
    "mode": 16,
    "grid": "4x4",
    "files": ["/app/data/jobs/cap_e5f6g7h8/sheets/sheet_0001.jpg", "..."]
  }
}
```

---

### capture_video_formats

List available download formats for a video URL.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | Video URL (YouTube, Vimeo, direct link, etc.) |

**Example call:**

```json
{
  "url": "https://www.youtube.com/watch?v=jNQXAC9IVRw"
}
```

**Example response:**

```json
{
  "title": "Me at the zoo",
  "duration": 19.0,
  "formats": [
    {
      "format_id": "18",
      "ext": "mp4",
      "width": 640,
      "height": 360,
      "fps": 25.0,
      "vcodec": "avc1.42001E",
      "acodec": "mp4a.40.2",
      "filesize": 1552744,
      "filesize_approx": null,
      "format_note": "360p",
      "resolution": "640x360"
    },
    {
      "format_id": "22",
      "ext": "mp4",
      "width": 1280,
      "height": 720,
      "fps": 25.0,
      "vcodec": "avc1.64001F",
      "acodec": "mp4a.40.2",
      "filesize": null,
      "filesize_approx": 3842028,
      "format_note": "720p",
      "resolution": "1280x720"
    }
  ]
}
```

> Read-only. Storyboard/thumbnail formats are filtered out.

---

### capture_video_download

Download a video from a URL in a specified format and resolution.

**Input:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | Yes | -- | Video URL to download |
| `preset` | enum | No | -- | Quality preset (see table below) |
| `format_selector` | string | No | -- | Raw yt-dlp format selector (advanced) |
| `merge_format` | enum | No | `"mp4"` | Output format: `mp4`, `webm`, `mkv`, `mp3` |

> You cannot provide both `preset` and `format_selector`. If neither is provided, defaults to "best".

**Preset mapping:**

| Preset | yt-dlp Format Selector | Description |
|--------|------------------------|-------------|
| `best` | `bestvideo+bestaudio/best` | Highest available quality |
| `1080p` | `bestvideo[height<=1080]+bestaudio/best[height<=1080]` | Up to 1080p |
| `720p` | `bestvideo[height<=720]+bestaudio/best[height<=720]` | Up to 720p |
| `480p` | `bestvideo[height<=480]+bestaudio/best[height<=480]` | Up to 480p |
| `360p` | `bestvideo[height<=360]+bestaudio/best[height<=360]` | Up to 360p |
| `audio_only` | `bestaudio` | Audio track only |

**Example call (720p MP4):**

```json
{
  "url": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  "preset": "720p",
  "merge_format": "mp4"
}
```

**Example call (audio-only MP3):**

```json
{
  "url": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  "preset": "audio_only",
  "merge_format": "mp3"
}
```

**Example response:**

```json
{
  "job_id": "cap_m1n2o3p4",
  "video": {
    "filename": "Me at the zoo.mp4",
    "filesize": 475958,
    "ext": "mp4",
    "file_path": "/app/data/jobs/cap_m1n2o3p4/video/Me at the zoo.mp4"
  }
}
```

> For MP3 output, ilinxa capture internally uses `--extract-audio --audio-format mp3` instead of `--merge-output-format` (which doesn't support audio-only formats).

---

### capture_job_status

Check the status of a processing job.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `job_id` | string | Yes | Job ID (e.g., `cap_a1b2c3d4`) |

**Example call:**

```json
{
  "job_id": "cap_a1b2c3d4"
}
```

**Example response (completed):**

```json
{
  "id": "cap_a1b2c3d4",
  "type": "extract",
  "status": "completed",
  "created_at": "2026-03-21T10:00:00.000Z",
  "started_at": "2026-03-21T10:00:00.100Z",
  "completed_at": "2026-03-21T10:00:05.500Z",
  "failed_at": null,
  "error": null,
  "webhook_url": null,
  "result": { "...full result object..." },
  "processing_time_ms": 5400
}
```

**Example response (failed):**

```json
{
  "id": "cap_a1b2c3d4",
  "type": "extract",
  "status": "failed",
  "created_at": "2026-03-21T10:00:00.000Z",
  "started_at": "2026-03-21T10:00:00.100Z",
  "completed_at": null,
  "failed_at": "2026-03-21T10:00:02.000Z",
  "error": "Video duration 720s exceeds maximum of 600s",
  "webhook_url": null,
  "result": null,
  "processing_time_ms": null
}
```

---

## Example Workflows

### Two-Step: Extract then Compose

```
1. Call capture_extract:
   { "source": "/videos/lecture.mp4", "fps": 1, "preset": "llm" }
   --> Returns: { "job_id": "cap_abc123", "frames": { "count": 3600, ... } }

2. Call capture_compose:
   { "job_id": "cap_abc123", "mode": 16, "overlay_timestamp": true, "fps": 1 }
   --> Returns: { "job_id": "cap_abc123", "sheets": { "count": 225, "grid": "4x4", ... } }
```

### One-Shot: Extract and Compose

```
Call capture_extract_and_compose:
  { "source": "https://youtube.com/watch?v=...", "fps": 2, "mode": 4, "preset": "llm" }
  --> Returns: { "job_id": "cap_def456", "frames": {...}, "sheets": {...} }
```

### Video Download

```
1. Call capture_video_formats:
   { "url": "https://youtube.com/watch?v=..." }
   --> Returns: { "title": "...", "duration": 180, "formats": [...] }

2. Review formats, then call capture_video_download:
   { "url": "https://youtube.com/watch?v=...", "preset": "720p" }
   --> Returns: { "job_id": "cap_ghi789", "video": { "filename": "...", ... } }
```

---

## Error Handling (MCP)

MCP tools never throw exceptions. Errors are returned as structured values:

```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "Video duration 720s exceeds maximum of 600s"
    }
  ]
}
```

**Common errors:**

| Error | Cause |
|-------|-------|
| Video duration exceeds maximum | Video longer than `MAX_VIDEO_DURATION` (default: 600s) |
| Mode must be 1, 4, or 16 | Invalid grid mode value |
| Provide either 'job_id' or 'frames', not both | Both compose inputs provided |
| 'fps' is required when 'overlay_timestamp' is enabled | Missing FPS for timestamp overlay |
| Provide either 'preset' or 'format_selector', not both | Both download options provided |
| Job 'cap_xxx' not found | Invalid or expired job ID |

---

<!-- /wl -->

<!-- wl:guide.rest -->
# REST API

## API Overview

**Base URL:** `http://localhost:3000/api/v1`

**Authentication:** None. ilinxa capture is designed for localhost-only access.

**Content Types:**
- Request: `application/json` or `multipart/form-data` (for file uploads)
- Response: `application/json; charset=utf-8` (except file/ZIP/video downloads)

---

## Sync vs Async

By default, processing endpoints block until completion and return `200`. Set `"async": true` in the request body to return immediately with `202`.

### Synchronous (default)

```
POST /api/v1/extract  {"source": "...", "fps": 2}
--> 200 { "job_id": "cap_...", "status": "completed", "frames": {...}, ... }
```

### Asynchronous

```
POST /api/v1/extract  {"source": "...", "fps": 2, "async": true}
--> 202 { "job_id": "cap_...", "status": "pending", "poll_url": "/api/v1/jobs/cap_..." }

GET  /api/v1/jobs/cap_...
--> 200 { "job_id": "cap_...", "status": "processing" }

GET  /api/v1/jobs/cap_...
--> 200 { "job_id": "cap_...", "status": "completed", "frames": {...}, ... }
```

### With Webhook

Add `"webhook_url"` to any async request. ilinxa capture sends a POST callback when the job completes or fails.

```
POST /api/v1/extract  {"source": "...", "fps": 2, "async": true, "webhook_url": "https://example.com/hook"}
--> 202 { "job_id": "cap_...", "status": "pending", "poll_url": "..." }

... ilinxa capture POSTs to https://example.com/hook when done ...
```

**Endpoints supporting async:** `/extract`, `/compose`, `/extract-and-compose`, `/video/download`

---

## Job Lifecycle

```
pending  -->  processing  -->  completed
                           -->  failed
```

- **pending** -- Queued, waiting for a processing slot
- **processing** -- Currently executing (FFmpeg, Sharp, or yt-dlp running)
- **completed** -- Finished successfully; results available
- **failed** -- Error occurred; check the `error` field

**Storage:** Jobs are persisted as `job.json` files in `data/jobs/{job_id}/`.

**Recovery:** On server restart, jobs stuck in `pending` or `processing` are marked as `failed` with the message "Server restarted during processing".

**Cleanup:** Completed and failed jobs are automatically deleted after `LOCAL_TTL_SECONDS` (default: 3600 seconds / 1 hour).

**Job ID format:** `cap_` followed by 8 hex characters (e.g., `cap_a1b2c3d4`).

---

## Endpoints

### GET /api/v1/health

Health check endpoint.

```bash
curl http://localhost:3000/api/v1/health
```

**Response (200):**

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime": 1234.567,
  "environment": "development"
}
```

---

### POST /api/v1/metadata

Get video metadata without extracting frames.

**Request body (JSON):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `source` | string | Yes | Video file path or URL |

**JSON example:**

```bash
curl -X POST http://localhost:3000/api/v1/metadata \
  -H "Content-Type: application/json" \
  -d '{"source": "https://www.youtube.com/watch?v=jNQXAC9IVRw"}'
```

**URL with local file path:**

```bash
curl -X POST http://localhost:3000/api/v1/metadata \
  -H "Content-Type: application/json" \
  -d '{"source": "/path/to/video.mp4"}'
```

**Multipart (file upload):**

```bash
curl -X POST http://localhost:3000/api/v1/metadata \
  -F "file=@video.mp4"
```

**Response (200):**

```json
{
  "duration": 19.0,
  "width": 640,
  "height": 360,
  "fps": 25.0,
  "codec": "h264",
  "size_bytes": 1552744,
  "format": "mp4"
}
```

---

### POST /api/v1/extract

Extract frames from a video at a specified FPS rate.

**Request body (JSON):**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `source` | string | Yes | -- | Video file path or URL |
| `fps` | int | Yes | -- | Frames per second (1-30) |
| `preset` | enum | No | `"llm"` | `llm`, `high`, or `custom` |
| `width` | int | No | -- | Custom width in pixels (preset=custom) |
| `format` | enum | No | -- | `jpeg` or `png` (preset=custom) |
| `quality` | int | No | -- | JPEG quality 1-100 (preset=custom) |
| `async` | bool | No | `false` | Enable async mode |
| `webhook_url` | string | No | -- | Webhook URL for async notification |

**JSON (synchronous):**

```bash
curl -X POST http://localhost:3000/api/v1/extract \
  -H "Content-Type: application/json" \
  -d '{
    "source": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "fps": 2,
    "preset": "llm"
  }'
```

**JSON (asynchronous):**

```bash
curl -X POST http://localhost:3000/api/v1/extract \
  -H "Content-Type: application/json" \
  -d '{
    "source": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "fps": 2,
    "preset": "llm",
    "async": true,
    "webhook_url": "https://example.com/webhook"
  }'
```

**Multipart (file upload):**

```bash
curl -X POST http://localhost:3000/api/v1/extract \
  -F "file=@video.mp4" \
  -F "fps=2" \
  -F "preset=llm"
```

**Custom preset:**

```bash
curl -X POST http://localhost:3000/api/v1/extract \
  -H "Content-Type: application/json" \
  -d '{
    "source": "/path/to/video.mp4",
    "fps": 5,
    "preset": "custom",
    "width": 1920,
    "format": "png"
  }'
```

**Response (200 -- synchronous):**

```json
{
  "job_id": "cap_a1b2c3d4",
  "status": "completed",
  "frames": {
    "count": 38,
    "files": [
      "/app/data/jobs/cap_a1b2c3d4/frames/frame_0001.jpg",
      "/app/data/jobs/cap_a1b2c3d4/frames/frame_0002.jpg"
    ],
    "urls": [
      "/api/v1/files/cap_a1b2c3d4/frames/frame_0001.jpg",
      "/api/v1/files/cap_a1b2c3d4/frames/frame_0002.jpg"
    ]
  },
  "source_metadata": {
    "duration": 19.0,
    "width": 640,
    "height": 360,
    "fps": 25.0
  },
  "processing_time_ms": 3456
}
```

**Response (202 -- asynchronous):**

```json
{
  "job_id": "cap_a1b2c3d4",
  "status": "pending",
  "poll_url": "/api/v1/jobs/cap_a1b2c3d4"
}
```

---

### POST /api/v1/compose

Compose frames into grid sheets.

**Request body (JSON):**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `job_id` | string | No* | -- | Job ID from a previous extraction |
| `frames` | string[] | No* | -- | Array of absolute frame file paths |
| `mode` | int | Yes | -- | Grid mode: `1`, `4`, or `16` |
| `overlay_frame_number` | bool | No | `false` | Overlay frame numbers |
| `overlay_timestamp` | bool | No | `false` | Overlay timestamps |
| `fps` | number | No | -- | FPS for timestamp calculation ** |
| `async` | bool | No | `false` | Enable async mode |
| `webhook_url` | string | No | -- | Webhook URL |

\* Exactly one of `job_id` or `frames` is required. Providing both returns 400.

\** Required when `overlay_timestamp` is `true`.

**Using job_id:**

```bash
curl -X POST http://localhost:3000/api/v1/compose \
  -H "Content-Type: application/json" \
  -d '{
    "job_id": "cap_a1b2c3d4",
    "mode": 4,
    "overlay_frame_number": true,
    "overlay_timestamp": true,
    "fps": 2
  }'
```

**Using frames array:**

```bash
curl -X POST http://localhost:3000/api/v1/compose \
  -H "Content-Type: application/json" \
  -d '{
    "frames": [
      "/path/to/frame_001.jpg",
      "/path/to/frame_002.jpg",
      "/path/to/frame_003.jpg",
      "/path/to/frame_004.jpg"
    ],
    "mode": 4
  }'
```

**Response (200):**

```json
{
  "job_id": "cap_a1b2c3d4",
  "status": "completed",
  "sheets": {
    "count": 10,
    "mode": 4,
    "grid": "2x2",
    "files": [
      "/app/data/jobs/cap_a1b2c3d4/sheets/sheet_0001.jpg"
    ],
    "urls": [
      "/api/v1/files/cap_a1b2c3d4/sheets/sheet_0001.jpg"
    ]
  },
  "processing_time_ms": 1234
}
```

---

### POST /api/v1/extract-and-compose

Extract frames and compose them into grid sheets in one operation.

**Request body (JSON):**

All fields from [POST /extract](#post-apiv1extract) plus:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `mode` | int | Yes | -- | Grid mode: `1`, `4`, or `16` |
| `overlay_frame_number` | bool | No | `false` | Overlay frame numbers |
| `overlay_timestamp` | bool | No | `false` | Overlay timestamps |

```bash
curl -X POST http://localhost:3000/api/v1/extract-and-compose \
  -H "Content-Type: application/json" \
  -d '{
    "source": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "fps": 2,
    "preset": "llm",
    "mode": 16,
    "overlay_frame_number": true
  }'
```

**Response (200):**

```json
{
  "job_id": "cap_e5f6g7h8",
  "status": "completed",
  "frames": {
    "count": 38,
    "files": ["..."],
    "urls": ["..."]
  },
  "sheets": {
    "count": 3,
    "mode": 16,
    "grid": "4x4",
    "files": ["..."],
    "urls": ["..."]
  },
  "source_metadata": {
    "duration": 19.0,
    "width": 640,
    "height": 360,
    "fps": 25.0
  },
  "processing_time_ms": 5678
}
```

---

### GET /api/v1/jobs/:id

Poll job status. Returns different response shapes based on the job's current state.

```bash
curl http://localhost:3000/api/v1/jobs/cap_a1b2c3d4
```

**Response (pending/processing):**

```json
{
  "job_id": "cap_a1b2c3d4",
  "status": "processing",
  "progress": null,
  "started_at": "2026-03-21T10:00:00.100Z"
}
```

**Response (completed):**

Returns the full sync response body -- the same shape as the original operation's `200` response (e.g., `ExtractResponse`, `ComposeResponse`, `VideoDownloadResponse`).

**Response (failed):**

```json
{
  "job_id": "cap_a1b2c3d4",
  "status": "failed",
  "error": "Video duration exceeds maximum of 600 seconds",
  "failed_at": "2026-03-21T10:00:02.000Z"
}
```

---

### DELETE /api/v1/jobs/:id

Delete a job and all associated files (frames, sheets, video, job.json).

```bash
curl -X DELETE http://localhost:3000/api/v1/jobs/cap_a1b2c3d4
```

**Response:** `204 No Content`

Returns `404` if the job does not exist.

---

### GET /api/v1/files/:jobId/\*

Serve an individual frame or sheet file.

```bash
# Download a frame
curl -o frame.jpg http://localhost:3000/api/v1/files/cap_a1b2c3d4/frames/frame_0001.jpg

# Download a sheet
curl -o sheet.jpg http://localhost:3000/api/v1/files/cap_a1b2c3d4/sheets/sheet_0001.jpg
```

**Response:** Binary file content with appropriate MIME type (`image/jpeg`, `image/png`).

**Headers:**
- `Content-Type: image/jpeg` (or `image/png`)
- `Cache-Control: public, max-age=3600`

Path traversal is blocked -- only files within the job directory can be accessed.

---

### GET /api/v1/jobs/:id/download

Download job output as a ZIP archive.

**Query parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `include` | enum | `all` | `frames`, `sheets`, or `all` |

```bash
# Download sheets only
curl -o sheets.zip "http://localhost:3000/api/v1/jobs/cap_a1b2c3d4/download?include=sheets"

# Download frames only
curl -o frames.zip "http://localhost:3000/api/v1/jobs/cap_a1b2c3d4/download?include=frames"

# Download everything
curl -o all.zip "http://localhost:3000/api/v1/jobs/cap_a1b2c3d4/download?include=all"
```

**Response:**
- `Content-Type: application/zip`
- `Content-Disposition: attachment; filename="cap_a1b2c3d4-sheets.zip"`

The ZIP is streamed (not buffered in memory), so it works for large outputs.

Returns `400` if the job is not in `completed` status.

---

### POST /api/v1/video/formats

List available download formats for a video URL.

**Request body (JSON):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | Yes | Video URL |

```bash
curl -X POST http://localhost:3000/api/v1/video/formats \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=jNQXAC9IVRw"}'
```

**Response (200):**

```json
{
  "title": "Me at the zoo",
  "duration": 19.0,
  "formats": [
    {
      "format_id": "18",
      "ext": "mp4",
      "width": 640,
      "height": 360,
      "fps": 25.0,
      "vcodec": "avc1.42001E",
      "acodec": "mp4a.40.2",
      "filesize": 1552744,
      "filesize_approx": null,
      "format_note": "360p",
      "resolution": "640x360"
    },
    {
      "format_id": "22",
      "ext": "mp4",
      "width": 1280,
      "height": 720,
      "fps": 25.0,
      "vcodec": "avc1.64001F",
      "acodec": "mp4a.40.2",
      "filesize": null,
      "filesize_approx": 3842028,
      "format_note": "720p",
      "resolution": "1280x720"
    }
  ]
}
```

Storyboard/thumbnail formats (where both `vcodec` and `acodec` are `"none"`) are automatically filtered out.

---

### POST /api/v1/video/download

Download a video from a URL in a specified format.

**Request body (JSON):**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `url` | string | Yes | -- | Video URL |
| `preset` | enum | No | -- | Quality preset (see table) |
| `format_selector` | string | No | -- | Raw yt-dlp format selector (advanced) |
| `merge_format` | enum | No | `"mp4"` | Output format: `mp4`, `webm`, `mkv`, `mp3` |
| `async` | bool | No | `false` | Enable async mode |
| `webhook_url` | string | No | -- | Webhook URL |

> You cannot provide both `preset` and `format_selector`. If neither is provided, defaults to "best".

**Presets:**

| Preset | yt-dlp Format Selector | Description |
|--------|------------------------|-------------|
| `best` | `bestvideo+bestaudio/best` | Highest available quality |
| `1080p` | `bestvideo[height<=1080]+bestaudio/best[height<=1080]` | Up to 1080p |
| `720p` | `bestvideo[height<=720]+bestaudio/best[height<=720]` | Up to 720p |
| `480p` | `bestvideo[height<=480]+bestaudio/best[height<=480]` | Up to 480p |
| `360p` | `bestvideo[height<=360]+bestaudio/best[height<=360]` | Up to 360p |
| `audio_only` | `bestaudio` | Audio track only |

**Download 720p MP4:**

```bash
curl -X POST http://localhost:3000/api/v1/video/download \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "preset": "720p",
    "merge_format": "mp4"
  }'
```

**Download audio as MP3:**

```bash
curl -X POST http://localhost:3000/api/v1/video/download \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "preset": "audio_only",
    "merge_format": "mp3"
  }'
```

**Advanced: specific format ID:**

```bash
curl -X POST http://localhost:3000/api/v1/video/download \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "format_selector": "137+140",
    "merge_format": "mp4"
  }'
```

**Async with webhook:**

```bash
curl -X POST http://localhost:3000/api/v1/video/download \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "preset": "best",
    "async": true,
    "webhook_url": "https://example.com/hook"
  }'
```

**Response (200 -- synchronous):**

```json
{
  "job_id": "cap_m1n2o3p4",
  "status": "completed",
  "video": {
    "filename": "Me at the zoo.mp4",
    "filesize": 475958,
    "ext": "mp4",
    "download_url": "/api/v1/jobs/cap_m1n2o3p4/video"
  },
  "processing_time_ms": 8500
}
```

**Response (202 -- asynchronous):**

```json
{
  "job_id": "cap_m1n2o3p4",
  "status": "pending",
  "poll_url": "/api/v1/jobs/cap_m1n2o3p4"
}
```

---

### GET /api/v1/jobs/:id/video

Stream the downloaded video file.

```bash
curl -o video.mp4 http://localhost:3000/api/v1/jobs/cap_m1n2o3p4/video
```

**Response:** Binary video/audio stream.

**Headers:**
- `Content-Type: video/mp4` (or `video/webm`, `video/x-matroska`, `audio/mpeg`, `audio/mp4`, `audio/ogg`)
- `Content-Length: 475958`
- `Content-Disposition: attachment; filename="Me at the zoo.mp4"`

The file is streamed directly (not buffered), so this works for large video files.

Returns `400` if the job is not in `completed` status. Returns `404` if no video file exists in the job directory.

---

## Webhook Integration

Add `"webhook_url"` to any async request. ilinxa capture sends a POST to the URL when the job completes or fails.

**Configuration:**
- 10-second timeout on webhook delivery
- Failures are logged but do not affect the job
- Webhook is sent after the job state is persisted to disk

**Completed webhook payload:**

```json
{
  "event": "job.completed",
  "job_id": "cap_a1b2c3d4",
  "status": "completed",
  "result": {
    "job_id": "cap_a1b2c3d4",
    "status": "completed",
    "frames": { "count": 38, "files": ["..."], "urls": ["..."] },
    "source_metadata": { "duration": 19.0, "width": 640, "height": 360, "fps": 25.0 },
    "processing_time_ms": 3456
  },
  "error": null,
  "completed_at": "2026-03-21T10:00:05.500Z",
  "failed_at": null
}
```

**Failed webhook payload:**

```json
{
  "event": "job.failed",
  "job_id": "cap_a1b2c3d4",
  "status": "failed",
  "result": null,
  "error": "Video duration exceeds maximum of 600 seconds",
  "completed_at": null,
  "failed_at": "2026-03-21T10:00:02.000Z"
}
```

---

## Error Handling (API)

All errors return a consistent JSON structure:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": {}
  }
}
```

**Error codes:**

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `VALIDATION_ERROR` | 400 | Invalid request parameters or schema validation failure |
| `UNSUPPORTED_FORMAT` | 400 | Unsupported video or image format |
| `JOB_NOT_FOUND` | 404 | Job ID does not exist |
| `FILE_NOT_FOUND` | 404 | Requested file not found in job directory |
| `NOT_FOUND` | 404 | Route not found (catch-all) |
| `JOB_EXPIRED` | 410 | Job has been cleaned up (past TTL) |
| `VIDEO_TOO_LONG` | 413 | Video duration exceeds `MAX_VIDEO_DURATION` |
| `DOWNLOAD_FAILED` | 500 | yt-dlp video download failed |
| `FORMAT_LISTING_FAILED` | 500 | yt-dlp format listing failed |
| `PROCESSING_ERROR` | 500 | FFmpeg or Sharp processing error |

> In production mode (`NODE_ENV=production`), 500 errors return a generic message ("An unexpected error occurred") instead of internal error details.

**Validation errors include details:**

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "body/fps must be >= 1",
    "details": {
      "validation": [
        {
          "keyword": "minimum",
          "dataPath": "/fps",
          "message": "must be >= 1"
        }
      ]
    }
  }
}
```

---

## Complete Workflow Examples

### Example 1: Extract Frames from YouTube

```bash
# Step 1: Extract frames (synchronous)
curl -X POST http://localhost:3000/api/v1/extract \
  -H "Content-Type: application/json" \
  -d '{
    "source": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "fps": 2,
    "preset": "llm"
  }'
# Returns: { "job_id": "cap_abc123", "frames": { "count": 38, "urls": [...] }, ... }

# Step 2: Access individual frames
curl -o frame1.jpg http://localhost:3000/api/v1/files/cap_abc123/frames/frame_0001.jpg
```

### Example 2: One-Shot Extract + Compose with ZIP Download

```bash
# Step 1: Extract and compose in one call
curl -X POST http://localhost:3000/api/v1/extract-and-compose \
  -H "Content-Type: application/json" \
  -d '{
    "source": "/path/to/lecture.mp4",
    "fps": 1,
    "preset": "llm",
    "mode": 16,
    "overlay_frame_number": true,
    "overlay_timestamp": true
  }'
# Returns: { "job_id": "cap_def456", "sheets": { "count": 225, ... }, ... }

# Step 2: Download all sheets as ZIP
curl -o sheets.zip "http://localhost:3000/api/v1/jobs/cap_def456/download?include=sheets"
```

### Example 3: Async Extraction with Webhook

```bash
# Step 1: Start async extraction
curl -X POST http://localhost:3000/api/v1/extract \
  -H "Content-Type: application/json" \
  -d '{
    "source": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "fps": 5,
    "preset": "high",
    "async": true,
    "webhook_url": "https://example.com/my-webhook"
  }'
# Returns: { "job_id": "cap_ghi789", "status": "pending", "poll_url": "/api/v1/jobs/cap_ghi789" }

# Step 2: (Optional) Poll for status
curl http://localhost:3000/api/v1/jobs/cap_ghi789
# Returns: { "status": "processing" } or { "status": "completed", ... }

# Step 3: ilinxa capture POSTs to https://example.com/my-webhook with the full result
```

### Example 4: Download Video in 720p

```bash
# Step 1: List available formats
curl -X POST http://localhost:3000/api/v1/video/formats \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=jNQXAC9IVRw"}'
# Returns: { "title": "Me at the zoo", "formats": [...] }

# Step 2: Download in 720p
curl -X POST http://localhost:3000/api/v1/video/download \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "preset": "720p",
    "merge_format": "mp4"
  }'
# Returns: { "job_id": "cap_jkl012", "video": { "download_url": "/api/v1/jobs/cap_jkl012/video", ... } }

# Step 3: Download the video file
curl -o video.mp4 http://localhost:3000/api/v1/jobs/cap_jkl012/video
```

### Example 5: Extract Audio as MP3

```bash
curl -X POST http://localhost:3000/api/v1/video/download \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "preset": "audio_only",
    "merge_format": "mp3"
  }'
# Returns: { "video": { "filename": "Me at the zoo.mp3", "ext": "mp3", ... } }

curl -o audio.mp3 http://localhost:3000/api/v1/jobs/cap_mno345/video
```
<!-- /wl -->

