# ilinxa capture

**Video frame extraction & composition service for AI vision pipelines.**

[![CI](https://github.com/ilinxa/ilinxa-capture/actions/workflows/ci.yml/badge.svg)](https://github.com/ilinxa/ilinxa-capture/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)
![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP%20%2B%20stdio-purple)

ilinxa capture turns videos into **grid sheets** (contact sheets) that multimodal
LLMs can read efficiently: it extracts frames at a configurable FPS, then
composes them into 1×1, 2×2, or 4×4 grids with optional frame-number and
timestamp overlays. One core engine, three interfaces:

| Interface | For | Entry point |
|---|---|---|
| **REST API** | Scripts, services, pipelines | `/api/v1` |
| **Web UI** | Interactive use | `/` (3-step wizard) |
| **MCP server** | AI agents / MCP clients | stdio + Streamable HTTP |

---

## Table of contents

- [Features](#features)
- [Quick start](#quick-start)
- [Usage](#usage)
  - [REST API](#rest-api)
  - [Web UI](#web-ui)
  - [MCP server](#mcp-server)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Development](#development)
- [Testing](#testing)
- [Security model](#security-model)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Frame extraction** at 1–30 FPS via FFmpeg
- **Grid composition** into 1×1, 2×2, or 4×4 sheets via Sharp, with optional
  frame-number / timestamp overlays
- **Quality presets** tuned for vision models: `llm` (1024 px, JPEG 80 %),
  `high` (original resolution, PNG), or fully `custom`
- **Video download** from YouTube, Vimeo, and 1,000+ sites via yt-dlp, with
  per-resolution presets or raw format selectors
- **HLS support**: parse master playlists, discover `.m3u8` streams embedded
  in web pages, download variants (custom headers supported for protected
  streams)
- **Sync or async jobs** — async returns `202` + poll URL and supports
  webhook notifications on completion
- **Streaming ZIP downloads** of frames, sheets, or both — never buffered in
  memory
- **Self-maintaining storage**: TTL-based cleanup of finished jobs and
  orphaned temp files; job state recovers across restarts (no database)

## Quick start

### Docker (recommended)

```bash
docker build -t ilinxa-capture .
docker run -p 3000:3000 ilinxa-capture
```

Open <http://localhost:3000> — the Web UI, REST API, and MCP HTTP endpoint are
all served from the same port. FFmpeg and yt-dlp are included in the image.

### Local

Requirements: **Node 22+**, **FFmpeg** (with ffprobe) and **yt-dlp** on `PATH`.

```bash
npm ci
npm run build
npm start                  # serves API + built UI on :3000
```

For development with hot reload, see [Development](#development).

## Usage

### REST API

Extract frames and compose a 2×2 sheet in one call:

```bash
curl -X POST http://localhost:3000/api/v1/extract-and-compose \
  -H "Content-Type: application/json" \
  -d '{
    "source": "https://example.com/video.mp4",
    "fps": 2,
    "mode": 4,
    "preset": "llm",
    "overlay_timestamp": true
  }'
```

Or upload a file (multipart):

```bash
curl -X POST http://localhost:3000/api/v1/extract \
  -F "file=@video.mp4" -F "fps=2" -F "preset=llm"
```

Add `"async": true` (or `-F "async=true"`) to get an immediate `202` with a
poll URL instead of waiting for the result. Pass `"webhook_url"` to be called
back on completion.

#### Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/metadata` | Probe a video (file upload or `{source}` URL) |
| `POST` | `/api/v1/extract` | Extract frames |
| `POST` | `/api/v1/compose` | Compose frames into grid sheets |
| `POST` | `/api/v1/extract-and-compose` | Both steps in one call |
| `POST` | `/api/v1/video/formats` | List downloadable formats for a URL |
| `POST` | `/api/v1/video/download` | Download a video (preset or raw selector) |
| `POST` | `/api/v1/hls/discover` | Scan a web page for embedded HLS streams |
| `GET` | `/api/v1/jobs/:id` | Job status / result |
| `DELETE` | `/api/v1/jobs/:id` | Delete a job and its files |
| `GET` | `/api/v1/jobs/:id/download?include=frames\|sheets\|all` | Streaming ZIP |
| `GET` | `/api/v1/jobs/:id/video` | Download a downloaded video file |
| `GET` | `/api/v1/files/:jobId/*` | Serve an individual frame/sheet |
| `GET` | `/api/v1/health` | Health check |

Errors are consistent JSON:
`{ "error": { "code": "VALIDATION_ERROR", "message": "fps: expected number" } }`
with meaningful HTTP status codes (`400`, `404`, `410`, `413`, `500`).

Full endpoint documentation with request/response schemas:
[docs/GUIDE.md](docs/GUIDE.md).

### Web UI

A three-step wizard — **Extract → Preview & Compose → Output** — with file
upload or URL input, live metadata preview, an HLS stream scanner, frame
gallery, grid configuration, and ZIP downloads. Light and dark themes.

### MCP server

ilinxa capture exposes its tools to any
[Model Context Protocol](https://modelcontextprotocol.io/) client.

**Tools:** `capture_metadata`, `capture_extract`, `capture_compose`,
`capture_extract_and_compose`, `capture_video_formats`,
`capture_video_download`, `capture_hls_discover`, `capture_job_status`.

**Stdio** (local clients — e.g. Claude Desktop, Cursor, VS Code):

```json
{
  "mcpServers": {
    "ilinxa-capture": {
      "command": "node",
      "args": ["/absolute/path/to/ilinxa-capture/dist/mcp-entry.js"]
    }
  }
}
```

**Streamable HTTP** (remote agents): the running server exposes `/mcp`
(POST/GET/DELETE) with session management and idle-session expiry
(`MCP_SESSION_TTL`).

Setup walkthroughs for both transports: [docs/GUIDE.md](docs/GUIDE.md#mcp-server).

## Configuration

All configuration is via environment variables (validated at startup — the
server refuses to boot on invalid config). Copy [`.env.example`](.env.example)
to `.env` to get started.

| Variable | Type | Default | Description |
|---|---|---|---|
| `PORT` | int | `3000` | HTTP port |
| `HOST` | string | `0.0.0.0` | Bind address |
| `NODE_ENV` | enum | `development` | `development` / `production` / `test` |
| `LOG_LEVEL` | enum | `info` | Pino log level |
| `STORAGE_MODE` | enum | `local` | `local` or `s3` |
| `LOCAL_OUTPUT_DIR` | string | `./data/jobs` | Job output directory |
| `LOCAL_TTL_SECONDS` | int | `3600` | Finished-job retention before cleanup |
| `MAX_VIDEO_DURATION` | int | `600` | Max video length in seconds |
| `MAX_UPLOAD_SIZE` | int | `524288000` | Max upload size in bytes (500 MB) |
| `MAX_CONCURRENT_JOBS` | int | `3` | Processing concurrency limit |
| `JOB_TIMEOUT` | int | `300` | Per-job timeout in seconds |
| `MCP_SESSION_TTL` | int | `1800` | Idle MCP HTTP session lifetime in seconds |
| `UI_DIR` | string | `./ui/dist` | Built Web UI assets |
| `S3_*` | — | — | S3 credentials/bucket (required when `STORAGE_MODE=s3`) |

## Architecture

```
                    ┌───────────┐
                    │  Web UI   │
                    │ React 19  │
                    └─────┬─────┘
                          │
  ┌──────────┐     ┌──────┴──────┐     ┌────────────┐
  │   MCP    │     │  REST API   │     │  MCP HTTP  │
  │  stdio   ├────▶│  Fastify 5  │◀────┤    /mcp    │
  └──────────┘     └──────┬──────┘     └────────────┘
                          │
                   ┌──────┴──────┐
                   │ Core engine │   job queue · storage · cleanup
                   └──────┬──────┘
                          │
              ┌───────────┼───────────┐
         ┌────┴────┐ ┌────┴───┐ ┌─────┴────┐
         │ FFmpeg  │ │ Sharp  │ │  yt-dlp  │
         └─────────┘ └────────┘ └──────────┘
```

Design decisions worth knowing:

- **No database.** Job state lives in a `job.json` per job directory,
  schema-validated and reconstructed on startup. Stuck jobs are marked failed.
- **Thin adapters.** All business logic lives in `src/core/`; the REST and MCP
  layers only translate protocols.
- **App factory.** `buildApp()` creates the configured Fastify instance;
  `index.ts` just starts it — which is what makes the whole API testable.
- **External binaries via `execFile`** with argument arrays — no shell
  interpolation anywhere.
- **Bounded resources.** Concurrency-limited job queue, TTL cleanup for job
  dirs *and* orphaned temp files, idle-session expiry on the MCP HTTP
  transport.

```
src/
├── app.ts            # Fastify app factory
├── index.ts          # Server entry (graceful shutdown)
├── mcp-entry.ts      # MCP stdio entry
├── core/             # Engine: extractor, composer, metadata, downloader,
│                     #   hls, job-manager, storage, cleanup, presets
├── api/              # REST routes, handlers, schemas (+ api/lib helpers)
├── mcp/              # MCP server + tool registration
├── lib/env.ts        # Zod-validated environment
└── utils/            # Errors, logger, exec

ui/src/
├── app/              # Shell, providers, router
├── features/         # extraction / preview / output (components + api + types)
├── components/       # ui (shadcn) · common · layout
├── stores/           # Zustand (client state)
├── hooks/ lib/ types/ styles/
```

## Development

```bash
# Backend (repo root)
npm ci
npm run dev            # tsx watch on :3000

# Web UI (separate terminal)
cd ui && npm ci
npm run dev            # Vite on :5173, proxies /api to :3000
```

| Command | Where | Description |
|---|---|---|
| `npm run dev` | root / `ui/` | Dev server with hot reload |
| `npm run build` | root / `ui/` | Production build (tsup / Vite) |
| `npm run typecheck` | root / `ui/` | `tsc --noEmit` |
| `npm test` | root / `ui/` | Unit tests (Vitest) |
| `npm run test:integration` | root | End-to-end pipeline tests (real FFmpeg) |
| `npm run test:coverage` | root | Coverage report |
| `npm run lint` / `format` | `ui/` | ESLint / Prettier |
| `npm run mcp:stdio` | root | MCP server on stdio |

Conventions: strict TypeScript everywhere (`noUncheckedIndexedAccess`), ESM
only, Zod validation at every boundary, Pino logging (stdout is reserved for
JSON-RPC on the MCP stdio transport). UI: named exports, Zustand for client
state, TanStack Query for server state — never mixed.

## Testing

Three tiers, all run in CI:

| Tier | Count | What it proves |
|---|---|---|
| Backend unit | 240 tests / 21 files | All logic, with FFmpeg/yt-dlp/Sharp/fs mocked — fast and hermetic |
| Backend integration | 9 tests | The **real pipeline**: generates a video with FFmpeg, drives the live HTTP API with zero mocks — upload → extract → compose → ZIP → delete, asserting real frame counts and real sheet pixel dimensions, plus corrupt-input and path-traversal negative cases |
| UI | 19 tests / 4 files | Store, API client, polling hook, wizard navigation guards (Vitest + Testing Library) |

```bash
npm test -- --run                 # unit
npm run test:integration -- --run # integration (needs FFmpeg on PATH)
cd ui && npm test -- --run        # UI
```

## Security model

ilinxa capture is designed for **localhost / trusted-network use** and ships
with no authentication. By design it will fetch **any URL it is given**
(yt-dlp, HLS discovery, direct HTTP), and the compose endpoint accepts
explicit local frame paths — so it must never be exposed directly to the
public internet or untrusted callers. File *serving* is confined to each
job's own directory with path-traversal protection. For anything
internet-facing, put it behind a gateway that provides authentication, rate
limiting, and URL allow-listing.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the
development workflow, test requirements, and PR guidelines.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
