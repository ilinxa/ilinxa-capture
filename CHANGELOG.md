# Changelog

All notable changes to this project are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- wl:changelog.unreleased -->
## [Unreleased]
<!-- /wl -->

<!-- wl:changelog.0-1-1 -->
## [0.1.1] — 2026-08-11

### Security

- Fixed a path traversal in the file route on Linux and macOS. A request like
  `GET /api/v1/files/:jobId/..\..\..\etc\passwd` escaped the job directory:
  POSIX `path` does not treat `\` as a separator, so the payload stayed one
  literal filename inside the job directory, satisfied the containment check,
  and was then read from disk and returned. Backslashes are now normalized
  before the path is resolved. Windows hosts were never affected, since `path`
  there already splits on `\`.

  Reaching it needs the ID of a completed job, so anyone who can create a job
  could read any file the server process could read. Instances left on
  localhost, as the README recommends, were reachable only from the host.
  Upgrade if you published the port or put the service behind a proxy.
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

[Unreleased]: https://github.com/ilinxa/ilinxa-capture/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/ilinxa/ilinxa-capture/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ilinxa/ilinxa-capture/releases/tag/v0.1.0
