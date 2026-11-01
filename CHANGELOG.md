# Changelog

All notable changes to this project are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- wl:changelog.unreleased -->
## [Unreleased]
<!-- /wl -->

<!-- wl:changelog.0-2-0 -->
## [0.2.0] — 2026-11-02

This release makes the tool safe by default on a local machine, and ready for
film-length work. Several defaults change, so read **Changed** before upgrading.

### Added

- `POST /api/v1/shots` and `capture_shots`: shots by scene cut, with first,
  middle and last frames per shot.
- `POST /api/v1/audio` and `capture_audio`: extract an audio stream, with sample
  rate, channels and range, on the same timeline as the frames.
- `start` and `end` on extract, shots and audio, in seconds or timecode.
- `every_seconds`, and fractional `fps`.
- `manifest.json` in each job, with every frame's real time, its shot, and which
  sheet holds it.
- `max_sheet_edge` and `MAX_SHEET_EDGE`. `llm` grid sheets fit a 2,000 px long edge.
- MCP: `async`, progress, cancellation, and `capture_job_manifest` and
  `capture_job_delete`. Results stay short on big jobs, and the manifest pages
  through the rest.
- `DELETE /api/v1/jobs/:id` stops a running job first.
- `ALLOWED_HOSTS`, `ALLOWED_ORIGINS` and `ALLOWED_INPUT_DIRS`.
- `npm` packaging, with an `ilinxa-capture` bin for the stdio server.

### Changed

- **`HOST` defaults to `127.0.0.1`**, was `0.0.0.0`. The Docker image still listens
  inside the container; publish it with `-p 127.0.0.1:3000:3000`. Binding off
  loopback logs a warning.
- **`NODE_ENV` defaults to `production`**, and is never read from `.env`.
- **`LOCAL_TTL_SECONDS` defaults to `86400`**, was `3600`.
- **Requests are refused with `403` unless `Host` and `Origin` are allowed**, on
  every route. CORS no longer reflects any origin.
- **Over HTTP, local paths are refused** unless inside the output folder or
  `ALLOWED_INPUT_DIRS`. Over stdio any path still works.
- **Only known media containers are read**: MP4, MOV, MKV, WebM, AVI, MPEG-TS,
  MPEG-PS, FLV, WMV, Ogg, MXF, DV, IVF, and raw H.264, HEVC and MPEG video. GIF, Y4M,
  NUT, RealMedia, MJPEG and OBU no longer are.
- **FFmpeg 5.1 or newer is required.**
- **Frame times are real source times**, not `index / fps`. On video with gaps
  there are fewer frames than `duration × fps`, because held frames are no longer
  repeated.
- URL downloads run inside the job, so they count against concurrency, timeout
  and cancel. A too-long URL source now fails as a job in async mode.
- Unreadable files and refused containers are a `400` that says why, not a `500`.
- A file open in another program gives `409 FILES_IN_USE` on compose and delete.
- A sample rate the encoder does not have is a `400` listing the ones it does.
- Stdio writes to `~/.ilinxa-capture/jobs` by default, and runs cleanup.
- `/api/v1/health` reports the environment the server resolved.

### Fixed

- Ranges and shot frames are exact on MPEG-TS, MPEG-PS, FLV and AVI. Seeking on
  these could land past the target, returning later frames, wrong times or none.
- Every frame survives at source rate on MKV with AAC audio.
- Raw H.264, HEVC and MPEG video report their real duration and rate.
- A failed or cancelled compose leaves the earlier sheets and output as they were,
  including after a crash.
- A job's timeout now stops its whole process tree, and a stuck job can no longer
  hold a slot.
- ZIP downloads of very large jobs no longer run out of file handles, and a client
  that hangs up leaves nothing open.
- Job files are written atomically, and a delete that stops partway finishes on
  the next sweep.
- Stdio exits when its client goes away, stopping any running job.
- A link into the Web UI opens the page. Every URL but the root was a `500`.
- `headers` reach yt-dlp as well as HLS sources, so protected pages can be listed
  and downloaded.
- Overlay times on a job with no manifest need `fps`, rather than using 1 fps.
- Dependency updates, including Sharp 0.35 and archiver 8.

### Security

- Closed several ways for a web page or another caller to reach local files and
  processes through the server. Upgrade if you run an earlier version. See
  [ADR 0001](docs/adr/0001-local-first-trust-boundary.md) for the model this
  release enforces.
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
