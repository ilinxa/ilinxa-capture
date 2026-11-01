<!-- wl:guide.overview -->
# ilinxa capture Configuration & Usage Guide

This guide covers all three ilinxa capture interfaces in detail: the Web UI, MCP Server, and REST API. For project overview and setup instructions, see the [README](../README.md).

## Table of Contents

- [Configuration](#configuration)
  - [Requirements](#requirements)
  - [Environment Variables](#environment-variables)
  - [Network Access](#network-access)
  - [Local File Paths](#local-file-paths)
  - [Supported Containers](#supported-containers)
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
  - [Async Jobs, Progress and Cancellation](#async-jobs-progress-and-cancellation)
  - [Compact Results and Paging](#compact-results-and-paging)
  - [Example Workflows](#example-workflows)
  - [Error Handling (MCP)](#error-handling-mcp)
- [REST API](#rest-api)
  - [API Overview](#api-overview)
  - [Sync vs Async](#sync-vs-async)
  - [Job Lifecycle](#job-lifecycle)
  - [Time Ranges](#time-ranges)
  - [Frame Times and the Manifest](#frame-times-and-the-manifest)
  - [Endpoints](#endpoints)
  - [Webhook Integration](#webhook-integration)
  - [Error Handling (API)](#error-handling-api)
  - [Complete Workflow Examples](#complete-workflow-examples)
- [Film-Length Work](#film-length-work)
- [Known Limits](#known-limits)

---

# Configuration

## Requirements

- Node 22 or newer
- FFmpeg 5.1 or newer, with ffprobe. Tested on 5.1 and 7
- yt-dlp on `PATH`, for sources given as URLs

The Docker image includes FFmpeg and yt-dlp.

## Environment Variables

Set these in the environment or in a `.env` file in the working directory. A value in the environment wins over the file. `NODE_ENV` is never read from `.env`. The stdio MCP server does not read `.env` at all, so pass its settings in the client's `env` block.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to bind. The Docker image sets `0.0.0.0` inside the container |
| `NODE_ENV` | `production` | `development`, `production` or `test`. `npm run dev` sets `development` |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug` or `trace` |
| `ALLOWED_HOSTS` | empty | Extra `Host` names to accept, comma-separated. `*` turns the check off |
| `ALLOWED_ORIGINS` | empty | Web origins that may call the server, comma-separated. `*` turns the check off |
| `ALLOWED_INPUT_DIRS` | empty | Folders callers may read by path. `*` allows any path. See [Local File Paths](#local-file-paths) |
| `LOCAL_OUTPUT_DIR` | `./data/jobs` | Where jobs keep their output. Over stdio the default is `~/.ilinxa-capture/jobs` |
| `LOCAL_TTL_SECONDS` | `86400` | How long finished jobs stay before cleanup deletes them |
| `UI_DIR` | `./ui/dist` | The built Web UI. If the folder is missing, the server runs API-only |
| `MAX_VIDEO_DURATION` | `600` | Longest span one job may process, in seconds. `0` means no limit |
| `MAX_UPLOAD_SIZE` | `524288000` | Largest upload in bytes (500 MB) |
| `MAX_CONCURRENT_JOBS` | `3` | Jobs that run at once. The rest wait in a queue |
| `JOB_TIMEOUT` | `300` | Seconds a job may run once it starts. `0` means no limit. Highest value: `2147483` |
| `MAX_SHEET_EDGE` | `2000` | Longest edge of grid sheets made from `llm` frames, in pixels. `0` means no limit |
| `MCP_SESSION_TTL` | `1800` | Seconds before an idle HTTP MCP session closes |
| `STORAGE_MODE` | `local` | Leave this as `local` |

`STORAGE_MODE` also accepts `s3`, which then requires `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. Version 0.2.0 has no S3 storage behind that setting: output always goes to `LOCAL_OUTPUT_DIR`.

## Network Access

The server has no login. By default it listens on `127.0.0.1`, so only this machine can reach it. Keep it there unless something in front of it controls access. If you bind any other address, the server logs a warning at startup.

Over HTTP, the server checks `Host` and `Origin` on every route: REST, `/mcp` and the Web UI.

- `Host` must be `localhost`, `127.0.0.1`, `[::1]`, the bind address, or a name in `ALLOWED_HOSTS`. Anything else gets `403 FORBIDDEN_HOST`.
- `Origin`, when a browser sends one, must match the host being called or be listed in `ALLOWED_ORIGINS`. Anything else gets `403 FORBIDDEN_ORIGIN`.

A container must listen on its own interface, so the Docker image sets `HOST=0.0.0.0`. The publish flag then decides who can reach it. Publish to loopback:

```bash
docker run -p 127.0.0.1:3000:3000 ilinxa-capture
```

To reach the server by another name, add that name:

```bash
docker run -p 127.0.0.1:3000:3000 -e ALLOWED_HOSTS=capture.internal ilinxa-capture
```

## Local File Paths

A `source`, and each entry in a compose `frames` list, can name a local file. What a caller may read depends on how it reached the server:

| Reached over | Default | With `ALLOWED_INPUT_DIRS` set |
|--------------|---------|-------------------------------|
| HTTP (REST and `/mcp`) | Only paths inside the output folder. Anything else gets `403 LOCAL_PATH_FORBIDDEN` | The listed folders and the output folder |
| Stdio | Any path | The listed folders and the output folder |

Separate folders with `;` on Windows and `:` elsewhere. `*` allows any path. Inside an allowed folder, a link must also resolve to an allowed folder.

With the defaults over HTTP, upload the file or give an `http` or `https` URL. A source with any other URL scheme gets `400 UNSUPPORTED_FORMAT`.

To read local films from the Docker image, mount the folder and allow it:

```bash
docker run -p 127.0.0.1:3000:3000 -v /media/films:/films:ro -e ALLOWED_INPUT_DIRS=/films ilinxa-capture
```

Then use the path inside the container, such as `/films/feature.mov`.

## Supported Containers

The server reads MP4, MOV, MKV, WebM, AVI, MPEG-TS, MPEG-PS, FLV, WMV, Ogg, MXF, DV and IVF, plus raw H.264, HEVC, MPEG-1/2 and MPEG-4 video streams. Any other file gets `400 UNSUPPORTED_FORMAT` with the reason. See [Known Limits](#known-limits).

---

<!-- /wl -->

<!-- wl:guide.webui -->
# Web UI

The Web UI provides a visual, step-by-step workflow for extracting frames and composing grid sheets.

## Accessing the UI

**Docker (production):**

```bash
docker run -p 127.0.0.1:3000:3000 ilinxa-capture
```

Then open `http://localhost:3000`.

**Local development:**

1. Start the backend: `npm run dev` (port 3000)
2. Start the UI dev server: `cd ui && npm run dev` (port 5173)
3. Open `http://localhost:5173` (Vite proxies API requests to port 3000)

The UI is organized as a **3-step wizard**:

1. **Extract** -- Select video source, configure extraction, get frames
2. **Preview & Compose** -- Review frames, configure grid composition
3. **Output** -- View composed sheets, download results

The UI covers extraction, composition and video download. Shot detection, audio extraction, time ranges, `every_seconds`, fractional rates and `max_sheet_edge` have no controls here. Use the [REST API](#rest-api) or the [MCP server](#mcp-server) for those.

---

## Step 1: Extract Frames

### Source Input

Two input modes are available via tabs:

**File Upload:**
- Drag and drop a video file onto the upload area, or click to browse
- Supported: the containers listed in [Supported Containers](#supported-containers), such as MP4, MKV, WebM, AVI and MOV
- Maximum file size: 500 MB (configurable via `MAX_UPLOAD_SIZE`)
- Shows file name and size after selection

**URL:**
- Paste any video URL (YouTube, Vimeo, Twitter/X, direct links, and 1,000+ more)
- yt-dlp handles the download automatically
- A URL that names both a video and a playlist downloads the video only

### Metadata Check

After selecting a source, click **Check Metadata** to preview the video information:

- **Duration** -- Formatted as M:SS
- **Resolution** -- Width x Height in pixels
- **FPS** -- Original frame rate
- **Codec** -- Video codec (e.g., h264, vp9)
- **File Size** -- Formatted in KB/MB/GB
- **Format** -- Container format (e.g., mp4, webm)

A warning appears if the video runs past 10 minutes. The server refuses such a video unless `MAX_VIDEO_DURATION` was raised.

### Extraction Configuration

**FPS (Frames Per Second):**
- Slider from 1 to 30
- Default: 2
- Lower FPS = fewer frames = faster processing
- Recommendation: 1-2 FPS for most use cases

**Quality Presets:**

| Preset | Width | Format | Quality | Best For |
|--------|-------|--------|---------|----------|
| **LLM** (default) | 1024px | JPEG | 80% | AI vision models (LLM multimodal inputs) |
| **High** | Original | PNG | Lossless | Maximum quality preservation |
| **Custom** | User-defined | User-defined | User-defined | Specific requirements |

When **Custom** is selected, additional controls appear:
- **Width** -- Target width in pixels. Leave it empty for the original width. Height scales proportionally.
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
- **Timestamp** -- Displays the frame's real source time (MM:SS.mmm, with hours once the timeline reaches them)

When **Timestamp** is enabled, an FPS input appears. Frames from an extraction carry their real times, so the labels on these sheets do not depend on it.

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
- **Large videos:** The UI waits on one request per job. `MAX_VIDEO_DURATION` (default: 600 seconds) and `JOB_TIMEOUT` (default: 300 seconds) both apply, and closing the page stops the job. For long videos, use the API with `async` and a time range. See [Film-Length Work](#film-length-work).
- **Video download:** Always check available formats first. Some videos may not have all resolutions available.

---

<!-- /wl -->

<!-- wl:guide.mcp -->
# MCP Server

## Overview

The [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) enables AI agents to call ilinxa capture tools programmatically. ilinxa capture exposes 12 tools to any MCP-compatible client, covering frame extraction, shot detection, audio extraction, composition, video download and job management.

**Two transports are available:**
- **Stdio** -- For local MCP clients (Claude Desktop, Cursor, VS Code, and other MCP-compatible agents)
- **Streamable HTTP** -- For remote agents (available when the Fastify server is running)

The transports differ in a few defaults:

| | Stdio | Streamable HTTP |
|---|-------|-----------------|
| Local paths | Any path. `ALLOWED_INPUT_DIRS` narrows it | Output folder only. See [Local File Paths](#local-file-paths) |
| Output folder | `~/.ilinxa-capture/jobs` unless `LOCAL_OUTPUT_DIR` is set | `LOCAL_OUTPUT_DIR` (default: `./data/jobs`) |
| Settings | Environment only, no `.env` | Environment and `.env` |
| `Host` and `Origin` checks | Not applicable | Apply to `/mcp` as to every route |

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

Paths in tool calls are paths inside the container, so mount any folder you want to read. Job output also stays in the container, and `--rm` removes it on exit.

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

Sessions are tracked via the `mcp-session-id` header (UUID format). The server creates a session on the `initialize` request and returns the session ID in the response header. A session closes after `MCP_SESSION_TTL` seconds idle (default: 1800). A request with an unknown session ID gets `404`, so the client should initialize again.

---

## Tool Reference

### capture_metadata

Get video metadata from a local file or URL. A URL is downloaded with yt-dlp first, so it takes a queue slot and can take a while.

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
  "duration": 12,
  "width": 640,
  "height": 360,
  "fps": 25,
  "codec": "h264",
  "size_bytes": 618478,
  "format": "mov",
  "audio_streams": [
    {
      "index": 0,
      "codec": "aac",
      "channels": 1,
      "sample_rate": 48000,
      "language": "eng",
      "title": null
    }
  ]
}
```

> Read-only. No job created. `format` is FFmpeg's name for the container: `mov` for MP4 and MOV, `matroska` for MKV and WebM. An `audio_streams` entry's `index` is the value to pass as `stream` to [capture_audio](#capture_audio).

---

### capture_extract

Extract frames from a video, at a rate and optionally from a time range. Returns each frame's path and real timestamp.

**Input:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `source` | string | Yes | -- | Video file path or URL |
| `fps` | number | No* | -- | Frames per second to sample, 0.001-30. Fractions are allowed |
| `every_seconds` | number | No* | -- | Sample one frame every N seconds, 0.04-3600 |
| `start` | number or string | No | -- | Start of the range: seconds, MM:SS or HH:MM:SS |
| `end` | number or string | No | -- | End of the range: seconds, MM:SS or HH:MM:SS |
| `preset` | enum | No | `"llm"` | `llm`, `high`, or `custom` |
| `width` | int | No | original | Custom width in pixels (preset=custom only) |
| `format` | enum | No | `jpeg` | `jpeg` or `png` (preset=custom only) |
| `quality` | int | No | `80` | JPEG quality 1-100 (preset=custom only) |
| `async` | bool | No | `false` | Return a job immediately instead of waiting for the result |

\* Provide exactly one of `fps` or `every_seconds`.

**Example call:**

```json
{
  "source": "/videos/long.mp4",
  "every_seconds": 30,
  "start": "01:00",
  "end": "03:00"
}
```

**Example response:**

```json
{
  "job_id": "cap_a1b2c3d4",
  "status": "completed",
  "source_metadata": {
    "duration": 660,
    "width": 320,
    "height": 180,
    "fps": 10
  },
  "range": { "start": 60, "end": 180 },
  "processing_time_ms": 109,
  "frames": {
    "count": 4,
    "files": [
      "/app/data/jobs/cap_a1b2c3d4/frames/frame_0001.jpg",
      "/app/data/jobs/cap_a1b2c3d4/frames/frame_0002.jpg",
      "/app/data/jobs/cap_a1b2c3d4/frames/frame_0003.jpg",
      "/app/data/jobs/cap_a1b2c3d4/frames/frame_0004.jpg"
    ],
    "timestamps": [60, 90, 120, 150],
    "truncated": false
  },
  "manifest_file": "/app/data/jobs/cap_a1b2c3d4/manifest.json"
}
```

> URLs are downloaded via yt-dlp and cleaned up after extraction. `MAX_VIDEO_DURATION` applies to the span processed, not the whole file. See [Time Ranges](#time-ranges) and [Compact Results and Paging](#compact-results-and-paging).

---

### capture_compose

Compose a job's frames, or a list of image files, into grid sheets.

**Input:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `job_id` | string | No* | -- | Job ID from a previous extraction |
| `frames` | string[] | No* | -- | Array of absolute frame file paths |
| `timestamps` | number[] | No | -- | Real time in seconds of each entry in `frames`, for overlays |
| `mode` | int | Yes | -- | Grid mode: `1`, `4`, or `16` |
| `fps` | number | No | -- | FPS for timestamp labels ** |
| `overlay_frame_number` | bool | No | `false` | Overlay frame number on each cell |
| `overlay_timestamp` | bool | No | `false` | Overlay the frame's real timestamp on each cell |
| `max_sheet_edge` | int | No | see *** | Longest grid sheet edge in pixels; frames shrink to fit. `0` means no limit |
| `async` | bool | No | `false` | Return a job immediately instead of waiting for the result |

\* Exactly one of `job_id` or `frames` must be provided, not both.

\** Needed only with `frames` and no `timestamps`, when `overlay_timestamp` is `true`. With `job_id`, labels use the true times in the job's manifest.

\*** `MAX_SHEET_EDGE` (default: 2000) for frames from the `llm` preset, no limit otherwise. Mode 1 refuses this option.

With `job_id`, composing replaces the job's sheets and keeps its frames. A shots job labels each cell with its shot number when an overlay is on. With `frames`, composing makes a new job. Each path must be readable under [Local File Paths](#local-file-paths) and be a JPEG, PNG or WebP image.

**Example call (using job_id from extraction):**

```json
{
  "job_id": "cap_a1b2c3d4",
  "mode": 4,
  "overlay_frame_number": true,
  "overlay_timestamp": true
}
```

**Example response:**

```json
{
  "job_id": "cap_a1b2c3d4",
  "status": "completed",
  "source_metadata": {
    "duration": 660,
    "width": 320,
    "height": 180,
    "fps": 10
  },
  "range": { "start": 60, "end": 180 },
  "processing_time_ms": 175,
  "frames": {
    "count": 4,
    "files": ["/app/data/jobs/cap_a1b2c3d4/frames/frame_0001.jpg", "..."],
    "timestamps": [60, 90, 120, 150],
    "truncated": false
  },
  "manifest_file": "/app/data/jobs/cap_a1b2c3d4/manifest.json",
  "sheets": {
    "count": 1,
    "mode": 4,
    "grid": "2x2",
    "files": ["/app/data/jobs/cap_a1b2c3d4/sheets/sheet_001.jpg"],
    "truncated": false
  }
}
```

A compose of `frames` by path returns only `job_id`, `status`, `processing_time_ms` and `sheets`. Sheets are PNG when the first frame is PNG, and JPEG otherwise.

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
| `fps` | number | No* | -- | Frames per second to sample, 0.001-30 |
| `every_seconds` | number | No* | -- | Sample one frame every N seconds, 0.04-3600 |
| `mode` | int | Yes | -- | Grid mode: `1`, `4`, or `16` |
| `start` | number or string | No | -- | Start of the range |
| `end` | number or string | No | -- | End of the range |
| `preset` | enum | No | `"llm"` | `llm`, `high`, or `custom` |
| `overlay_frame_number` | bool | No | `false` | Overlay frame numbers |
| `overlay_timestamp` | bool | No | `false` | Overlay real timestamps |
| `max_sheet_edge` | int | No | see [capture_compose](#capture_compose) | Longest grid sheet edge in pixels |
| `width` | int | No | original | Custom width (preset=custom) |
| `format` | enum | No | `jpeg` | `jpeg` or `png` (preset=custom) |
| `quality` | int | No | `80` | JPEG quality 1-100 (preset=custom) |
| `async` | bool | No | `false` | Return a job immediately instead of waiting for the result |

\* Provide exactly one of `fps` or `every_seconds`.

**Example call:**

```json
{
  "source": "/path/to/video.mp4",
  "fps": 0.5,
  "mode": 4,
  "preset": "llm",
  "overlay_frame_number": true,
  "overlay_timestamp": true
}
```

**Example response:**

```json
{
  "job_id": "cap_e5f6a7b8",
  "status": "completed",
  "source_metadata": {
    "duration": 12,
    "width": 640,
    "height": 360,
    "fps": 25
  },
  "range": null,
  "processing_time_ms": 412,
  "frames": {
    "count": 6,
    "files": ["/app/data/jobs/cap_e5f6a7b8/frames/frame_0001.jpg", "..."],
    "timestamps": [0, 2, 4, 6, 8, 10],
    "truncated": false
  },
  "manifest_file": "/app/data/jobs/cap_e5f6a7b8/manifest.json",
  "sheets": {
    "count": 2,
    "mode": 4,
    "grid": "2x2",
    "files": ["/app/data/jobs/cap_e5f6a7b8/sheets/sheet_001.jpg", "..."],
    "truncated": false
  }
}
```

---

### capture_shots

Detect the shots in a video: where each starts and ends and how long it lasts, with first, middle or last frames from each. It decodes the whole range, so pass `async: true` for long videos.

**Input:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `source` | string | Yes | -- | Video file path or URL |
| `start` | number or string | No | -- | Start of the range |
| `end` | number or string | No | -- | End of the range |
| `scene_threshold` | number | No | `0.3` | Scene change score that counts as a cut, 0.01-1. Lower finds more cuts |
| `min_shot_seconds` | number | No | `0.25` | Shortest shot to keep, 0-60. Closer cuts are ignored |
| `frame_positions` | string[] | No | `["middle"]` | Any of `first`, `middle`, `last`. `[]` for the shot list only |
| `preset` | enum | No | `"llm"` | `llm`, `high`, or `custom` |
| `width` | int | No | original | Custom width (preset=custom) |
| `format` | enum | No | `jpeg` | `jpeg` or `png` (preset=custom) |
| `quality` | int | No | `80` | JPEG quality 1-100 (preset=custom) |
| `async` | bool | No | `false` | Return a job immediately instead of waiting for the result |

**Example call:**

```json
{
  "source": "/path/to/video.mp4",
  "frame_positions": ["first", "last"]
}
```

**Example response:**

```json
{
  "job_id": "cap_68d1caff",
  "status": "completed",
  "source_metadata": {
    "duration": 12,
    "width": 640,
    "height": 360,
    "fps": 25
  },
  "range": null,
  "processing_time_ms": 322,
  "frames": {
    "count": 6,
    "files": ["/app/data/jobs/cap_68d1caff/frames/frame_0001.jpg", "..."],
    "timestamps": [0, 3.96, 4, 7.96, 8, 11.96],
    "truncated": false
  },
  "manifest_file": "/app/data/jobs/cap_68d1caff/manifest.json",
  "shots": {
    "count": 3,
    "items": [
      { "index": 1, "start": 0, "end": 4, "duration": 4, "frames": [0, 1] },
      { "index": 2, "start": 4, "end": 8, "duration": 4, "frames": [2, 3] },
      { "index": 3, "start": 8, "end": 12, "duration": 4, "frames": [4, 5] }
    ],
    "truncated": false
  }
}
```

> A shot's `frames` are indexes into the job's frames. Hard cuts are found well. Lower `scene_threshold` if dissolves are missed. To make sheets, call [capture_compose](#capture_compose) with this `job_id`.

---

### capture_audio

Export one audio track of a video for separate speech or music models.

**Input:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `source` | string | Yes | -- | Video file path or URL |
| `start` | number or string | No | -- | Start of the range |
| `end` | number or string | No | -- | End of the range |
| `format` | enum | No | `"wav"` | `wav`, `flac`, `mp3` or `m4a` |
| `stream` | int | No | `0` | Which audio stream, from `0`. See `audio_streams` in metadata |
| `sample_rate` | int | No | source rate | Sample rate in Hz, 8000-192000. See [POST /api/v1/audio](#post-apiv1audio) for the rates `mp3` and `m4a` accept |
| `channels` | int | No | as in source | `1` for mono, `2` for stereo |
| `async` | bool | No | `false` | Return a job immediately instead of waiting for the result |

**Example call:**

```json
{
  "source": "/path/to/video.mp4",
  "format": "flac",
  "sample_rate": 16000,
  "channels": 1,
  "start": "00:03",
  "end": "00:06"
}
```

**Example response:**

```json
{
  "job_id": "cap_31e1d851",
  "status": "completed",
  "audio": {
    "file": "/app/data/jobs/cap_31e1d851/audio/audio.flac",
    "url": "/api/v1/files/cap_31e1d851/audio/audio.flac",
    "format": "flac",
    "stream": 0,
    "sample_rate": 16000,
    "channels": 1,
    "duration": 3,
    "size_bytes": 68560
  },
  "timeline_offset": 3,
  "source_metadata": {
    "duration": 12,
    "width": 640,
    "height": 360,
    "fps": 25
  },
  "range": { "start": 3, "end": 6 },
  "processing_time_ms": 195
}
```

> Add `timeline_offset` to a time in the audio to get a time in the video. `sample_rate`, `channels` and `duration` report what was written. An audio job has no manifest.

---

### capture_video_formats

List available download formats for a video URL.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | Video URL (YouTube, Vimeo, HLS `.m3u8`, or direct link) |
| `headers` | object | No | HTTP headers (e.g., Referer, Cookie) for protected streams |

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
  "duration": 19,
  "formats": [
    {
      "format_id": "140",
      "ext": "m4a",
      "width": null,
      "height": null,
      "fps": null,
      "vcodec": "none",
      "acodec": "mp4a.40.2",
      "filesize": 309288,
      "filesize_approx": 309287,
      "format_note": "medium",
      "resolution": "audio only"
    },
    {
      "format_id": "134",
      "ext": "mp4",
      "width": 320,
      "height": 240,
      "fps": 15,
      "vcodec": "avc1.4D400C",
      "acodec": "none",
      "filesize": 322379,
      "filesize_approx": 322376,
      "format_note": "240p",
      "resolution": "320x240"
    }
  ]
}
```

> Read-only. Storyboard/thumbnail formats are filtered out. For an `.m3u8` URL, the title is `HLS Stream`, the duration is `0`, each variant has a `format_id` like `hls_0`, and `filesize_approx` is the variant's bandwidth in bytes per second.

---

### capture_video_download

Download a video from a URL in a specified format and resolution.

**Input:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | Yes | -- | Video URL to download |
| `preset` | enum | No | -- | Quality preset (see table below) |
| `format_selector` | string | No | -- | Raw yt-dlp format selector or HLS variant `.m3u8` URL (advanced) |
| `merge_format` | enum | No | `"mp4"` | Output format: `mp4`, `webm`, `mkv`, `mp3` |
| `headers` | object | No | -- | HTTP headers (e.g., Referer, Cookie) for protected streams |
| `async` | bool | No | `false` | Return a job immediately instead of waiting for the result |

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
  "job_id": "cap_a13608a4",
  "status": "completed",
  "video": {
    "filename": "Me at the zoo.mp4",
    "filesize": 475958,
    "ext": "mp4",
    "download_url": "/api/v1/jobs/cap_a13608a4/video",
    "file_path": "/app/data/jobs/cap_a13608a4/video/Me at the zoo.mp4"
  },
  "processing_time_ms": 2496
}
```

> For MP3 output, ilinxa capture internally uses `--extract-audio --audio-format mp3` instead of `--merge-output-format` (which doesn't support audio-only formats).

---

### capture_hls_discover

Scan a web page for HLS (`.m3u8`) stream URLs. It fetches the page HTML and searches it for playlist links.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | Web page URL to scan |
| `headers` | object | No | HTTP headers (e.g., Referer, Cookie) |

**Example response:**

```json
{
  "page_url": "https://example.com/watch",
  "page_title": "Player",
  "streams": [
    {
      "url": "https://example.com/master.m3u8",
      "source": "html_attribute"
    }
  ]
}
```

> Read-only. `source` is `html_attribute` or `script_tag`. To download a stream, pass its URL to [capture_video_download](#capture_video_download).

---

### capture_job_status

Check a job: status, progress while it runs, and its result or error when done.

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

**Example response (running):**

```json
{
  "id": "cap_a1b2c3d4",
  "type": "extract",
  "status": "processing",
  "created_at": "2026-11-01T17:31:59.100Z",
  "started_at": "2026-11-01T17:31:59.298Z",
  "completed_at": null,
  "failed_at": null,
  "error": null,
  "error_code": null,
  "webhook_url": null,
  "result": null,
  "processing_time_ms": null,
  "progress": { "stage": "extracting", "percent": 7 },
  "reopened_from": null
}
```

**Example response (completed):**

`result` holds the same [compact result](#compact-results-and-paging) the tool returned.

```json
{
  "id": "cap_a1b2c3d4",
  "type": "extract",
  "status": "completed",
  "created_at": "2026-11-01T17:33:02.128Z",
  "started_at": "2026-11-01T17:33:02.129Z",
  "completed_at": "2026-11-01T17:33:02.530Z",
  "failed_at": null,
  "error": null,
  "error_code": null,
  "webhook_url": null,
  "result": {
    "job_id": "cap_a1b2c3d4",
    "status": "completed",
    "frames": {
      "count": 4,
      "files": ["/app/data/jobs/cap_a1b2c3d4/frames/frame_0001.jpg", "..."],
      "timestamps": [60, 90, 120, 150],
      "truncated": false
    },
    "manifest_file": "/app/data/jobs/cap_a1b2c3d4/manifest.json"
  },
  "processing_time_ms": 367,
  "progress": null,
  "reopened_from": null
}
```

**Example response (failed):**

```json
{
  "id": "cap_a1b2c3d4",
  "type": "extract",
  "status": "failed",
  "created_at": "2026-11-01T17:31:58.100Z",
  "started_at": "2026-11-01T17:31:58.120Z",
  "completed_at": null,
  "failed_at": "2026-11-01T17:31:58.197Z",
  "error": "Video duration exceeds maximum of 600 seconds",
  "error_code": "VIDEO_TOO_LONG",
  "webhook_url": null,
  "result": null,
  "processing_time_ms": 77,
  "progress": null,
  "reopened_from": null
}
```

`type` is one of `extract`, `compose`, `combined`, `shots`, `audio` or `video_download`. A compose that fails on a finished job leaves it `completed`, with the reason in `error` and `error_code`.

---

### capture_job_manifest

Read a finished job's timeline one page at a time: every frame with its real timestamp, every shot, and which frames each sheet holds.

**Input:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `job_id` | string | Yes | -- | Job ID |
| `section` | enum | No | `"frames"` | `frames`, `shots` or `sheets` |
| `offset` | int | No | `0` | Items to skip |
| `limit` | int | No | `200` | Items to return, 1-1000 |

**Example call:**

```json
{
  "job_id": "cap_a1b2c3d4",
  "section": "frames",
  "offset": 200,
  "limit": 2
}
```

**Example response:**

```json
{
  "job_id": "cap_a1b2c3d4",
  "section": "frames",
  "total": 300,
  "offset": 200,
  "items": [
    { "index": 200, "file": "frame_0201.jpg", "pts_time": 30 },
    { "index": 201, "file": "frame_0202.jpg", "pts_time": 30.1 }
  ]
}
```

> Read-only. See [Frame Times and the Manifest](#frame-times-and-the-manifest) for the fields of each section. A job with no manifest, such as an audio job, returns an error.

---

### capture_job_delete

Stop a job if it is running, then delete it and all its output files.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `job_id` | string | Yes | Job ID |

**Example response:**

```json
{
  "job_id": "cap_a1b2c3d4",
  "deleted": true
}
```

---

## Async Jobs, Progress and Cancellation

`capture_extract`, `capture_compose`, `capture_extract_and_compose`, `capture_shots`, `capture_audio` and `capture_video_download` take `async`. With `async: true`, the tool returns at once:

```json
{
  "job_id": "cap_a1b2c3d4",
  "status": "pending",
  "next": "Poll capture_job_status with this job_id"
}
```

**Progress.** While a job runs, [capture_job_status](#capture_job_status) shows `progress`, such as `{ "stage": "extracting", "percent": 42 }`. The stages are `downloading`, `extracting`, `detecting`, `capturing` and `composing`. `percent` is `null` during `downloading`.

A sync call also sends `notifications/progress` if the client passes a progress token. Each notification has a step count in `progress` and text in `message`, such as `extracting 42%`. An async call sends none, so poll instead.

**Cancellation.** If the client cancels a sync call, the job stops and stays on record as failed with `error_code` `JOB_CANCELLED`. To stop an async job, call [capture_job_delete](#capture_job_delete), which also removes its output. Over stdio, a client that disconnects stops any running jobs and ends the server process.

`JOB_TIMEOUT` applies to sync and async jobs alike. See [Film-Length Work](#film-length-work).

---

## Compact Results and Paging

A film can yield thousands of frames, and every path listed costs an agent tokens. So tool results differ from REST responses:

- `frames.files`, `frames.timestamps`, `shots.items` and `sheets.files` hold at most 200 entries.
- `truncated: true` says a list was cut.
- `urls` and `manifest_url` are left out.
- `manifest_file` gives the absolute path of the job's manifest when the result has `frames`.

`capture_job_status` compacts `result` the same way. To read the rest, page through [capture_job_manifest](#capture_job_manifest), or open `manifest_file`.

---

## Example Workflows

### Two-Step: Extract then Compose

```
1. Call capture_extract:
   { "source": "/videos/lecture.mp4", "fps": 1, "preset": "llm" }
   --> Returns: { "job_id": "cap_1a2b3c4d", "frames": { "count": 600, ... } }

2. Call capture_compose:
   { "job_id": "cap_1a2b3c4d", "mode": 16, "overlay_timestamp": true }
   --> Returns: { "job_id": "cap_1a2b3c4d", "sheets": { "count": 38, "grid": "4x4", ... } }
```

### One-Shot: Extract and Compose

```
Call capture_extract_and_compose:
  { "source": "https://youtube.com/watch?v=...", "fps": 2, "mode": 4, "preset": "llm" }
  --> Returns: { "job_id": "cap_2b3c4d5e", "frames": {...}, "sheets": {...} }
```

### Shots to Sheets

```
1. Call capture_shots:
   { "source": "/videos/scene.mp4", "frame_positions": ["first", "middle", "last"] }
   --> Returns: { "job_id": "cap_3c4d5e6f", "shots": { "count": 3, ... }, "frames": {...} }

2. Call capture_compose:
   { "job_id": "cap_3c4d5e6f", "mode": 4, "overlay_timestamp": true }
   --> Returns: { "job_id": "cap_3c4d5e6f", "sheets": { "count": 3, ... } }
```

### A Long Job, Polled

```
1. Call capture_extract:
   { "source": "/videos/film.mkv", "fps": 1, "async": true }
   --> Returns: { "job_id": "cap_4d5e6f7a", "status": "pending", "next": "..." }

2. Call capture_job_status until "status" is "completed":
   { "job_id": "cap_4d5e6f7a" }

3. Call capture_job_manifest for frames past the first 200:
   { "job_id": "cap_4d5e6f7a", "offset": 200, "limit": 1000 }
```

### Video Download

```
1. Call capture_video_formats:
   { "url": "https://youtube.com/watch?v=..." }
   --> Returns: { "title": "...", "duration": 180, "formats": [...] }

2. Review formats, then call capture_video_download:
   { "url": "https://youtube.com/watch?v=...", "preset": "720p" }
   --> Returns: { "job_id": "cap_5e6f7a8b", "video": { "filename": "...", ... } }
```

---

## Error Handling (MCP)

MCP tools do not throw exceptions. Errors are returned as structured values:

```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "Video duration exceeds maximum of 600 seconds"
    }
  ]
}
```

The text is the message alone. For a job's error code, read `error_code` from [capture_job_status](#capture_job_status). Arguments that fail the input schema return the same shape, with text that starts `MCP error -32602: Input validation error`.

**Common errors:**

| Error | Cause |
|-------|-------|
| Video duration exceeds maximum of 600 seconds | Span to process is longer than `MAX_VIDEO_DURATION` (default: 600s) |
| Mode must be 1, 4, or 16 | Invalid grid mode value |
| Provide 'fps' or 'every_seconds' | Neither rate given |
| Provide either 'fps' or 'every_seconds', not both | Both rates given |
| Provide either 'job_id' or 'frames', not both | Both compose inputs provided |
| 'fps' or 'timestamps' is required when 'overlay_timestamp' is enabled with 'frames' | Missing times for timestamp overlays on frames given by path |
| Provide either 'preset' or 'format_selector', not both | Both download options provided |
| Local path is outside the allowed folders. Upload the file, or set ALLOWED_INPUT_DIRS | Path refused over HTTP. See [Local File Paths](#local-file-paths) |
| Not a readable video: ... | File is missing, damaged or not in a [supported container](#supported-containers) |
| Job 'cap_12345678' not found | Unknown job, or one deleted or past its TTL |
| Job 'cap_12345678' has no manifest | The job wrote no manifest, as with audio jobs and downloads |
| Job exceeded the JOB_TIMEOUT limit of 300 seconds and was stopped | Job ran past `JOB_TIMEOUT` |

---

<!-- /wl -->

<!-- wl:guide.rest -->
# REST API

## API Overview

**Base URL:** `http://localhost:3000/api/v1`

**Authentication:** None. ilinxa capture is designed for localhost-only access. See [Network Access](#network-access).

**Content Types:**
- Request: `application/json` or `multipart/form-data` (for file uploads)
- Response: `application/json; charset=utf-8` (except file/ZIP/video downloads)

**Local paths:** A `source` that names a local file works only inside the allowed folders. By default that is the output folder alone, and any other path gets `403 LOCAL_PATH_FORBIDDEN`. The `curl` examples with a local path assume `ALLOWED_INPUT_DIRS` covers it. See [Local File Paths](#local-file-paths).

**Uploads:** `/metadata`, `/extract`, `/extract-and-compose`, `/shots` and `/audio` also take `multipart/form-data`. Send the video as a file part, and options as fields before or after it. A job takes one video, so any further files are ignored. Uploads over `MAX_UPLOAD_SIZE` get `413`. `/compose` and `/video/download` take JSON only.

Form fields arrive as text, so:

- Numbers and booleans are parsed. Booleans are `true`, `false`, `1` or `0`.
- An empty field counts as not set. In JSON, so do `null` and `""`.
- `frame_positions` can be `first,last`, a repeated field (`frame_positions` or `frame_positions[]`), or `none` for an empty list.

---

## Sync vs Async

By default, processing endpoints block until completion and return `200`. If the caller hangs up, the job stops and is marked failed with `JOB_CANCELLED`. Set `"async": true` in the request body to return immediately with `202`. An async job keeps running without the caller.

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
--> 200 { "job_id": "cap_...", "status": "processing", "progress": { "stage": "extracting", "percent": 7 }, ... }

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

**Endpoints supporting async:** `/extract`, `/compose`, `/extract-and-compose`, `/shots`, `/audio`, `/video/download`

`JOB_TIMEOUT` applies to sync and async jobs alike. See [Film-Length Work](#film-length-work).

---

## Job Lifecycle

```
pending  -->  processing  -->  completed
                           -->  failed
```

- **pending** -- Queued, waiting for a processing slot
- **processing** -- Currently executing (FFmpeg, Sharp, or yt-dlp running)
- **completed** -- Finished successfully; results available
- **failed** -- Error occurred; check the `error` and `error_code` fields

A cancelled or timed-out job ends as `failed`, with `error_code` `JOB_CANCELLED` or `JOB_TIMEOUT`. A job that fails the duration limit also stays on record as `failed`.

Composing a finished job puts it back through `pending` and `processing`. If that compose fails, the job returns to `completed` with its earlier output intact, and `GET /api/v1/jobs/:id` adds a `last_error` field until a later compose succeeds.

**Storage:** Jobs are persisted as `job.json` files in `{LOCAL_OUTPUT_DIR}/{job_id}/`.

**Recovery:** On server restart, jobs stuck in `pending` or `processing` are marked as `failed` with the message "Server restarted during processing". A compose cut short on a finished job returns that job to `completed` instead.

**Cleanup:** Completed and failed jobs are automatically deleted after `LOCAL_TTL_SECONDS` (default: 86400 seconds / 24 hours). After that, the job ID returns `404 JOB_NOT_FOUND`.

**Job ID format:** `cap_` followed by 8 lowercase hex characters (e.g., `cap_a1b2c3d4`).

---

## Time Ranges

`/extract`, `/extract-and-compose`, `/shots` and `/audio` take `start` and `end`, as do the matching MCP tools.

- A time is a number of seconds (`90.5`) or a string: `"90.5"`, `"01:30.5"` (MM:SS) or `"1:02:03.25"` (HH:MM:SS).
- Either can be left out. `start` defaults to the beginning and `end` to the end of the video.
- An `end` past the end of the video is cut to fit. A `start` past the end, or an `end` at or before `start`, returns `400`.
- A frame exactly at `end` is not included.
- `MAX_VIDEO_DURATION` applies to the span processed, not the length of the file.

Frame and shot times stay on the source's timeline, so a frame 10 seconds into a range that starts at `60` reports `70`. Responses give the resolved span in seconds as `range`, or `null` without one. For audio, see `timeline_offset` under [POST /api/v1/audio](#post-apiv1audio).

---

## Frame Times and the Manifest

Frame timestamps are real source frame times, read from FFmpeg as it decodes. They are not index divided by fps, so variable frame rate video and gaps in a source come out right. A 15 fps video sampled at `"fps": 2` gives `0, 0.533333, 1, 1.533333`.

Sampling takes the first frame of each interval. A rate at or above the source's returns every source frame once.

Each job that makes frames or sheets writes a `manifest.json` next to its output. Fetch it from the job's `manifest_url` or find it in the job's ZIP. MCP clients page through it with [capture_job_manifest](#capture_job_manifest). Audio jobs and video downloads have none.

```bash
curl http://localhost:3000/api/v1/files/cap_547a1ace/manifest.json
```

This one comes from a shots job composed at mode 4, cut to one shot:

```json
{
  "version": 1,
  "preset": "llm",
  "fps": null,
  "range": null,
  "frames": [
    { "index": 0, "file": "frame_0001.jpg", "pts_time": 0, "shot": 1, "position": "first" },
    { "index": 1, "file": "frame_0002.jpg", "pts_time": 2, "shot": 1, "position": "middle" },
    { "index": 2, "file": "frame_0003.jpg", "pts_time": 3.96, "shot": 1, "position": "last" }
  ],
  "shots": [
    { "index": 1, "start": 0, "end": 4, "duration": 4, "frames": [0, 1, 2] }
  ],
  "sheets": [
    { "file": "sheet_001.jpg", "frames": [0, 1, 2] }
  ]
}
```

| Field | Description |
|-------|-------------|
| `fps` | The sampling rate. `null` for a shots job |
| `range` | The resolved `start` and `end`, or `null` |
| `frames[].pts_time` | The frame's real time in seconds |
| `frames[].shot`, `frames[].position` | Shots jobs only. The shot's `index`, and `first`, `middle` or `last` |
| `shots[].frames`, `sheets[].frames` | Indexes into `frames` |

`shots` and `sheets` appear only on jobs that have them. A compose of frames by path has an empty `frames` list, and its `sheets` indexes count from the paths you sent.

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
  "version": "0.2.0",
  "uptime": 1234.567,
  "environment": "production"
}
```

---

### POST /api/v1/metadata

Get video metadata without extracting frames. A URL is downloaded with yt-dlp first, so it takes a queue slot and can take a while.

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

**Local file path:**

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
  "duration": 19.021,
  "width": 320,
  "height": 240,
  "fps": 15,
  "codec": "av1",
  "size_bytes": 475958,
  "format": "mov",
  "audio_streams": [
    {
      "index": 0,
      "codec": "opus",
      "channels": 2,
      "sample_rate": 48000,
      "language": "eng",
      "title": null
    }
  ]
}
```

`format` is FFmpeg's name for the container: `mov` for MP4 and MOV, `matroska` for MKV and WebM. An `audio_streams` entry's `index` is the value to pass as `stream` to [POST /api/v1/audio](#post-apiv1audio).

---

### POST /api/v1/extract

Extract frames from a video at a rate you choose, optionally from a time range.

**Request body (JSON):**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `source` | string | Yes | -- | Video file path or URL |
| `fps` | number | No* | -- | Frames per second to sample, 0.001-30. Fractions are allowed |
| `every_seconds` | number | No* | -- | Sample one frame every N seconds, 0.04-3600 |
| `start` | number or string | No | -- | Start of the range. See [Time Ranges](#time-ranges) |
| `end` | number or string | No | -- | End of the range |
| `preset` | enum | No | `"llm"` | `llm`, `high`, or `custom` |
| `width` | int | No | original | Custom width in pixels (preset=custom) |
| `format` | enum | No | `jpeg` | `jpeg` or `png` (preset=custom) |
| `quality` | int | No | `80` | JPEG quality 1-100 (preset=custom) |
| `async` | bool | No | `false` | Enable async mode |
| `webhook_url` | string | No | -- | `http` or `https` URL for async notification |

\* Provide exactly one of `fps` or `every_seconds`.

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

**Time range, one frame every 30 seconds:**

```bash
curl -X POST http://localhost:3000/api/v1/extract \
  -H "Content-Type: application/json" \
  -d '{
    "source": "/path/to/video.mp4",
    "every_seconds": 30,
    "start": "01:00",
    "end": "03:00"
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
    ],
    "timestamps": [0, 0.533333]
  },
  "source_metadata": {
    "duration": 19.021,
    "width": 320,
    "height": 240,
    "fps": 15
  },
  "range": null,
  "manifest_url": "/api/v1/files/cap_a1b2c3d4/manifest.json",
  "processing_time_ms": 291
}
```

`timestamps` runs parallel to `files` and `urls`. The example shows two of 38 entries.

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

Compose a job's frames, or a list of image files, into grid sheets.

**Request body (JSON):**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `job_id` | string | No* | -- | Job ID from a previous extraction |
| `frames` | string[] | No* | -- | Array of absolute frame file paths |
| `timestamps` | number[] | No | -- | Real time in seconds of each entry in `frames`, for overlays |
| `mode` | int | Yes | -- | Grid mode: `1`, `4`, or `16` |
| `overlay_frame_number` | bool | No | `false` | Overlay frame numbers |
| `overlay_timestamp` | bool | No | `false` | Overlay real timestamps |
| `fps` | number | No | -- | FPS for timestamp labels ** |
| `max_sheet_edge` | int | No | see *** | Longest grid sheet edge in pixels; frames shrink to fit. `0` means no limit |
| `async` | bool | No | `false` | Enable async mode |
| `webhook_url` | string | No | -- | Webhook URL |

\* Exactly one of `job_id` or `frames` is required. Providing both returns 400.

\** Needed only with `frames` and no `timestamps`, when `overlay_timestamp` is `true`. With `job_id`, labels use the true times in the job's manifest.

\*** `MAX_SHEET_EDGE` (default: 2000) for frames from the `llm` preset, no limit otherwise. Mode 1 refuses this option with `400`.

With `job_id`, composing replaces the job's sheets and keeps its frames. A shots job labels each cell with its shot number when an overlay is on. A running job returns `409 JOB_BUSY`. If a sheet is open in another program, compose returns `409 FILES_IN_USE`, and the earlier sheets stay in place.

With `frames`, composing makes a new job. Each path must be readable under [Local File Paths](#local-file-paths) and be a JPEG, PNG or WebP image. A request body can be up to 32 MiB, which holds a film's frame list.

Sheets are named `sheet_001.jpg` and so on. They are PNG when the first frame is PNG, and JPEG otherwise.

**Using job_id:**

```bash
curl -X POST http://localhost:3000/api/v1/compose \
  -H "Content-Type: application/json" \
  -d '{
    "job_id": "cap_a1b2c3d4",
    "mode": 4,
    "overlay_frame_number": true,
    "overlay_timestamp": true
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
      "/app/data/jobs/cap_a1b2c3d4/sheets/sheet_001.jpg"
    ],
    "urls": [
      "/api/v1/files/cap_a1b2c3d4/sheets/sheet_001.jpg"
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
| `overlay_timestamp` | bool | No | `false` | Overlay real timestamps |
| `max_sheet_edge` | int | No | see [POST /compose](#post-apiv1compose) | Longest grid sheet edge in pixels |

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
  "job_id": "cap_e5f6a7b8",
  "status": "completed",
  "frames": {
    "count": 38,
    "files": ["..."],
    "urls": ["..."],
    "timestamps": ["..."]
  },
  "sheets": {
    "count": 3,
    "mode": 16,
    "grid": "4x4",
    "files": ["..."],
    "urls": ["..."]
  },
  "source_metadata": {
    "duration": 19.021,
    "width": 320,
    "height": 240,
    "fps": 15
  },
  "range": null,
  "manifest_url": "/api/v1/files/cap_e5f6a7b8/manifest.json",
  "processing_time_ms": 5678
}
```

---

### POST /api/v1/shots

Detect scene cuts, and capture first, middle or last frames from each shot. It decodes the whole range, so use `async` for long videos.

**Request body (JSON):**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `source` | string | Yes | -- | Video file path or URL |
| `start` | number or string | No | -- | Start of the range. See [Time Ranges](#time-ranges) |
| `end` | number or string | No | -- | End of the range |
| `scene_threshold` | number | No | `0.3` | Scene change score that counts as a cut, 0.01-1. Lower finds more cuts |
| `min_shot_seconds` | number | No | `0.25` | Shortest shot to keep, 0-60. Closer cuts are ignored |
| `frame_positions` | string[] | No | `["middle"]` | Any of `first`, `middle`, `last`. `[]` or `"none"` for the shot list only |
| `preset` | enum | No | `"llm"` | `llm`, `high`, or `custom` |
| `width` | int | No | original | Custom width in pixels (preset=custom) |
| `format` | enum | No | `jpeg` | `jpeg` or `png` (preset=custom) |
| `quality` | int | No | `80` | JPEG quality 1-100 (preset=custom) |
| `async` | bool | No | `false` | Enable async mode |
| `webhook_url` | string | No | -- | Webhook URL |

```bash
curl -X POST http://localhost:3000/api/v1/shots \
  -H "Content-Type: application/json" \
  -d '{
    "source": "/path/to/video.mp4",
    "frame_positions": ["first", "last"]
  }'
```

**Multipart (file upload):**

```bash
curl -X POST http://localhost:3000/api/v1/shots \
  -F "file=@video.mp4" \
  -F "frame_positions=first,last"
```

**Response (200):**

```json
{
  "job_id": "cap_68d1caff",
  "status": "completed",
  "shots": {
    "count": 3,
    "items": [
      { "index": 1, "start": 0, "end": 4, "duration": 4, "frames": [0, 1] },
      { "index": 2, "start": 4, "end": 8, "duration": 4, "frames": [2, 3] },
      { "index": 3, "start": 8, "end": 12, "duration": 4, "frames": [4, 5] }
    ]
  },
  "frames": {
    "count": 6,
    "files": ["..."],
    "urls": ["..."],
    "timestamps": [0, 3.96, 4, 7.96, 8, 11.96]
  },
  "source_metadata": {
    "duration": 12,
    "width": 640,
    "height": 360,
    "fps": 25
  },
  "range": null,
  "manifest_url": "/api/v1/files/cap_68d1caff/manifest.json",
  "processing_time_ms": 322
}
```

Shots run back to back and cover the range, numbered from 1. A shot's `frames` are indexes into `frames.files`. Positions that fall on the same frame collapse into one, so a very short shot can have fewer frames than you asked for.

Hard cuts are found well. Lower `scene_threshold` if dissolves are missed. To make sheets, send this `job_id` to [POST /compose](#post-apiv1compose).

---

### POST /api/v1/audio

Export one audio track of a video, for separate speech or music models.

**Request body (JSON):**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `source` | string | Yes | -- | Video file path or URL |
| `start` | number or string | No | -- | Start of the range. See [Time Ranges](#time-ranges) |
| `end` | number or string | No | -- | End of the range |
| `format` | enum | No | `"wav"` | `wav`, `flac`, `mp3` or `m4a` |
| `stream` | int | No | `0` | Which audio stream, from `0`. See `audio_streams` in metadata |
| `sample_rate` | int | No | source rate | Sample rate in Hz, 8000-192000 |
| `channels` | int | No | as in source | `1` for mono, `2` for stereo |
| `async` | bool | No | `false` | Enable async mode |
| `webhook_url` | string | No | -- | Webhook URL |

`mp3` and `m4a` accept only the sample rates below. Any other rate returns `400`, and the message lists them. `wav` and `flac` take any rate in the range.

| Format | Sample rates (Hz) |
|--------|-------------------|
| `mp3` | 8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000 |
| `m4a` | 8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000 |

```bash
curl -X POST http://localhost:3000/api/v1/audio \
  -H "Content-Type: application/json" \
  -d '{
    "source": "/path/to/video.mp4",
    "format": "mp3",
    "stream": 1,
    "sample_rate": 16000,
    "channels": 1,
    "start": "00:03",
    "end": "00:06"
  }'
```

**Response (200):**

```json
{
  "job_id": "cap_bd757ec9",
  "status": "completed",
  "audio": {
    "file": "/app/data/jobs/cap_bd757ec9/audio/audio.mp3",
    "url": "/api/v1/files/cap_bd757ec9/audio/audio.mp3",
    "format": "mp3",
    "stream": 1,
    "sample_rate": 16000,
    "channels": 1,
    "duration": 3.096,
    "size_bytes": 9615
  },
  "timeline_offset": 3,
  "source_metadata": {
    "duration": 12,
    "width": 640,
    "height": 360,
    "fps": 25
  },
  "range": { "start": 3, "end": 6 },
  "processing_time_ms": 94
}
```

Add `timeline_offset` to a time in the audio to get a time in the video. `sample_rate`, `channels` and `duration` report what was written, which can differ a little from what you asked for. A video with no audio, or a `stream` it does not have, returns `400`.

---

### GET /api/v1/jobs/:id

Poll job status. Returns `200` with a different shape for each state.

```bash
curl http://localhost:3000/api/v1/jobs/cap_a1b2c3d4
```

**Response (pending/processing):**

```json
{
  "job_id": "cap_a1b2c3d4",
  "status": "processing",
  "progress": { "stage": "extracting", "percent": 7 },
  "started_at": "2026-03-21T10:00:00.100Z"
}
```

**Response (completed):**

Returns the full result of the job's work, the same shape as the original operation's `200` response. After a compose, that includes the frames and any shots as well as the sheets.

If a compose on the job failed, the job stays `completed` and the response adds:

```json
{
  "last_error": {
    "code": "FILES_IN_USE",
    "message": "Job 'cap_a1b2c3d4' has files open in another program. Close them and try again"
  }
}
```

**Response (failed):**

```json
{
  "job_id": "cap_a1b2c3d4",
  "status": "failed",
  "error": "Video duration exceeds maximum of 600 seconds",
  "error_code": "VIDEO_TOO_LONG",
  "failed_at": "2026-11-01T17:31:58.197Z"
}
```

---

### DELETE /api/v1/jobs/:id

Stop a job if it is running, then delete it and all its files (frames, sheets, audio, video, manifest, job.json).

```bash
curl -X DELETE http://localhost:3000/api/v1/jobs/cap_a1b2c3d4
```

**Response:** `204 No Content`

Returns `404` if the job does not exist, and `409 FILES_IN_USE` if a file is open in another program. Close it and try again. A sync caller waiting on the job gets `409 JOB_CANCELLED`.

---

### GET /api/v1/files/:jobId/\*

Serve one file from a completed job: a frame, a sheet, the audio track or the manifest.

```bash
# Download a frame
curl -o frame.jpg http://localhost:3000/api/v1/files/cap_a1b2c3d4/frames/frame_0001.jpg

# Download a sheet
curl -o sheet.jpg http://localhost:3000/api/v1/files/cap_a1b2c3d4/sheets/sheet_001.jpg

# Download the audio track
curl -o audio.wav http://localhost:3000/api/v1/files/cap_a1b2c3d4/audio/audio.wav

# Download the manifest
curl -o manifest.json http://localhost:3000/api/v1/files/cap_a1b2c3d4/manifest.json
```

**Response:** Binary file content with the matching MIME type (`image/jpeg`, `image/png`, `application/json`, `audio/wav`, `audio/flac`, `audio/mpeg`, `audio/mp4`).

**Headers:**
- Frames: `Cache-Control: public, max-age=3600`
- Sheets and the manifest: `Cache-Control: no-cache`, because a new compose rewrites them

Only job output can be served: `frames/`, `sheets/`, `audio/` and `manifest.json`. Anything else returns `404 FILE_NOT_FOUND`. A job that is not `completed` returns `400`.

---

### GET /api/v1/jobs/:id/download

Download job output as a ZIP archive, with `manifest.json` when the job has one.

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

`all` also includes an audio job's track. A job with nothing to zip, such as a video download, returns `400`. Use [GET /jobs/:id/video](#get-apiv1jobsidvideo) for those.

Returns `400` if the job is not in `completed` status.

---

### POST /api/v1/hls/discover

Scan a web page for HLS (`.m3u8`) stream URLs. The server fetches the page HTML and searches it for playlist links.

**Request body (JSON):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | Yes | Web page URL |
| `headers` | object | No | HTTP headers (e.g., Referer, Cookie) |

```bash
curl -X POST http://localhost:3000/api/v1/hls/discover \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/watch"}'
```

**Response (200):**

```json
{
  "page_url": "https://example.com/watch",
  "page_title": "Player",
  "streams": [
    {
      "url": "https://example.com/master.m3u8",
      "source": "html_attribute"
    }
  ]
}
```

`source` is `html_attribute` or `script_tag`. A page that cannot be fetched returns `400 HLS_PARSE_ERROR`.

---

### POST /api/v1/video/formats

List available download formats for a video URL.

**Request body (JSON):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | Yes | Video URL, including HLS `.m3u8` |
| `headers` | object | No | HTTP headers (e.g., Referer, Cookie) for protected streams |

```bash
curl -X POST http://localhost:3000/api/v1/video/formats \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=jNQXAC9IVRw"}'
```

**Response (200):**

```json
{
  "title": "Me at the zoo",
  "duration": 19,
  "formats": [
    {
      "format_id": "140",
      "ext": "m4a",
      "width": null,
      "height": null,
      "fps": null,
      "vcodec": "none",
      "acodec": "mp4a.40.2",
      "filesize": 309288,
      "filesize_approx": 309287,
      "format_note": "medium",
      "resolution": "audio only"
    },
    {
      "format_id": "134",
      "ext": "mp4",
      "width": 320,
      "height": 240,
      "fps": 15,
      "vcodec": "avc1.4D400C",
      "acodec": "none",
      "filesize": 322379,
      "filesize_approx": 322376,
      "format_note": "240p",
      "resolution": "320x240"
    }
  ]
}
```

Storyboard/thumbnail formats (where both `vcodec` and `acodec` are `"none"`) are automatically filtered out.

For an `.m3u8` URL, the title is `HLS Stream`, the duration is `0`, each variant has a `format_id` like `hls_0`, and `filesize_approx` is the variant's bandwidth in bytes per second. A direct link to a file can return an empty `formats` list.

---

### POST /api/v1/video/download

Download a video from a URL in a specified format.

**Request body (JSON):**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `url` | string | Yes | -- | Video URL |
| `preset` | enum | No | -- | Quality preset (see table) |
| `format_selector` | string | No | -- | Raw yt-dlp format selector or HLS variant `.m3u8` URL (advanced) |
| `merge_format` | enum | No | `"mp4"` | Output format: `mp4`, `webm`, `mkv`, `mp3` |
| `headers` | object | No | -- | HTTP headers (e.g., Referer, Cookie) for protected streams |
| `async` | bool | No | `false` | Enable async mode |
| `webhook_url` | string | No | -- | Webhook URL |

> You cannot provide both `preset` and `format_selector`. If neither is provided, defaults to "best". A preset needs a site that reports formats. For a direct link to a file, leave it out.

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
    "format_selector": "134+140",
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
  "job_id": "cap_a13608a4",
  "status": "completed",
  "video": {
    "filename": "Me at the zoo.mp4",
    "filesize": 475958,
    "ext": "mp4",
    "download_url": "/api/v1/jobs/cap_a13608a4/video",
    "file_path": "/app/data/jobs/cap_a13608a4/video/Me at the zoo.mp4"
  },
  "processing_time_ms": 2496
}
```

**Response (202 -- asynchronous):**

```json
{
  "job_id": "cap_a13608a4",
  "status": "pending",
  "poll_url": "/api/v1/jobs/cap_a13608a4"
}
```

An `.m3u8` URL, in `url` or `format_selector`, goes to FFmpeg, and the file is named `stream.mp4` (or the `merge_format` you chose).


---

### GET /api/v1/jobs/:id/video

Stream the downloaded video file.

```bash
curl -o video.mp4 http://localhost:3000/api/v1/jobs/cap_a13608a4/video
```

**Response:** Binary video/audio stream.

**Headers:**
- `Content-Type: video/mp4` (or `video/webm`, `video/x-matroska`, `audio/mpeg`, `audio/mp4`, `audio/ogg`)
- `Content-Length: 475958`
- `Content-Disposition: attachment; filename="Me%20at%20the%20zoo.mp4"`

The file is streamed directly (not buffered), so this works for large video files.

Returns `400` if the job is not in `completed` status. Returns `404` if no video file exists in the job directory.

---

## Webhook Integration

Add `"webhook_url"` to any async request. ilinxa capture sends a POST to the URL when the job completes or fails. Sync requests send no webhook.

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
    "frames": { "count": 38, "files": ["..."], "urls": ["..."], "timestamps": ["..."] },
    "source_metadata": { "duration": 19.021, "width": 320, "height": 240, "fps": 15 },
    "range": null,
    "manifest_url": "/api/v1/files/cap_a1b2c3d4/manifest.json",
    "processing_time_ms": 291
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

An async compose that fails on a finished job sends `job.failed` with `"status": "completed"`, because the job keeps its earlier output.


---

## Error Handling (API)

All errors return a consistent JSON structure:

```json
{
  "error": {
    "code": "LOCAL_PATH_FORBIDDEN",
    "message": "Local path is outside the allowed folders. Upload the file, or set ALLOWED_INPUT_DIRS"
  }
}
```

**Error codes:**

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `VALIDATION_ERROR` | 400 | Invalid request parameters. The message names the field |
| `UNSUPPORTED_FORMAT` | 400 | Unreadable or refused input. The message gives the reason |
| `HLS_PARSE_ERROR` | 400 | An HLS playlist or page could not be fetched or read, or an HLS download failed |
| `FORBIDDEN_HOST` | 403 | `Host` is not allowed. See [Network Access](#network-access) |
| `FORBIDDEN_ORIGIN` | 403 | `Origin` is not allowed |
| `LOCAL_PATH_FORBIDDEN` | 403 | Local path is outside the allowed folders. See [Local File Paths](#local-file-paths) |
| `JOB_NOT_FOUND` | 404 | Job ID does not exist, or the job is past its TTL |
| `FILE_NOT_FOUND` | 404 | Requested file not found in job directory |
| `NOT_FOUND` | 404 | Route not found (catch-all) |
| `JOB_BUSY` | 409 | The job is still running |
| `JOB_CANCELLED` | 409 | A sync job stopped because its caller hung up or the job was deleted |
| `FILES_IN_USE` | 409 | A file is open in another program, on compose or delete. Close it and try again |
| `VIDEO_TOO_LONG` | 413 | Span to process exceeds `MAX_VIDEO_DURATION` |
| `DOWNLOAD_FAILED` | 500 | yt-dlp video download failed |
| `FORMAT_LISTING_FAILED` | 500 | yt-dlp format listing failed |
| `PROCESSING_ERROR` | 500 | FFmpeg or Sharp processing error |
| `JOB_TIMEOUT` | 504 | Job ran past `JOB_TIMEOUT` and was stopped |

Errors raised by the web framework keep its own codes, which start with `FST_`. Examples are `FST_REQ_FILE_TOO_LARGE` (413) for an upload over `MAX_UPLOAD_SIZE`, `FST_ERR_CTP_INVALID_JSON_BODY` (400) for malformed JSON, and `FST_ERR_VALIDATION` (400) for a bad job ID in the URL or a bad query value.

> In production mode, the default, 500 errors return a generic message ("An unexpected error occurred") instead of internal error details. The `code` stays. For a job, `GET /api/v1/jobs/:id` shows the reason in `error`.

**Invalid request bodies** name the field in the message:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "fps: Too big: expected number to be <=30"
  }
}
```

**Bad job IDs and query values** add `details`:

```json
{
  "error": {
    "code": "FST_ERR_VALIDATION",
    "message": "params/id Invalid job ID",
    "details": {
      "validation": [
        {
          "keyword": "invalid_format",
          "instancePath": "/id",
          "schemaPath": "#/id/invalid_format",
          "message": "Invalid job ID",
          "params": {
            "origin": "string",
            "format": "regex",
            "pattern": "/^cap_[0-9a-f]{8}$/"
          }
        }
      ]
    }
  }
}
```

**Unreadable input** gives the reason, then the containers the server reads:

```json
{
  "error": {
    "code": "UNSUPPORTED_FORMAT",
    "message": "Not a readable video: Invalid argument. Containers read: MP4, MOV, MKV, WebM, AVI, MPEG-TS, MPEG-PS, FLV, WMV, Ogg, MXF, DV, and raw H.264, HEVC or MPEG video"
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
# Returns: { "job_id": "cap_1a2b3c4d", "frames": { "count": 38, "urls": [...], "timestamps": [...] }, ... }

# Step 2: Access individual frames
curl -o frame1.jpg http://localhost:3000/api/v1/files/cap_1a2b3c4d/frames/frame_0001.jpg
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
# Returns: { "job_id": "cap_2b3c4d5e", "sheets": { "count": 38, ... }, ... }

# Step 2: Download all sheets as ZIP
curl -o sheets.zip "http://localhost:3000/api/v1/jobs/cap_2b3c4d5e/download?include=sheets"
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
# Returns: { "job_id": "cap_3c4d5e6f", "status": "pending", "poll_url": "/api/v1/jobs/cap_3c4d5e6f" }

# Step 2: (Optional) Poll for status
curl http://localhost:3000/api/v1/jobs/cap_3c4d5e6f
# Returns: { "status": "processing", "progress": {...}, ... } or { "status": "completed", ... }

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
# Returns: { "job_id": "cap_4d5e6f7a", "video": { "download_url": "/api/v1/jobs/cap_4d5e6f7a/video", ... } }

# Step 3: Download the video file
curl -o video.mp4 http://localhost:3000/api/v1/jobs/cap_4d5e6f7a/video
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
# Returns: { "job_id": "cap_5e6f7a8b", "video": { "filename": "Me at the zoo.mp3", "ext": "mp3", ... } }

curl -o audio.mp3 http://localhost:3000/api/v1/jobs/cap_5e6f7a8b/video
```

### Example 6: Shots to Contact Sheets

```bash
# Step 1: Find the shots, with three frames from each
curl -X POST http://localhost:3000/api/v1/shots \
  -H "Content-Type: application/json" \
  -d '{
    "source": "/path/to/scene.mp4",
    "frame_positions": ["first", "middle", "last"]
  }'
# Returns: { "job_id": "cap_6f7a8b9c", "shots": { "count": 3, "items": [...] }, "frames": {...}, ... }

# Step 2: Compose them, with shot numbers and real times on each cell
curl -X POST http://localhost:3000/api/v1/compose \
  -H "Content-Type: application/json" \
  -d '{
    "job_id": "cap_6f7a8b9c",
    "mode": 4,
    "overlay_timestamp": true
  }'
# Returns: { "job_id": "cap_6f7a8b9c", "status": "completed", "sheets": { "count": 3, ... }, ... }

# Step 3: Download the sheets, with the manifest
curl -o sheets.zip "http://localhost:3000/api/v1/jobs/cap_6f7a8b9c/download?include=sheets"
```

### Example 7: Speech Track for a Transcription Model

```bash
curl -X POST http://localhost:3000/api/v1/audio \
  -F "file=@video.mp4" \
  -F "format=wav" \
  -F "sample_rate=16000" \
  -F "channels=1"
# Returns: { "job_id": "cap_7a8b9c0d", "audio": { "url": "/api/v1/files/cap_7a8b9c0d/audio/audio.wav", ... }, ... }

curl -o speech.wav http://localhost:3000/api/v1/files/cap_7a8b9c0d/audio/audio.wav
```

---

# Film-Length Work

The defaults suit short clips: a job may cover 600 seconds of video and run for 300 seconds. For a whole film, change those limits and run the job in the background.

```bash
docker run -p 127.0.0.1:3000:3000 \
  -v /media/films:/films:ro \
  -e ALLOWED_INPUT_DIRS=/films \
  -e MAX_VIDEO_DURATION=0 \
  -e JOB_TIMEOUT=0 \
  ilinxa-capture
```

Outside Docker, set the same variables before `npm start`.

Then pass `async: true` and poll, or wait for a webhook. Use `start` and `end` to work on one scene:

```bash
curl -X POST http://localhost:3000/api/v1/shots \
  -H "Content-Type: application/json" \
  -d '{
    "source": "/films/feature.mov",
    "start": "00:42:10",
    "end": "00:47:30",
    "async": true
  }'
```

- `MAX_VIDEO_DURATION` applies to the span being processed, so a scene from a long film passes even at the default. `JOB_TIMEOUT` still applies.
- A sync caller who hangs up stops the job. An async job keeps going.
- Read films by path, as uploads stop at `MAX_UPLOAD_SIZE`. A URL source downloads the whole file first, even with a range.
- `/shots` decodes the whole range. `/extract` at a low rate also reads all of it.
- Output stays for `LOCAL_TTL_SECONDS` (default: 24 hours) after a job ends. Make sure the output folder has room.
- MCP results stay small however many frames a job makes. See [Compact Results and Paging](#compact-results-and-paging).

---

# Known Limits

- **Audio lead on MPEG-TS and MPEG-PS.** With audio that starts before the video, frame times run early against audio by that lead, usually about 20 ms.
- **AVI with B-frames.** Frames are labeled one frame late, because AVI stores no timestamps for them.
- **Joined MPEG-TS with a timestamp reset.** When timestamps restart partway through, as in byte-joined captures, the file reports only its first segment's length. Extract still reads every frame, but shots, ranges and `MAX_VIDEO_DURATION` stop at the reported length, and later shots are missing with no error.
- **Few keyframes.** A source with very few keyframes costs a longer decode for each ranged read.
- **Containers outside the allowlist.** GIF, Y4M, NUT, RealMedia, MJPEG and OBU, among others, are refused. See [Supported Containers](#supported-containers).
- **First compose with overlays.** The first one on a machine can take several seconds while fonts load. After that it takes under a second.

<!-- /wl -->

