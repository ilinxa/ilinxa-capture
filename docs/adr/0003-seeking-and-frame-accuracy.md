# ADR 0003: Seeking and frame accuracy

**Status:** Accepted, 2026-11-01. Applies from 0.2.0.

## Context

ADR 0002 made frame times true for whole-file reads. Ranges and shot frames still
relied on an input `-ss` with `-t`, which assumes a seek lands where it was sent.
It often does not:

- MPEG-TS and MPEG-PS seek by byte search and land past the target, and decoding
  resumes at the next keyframe. `-t` then counts from there, so the whole window
  slides, and FFmpeg reports success.
- With B-frames, FFmpeg backs a seek off by up to 3/23 s. Near the start of a file
  that falls before the first keyframe, and the decoder starts blind, producing
  grey frames with plausible timestamps.
- After a seek, the label offset depends on the FFmpeg version, the container and
  which streams are in use.

## Decision

1. **Ranges are cut by time, after decoding.** A run with a target seeks early, on
   the source's own clock (`-copyts -start_at_zero -noaccurate_seek`), and a `trim`
   filter on microsecond timestamps keeps the wanted frames. No `-t`, and no offset
   is added to a label.
2. **A run checks where it landed.** The first frame out of the decoder is printed
   once. If it is more than half a frame past the target, or nothing was decoded,
   the run repeats from further back, then from the start. A retry costs a fraction
   of a second; a miss returns a frame of the wrong shot.
3. **Margins suit the container.** TS and PS start 3 s early, because their
   timestamps can be wrong just after landing, which no check can see. Raw streams
   never seek. A seek under 1 s is skipped, since reading that much costs nothing.
   Workers on one job share the margin that worked.
4. **Whole-file reads stay on FFmpeg's own clock.** It smooths a timestamp reset,
   as in joined TS captures, which the source clock would fail on.
5. **At source rate, every frame is kept**, with no sampling filter and an encoder
   clock of 1/1,000,000. MKV's millisecond timestamps collide on a clock running
   at the source rate. Below source rate, the sampling grid is anchored to the
   first frame, not to zero, so audio priming cannot put frames on a boundary.

## Consequences

- Frames in a range are exact across the containers tested, on FFmpeg 5.1 and 7.
- A source with very few keyframes costs a longer decode per ranged read.
- Only one extra print filter is possible at this point. Each holds its own 32 KB
  buffer on stdout, so two printing every frame interleave and misattach times.
  The first-frame filter prints once, unbuffered, before anything else.
- AVI stores no timestamps for B-frames, so FFmpeg's clock there runs one frame
  late. That stays within one source frame and is left as it is.
- On MPEG-TS and MPEG-PS with audio that starts before the video, frame times run
  early against audio by that lead, usually about 20 ms. Not addressed here.
- Nothing here has been run on real DVD, Blu-ray or broadcast media. All test
  media is generated.
