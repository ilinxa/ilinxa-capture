import { ValidationError } from "../utils/errors.js";
import type { TimeRange } from "./ffmpeg.js";

const SECONDS = /^\d+(?:\.\d+)?$/;
const CLOCK = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/;

/** Accepts seconds (`90.5`, `"90.5"`) or a clock (`"01:30.5"`, `"1:02:03.25"`). */
export function parseTimecode(value: number | string): number {
  if (typeof value === "number") {
    if (Number.isFinite(value) && value >= 0) return value;
    throw new ValidationError(`Invalid time '${value}'`);
  }

  const text = value.trim();
  if (SECONDS.test(text)) return Number(text);

  const clock = CLOCK.exec(text);
  if (clock) {
    const hours = Number(clock[1] ?? 0);
    const minutes = Number(clock[2]);
    const seconds = Number(clock[3]);
    if (minutes < 60 && seconds < 60) {
      return hours * 3600 + minutes * 60 + seconds;
    }
  }

  throw new ValidationError(
    `Invalid time '${value}'. Use seconds, MM:SS or HH:MM:SS`,
  );
}

/** `MM:SS.mmm`, with hours in front once a timeline reaches them. */
export function formatTimestamp(seconds: number): string {
  // Whole milliseconds first, so 59.9996 carries over rather than printing 60.
  const totalMs = Math.round(seconds * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor(totalMs / 60_000) % 60;
  const secs = Math.floor(totalMs / 1000) % 60;
  const millis = totalMs % 1000;

  const mm = String(minutes).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  const ms = String(millis).padStart(3, "0");

  const clock = `${mm}:${ss}.${ms}`;
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${clock}` : clock;
}

/**
 * Turn optional request times into a checked range on a source of known length.
 * Undefined means the whole file. `duration` is 0 when ffprobe could not tell.
 */
export function resolveRange(
  start: number | string | undefined,
  end: number | string | undefined,
  duration: number,
): TimeRange | undefined {
  if (start === undefined && end === undefined) return undefined;

  const from = start === undefined ? 0 : parseTimecode(start);
  const to = end === undefined ? duration : parseTimecode(end);
  const clamped = duration > 0 ? Math.min(to, duration) : to;

  if (duration > 0 && from >= duration) {
    throw new ValidationError(
      `'start' (${from}s) is past the end of the video (${duration}s)`,
    );
  }
  if (clamped <= from) {
    throw new ValidationError("'end' must be after 'start'");
  }

  return { start: from, end: clamped };
}
