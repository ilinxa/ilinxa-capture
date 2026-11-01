# ADR 0002: Shared service and a true timeline

**Status:** Accepted, 2026-11-01. Applies from 0.2.0.

## Context

Film analysis needs frames, shots and audio that line up. Three things stood in
the way:

- REST handlers and MCP tools each orchestrated the pipelines, and each defined
  its options. They had already drifted.
- Frame times were computed as `index / fps`. FFmpeg's `fps` filter does not take
  frames from those instants, so labels were off by about half a sampling interval
  on all video.
- The job timeout came from the queue, which stopped waiting without stopping the
  work. Over-limit processes kept running, and async jobs crashed the server.

## Decision

1. **`CaptureService` owns every pipeline.** REST and MCP translate requests and
   responses and nothing else. Option shapes live once in `core/options.ts`, and
   a test fails if a REST option is missing from its MCP tool.
2. **Frames carry their source timestamp.** Sampling uses a `select` filter that
   takes the first frame in each interval, and `metadata=print` reports its real
   presentation time. Times are written to `manifest.json` in the job directory,
   which also holds shots and the frames on each sheet.
3. **Each job owns an `AbortController`.** Timeout, cancel and shutdown all abort
   it, which kills the process tree. The concurrency slot is held until the task
   settles, so the limit stays true after a timeout.
4. **Downloads run inside the job.** They count against concurrency, timeout and
   cancel. As a result, a too-long URL source now fails as a job in async mode
   rather than at request time.
5. **Composing a job reopens it.** Sheets join the existing job, old sheets are
   cleared, and the result keeps its frame data.
6. **Shot detection uses FFmpeg's scene filter.** It adds no system dependency.
   It finds hard cuts well and can miss dissolves and fades, so the threshold is
   configurable.

## Consequences

- FFmpeg 5.1 or newer is required.
- Frame counts can be lower than `duration × fps` on video with gaps, because
  held frames are no longer duplicated. Every frame shown really exists at its
  stated time.
- Sampling a whole file still decodes the whole file.
- Per-shot frames seek once per frame, which is fast enough at film scale and
  keeps each frame's timestamp exact.
