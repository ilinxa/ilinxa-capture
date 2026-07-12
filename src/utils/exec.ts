import { execFile } from "node:child_process";

/**
 * Promisified wrapper around `child_process.execFile`.
 * Shared across core modules (ffmpeg, ffprobe, yt-dlp invocations) to avoid
 * duplicating the same hand-rolled promise wrapper in each file.
 */
export function execFileAsync(
  cmd: string,
  args: string[],
  opts?: { maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const callback = (
      error: Error | null,
      stdout: string,
      stderr: string,
    ): void => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    };

    if (opts?.maxBuffer !== undefined) {
      execFile(cmd, args, { maxBuffer: opts.maxBuffer }, callback);
    } else {
      execFile(cmd, args, callback);
    }
  });
}
