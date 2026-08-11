# Changelog

All notable changes to this project are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- wl:changelog.unreleased -->
## [Unreleased]
<!-- /wl -->

<!-- wl:changelog.0-1-0 -->
## [0.1.0] — 2026-08-11

Initial public release.

### Added

- Frame extraction from local files and URLs at 1–30 FPS via FFmpeg.
- Grid composition into 1×1, 2×2, and 4×4 contact sheets via Sharp, with
  optional frame-number and timestamp overlays.
- Quality presets tuned for vision models: `llm` (1024 px, JPEG), `high`
  (original resolution, PNG), and `custom`.
- Video download from 1,000+ sites via yt-dlp, with per-resolution presets and
  raw format selectors.
- HLS support: master-playlist parsing, in-page `.m3u8` discovery, and variant
  download with custom headers.
- Synchronous and asynchronous jobs; async returns a poll URL and supports
  webhook notification on completion.
- Streaming ZIP downloads of frames, sheets, or both.
- TTL-based cleanup of finished jobs and orphaned temp files; job state recovers
  across restarts with no database.
- Three interfaces over one core engine: REST API (Fastify 5), Web UI
  (React 19), and an MCP server (stdio + Streamable HTTP) exposing eight tools.
<!-- /wl -->

[Unreleased]: https://github.com/ilinxa/ilinxa-capture/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ilinxa/ilinxa-capture/releases/tag/v0.1.0
