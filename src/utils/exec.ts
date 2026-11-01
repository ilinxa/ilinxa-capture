import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const STDERR_TAIL_CHARS = 16 * 1024;
const ERROR_TAIL_CHARS = 2000;
const KILL_GRACE_MS = 3000;
// A descendant that left the process tree can hold the pipes open, so `close`
// never fires. Past this, stop waiting: a job must not hang on it forever.
const SETTLE_LIMIT_MS = KILL_GRACE_MS + 2000;

export interface ExecOptions {
  /** Max bytes of stdout to retain. Ignored when onStdoutLine consumes it. */
  maxBuffer?: number;
  /** Aborting kills the whole process tree, then rejects with signal.reason. */
  signal?: AbortSignal;
  /** Kill the process tree and reject after this long. */
  timeoutMs?: number;
  /** Receive stdout line by line instead of retaining it. */
  onStdoutLine?: (line: string) => void;
  /** Return true to keep a line out of the stderr tail (e.g. progress). */
  onStderrLine?: (line: string) => boolean | void;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Terminate a process and everything it started. yt-dlp spawns ffmpeg. */
function killTree(child: ChildProcess, force: boolean): void {
  if (child.pid === undefined) return;

  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    }).on("error", () => {
      child.kill();
    });
    return;
  }

  try {
    // Negative pid addresses the process group created by `detached: true`.
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  }
}

function createLineSplitter(onLine: (line: string) => void): {
  write: (chunk: Buffer) => void;
  end: () => void;
} {
  const decoder = new StringDecoder("utf8");
  let pending = "";

  return {
    write(chunk) {
      pending += decoder.write(chunk);
      const lines = pending.split(/\r\n|\n|\r/);
      pending = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    },
    end() {
      pending += decoder.end();
      if (pending) onLine(pending);
      pending = "";
    },
  };
}

/**
 * Run a command without a shell. Shared across core modules for ffmpeg,
 * ffprobe and yt-dlp, so timeouts, cancellation and output limits behave the
 * same everywhere. Settles only after the process has exited: a caller that
 * holds a concurrency slot keeps it until the work has really stopped.
 */
export function execFileAsync(
  cmd: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(opts.signal.reason);
      return;
    }

    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail = "";
    let failure: { reason: unknown } | null = null;
    let forceKillTimer: NodeJS.Timeout | null = null;
    let settleTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const stop = (reason: unknown): void => {
      if (failure) return;
      failure = { reason };
      killTree(child, false);
      forceKillTimer = setTimeout(() => killTree(child, true), KILL_GRACE_MS);
      settleTimer = setTimeout(() => {
        cleanup();
        child.stdout?.destroy();
        child.stderr?.destroy();
        reject(reason);
      }, SETTLE_LIMIT_MS);
    };

    const onAbort = (): void => stop(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    if (opts.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(
        () => stop(new Error(`${cmd} timed out after ${opts.timeoutMs}ms`)),
        opts.timeoutMs,
      );
    }

    const stdoutLines = opts.onStdoutLine
      ? createLineSplitter(opts.onStdoutLine)
      : null;
    const stderrLines = createLineSplitter((line) => {
      if (opts.onStderrLine?.(line) === true) return;
      stderrTail = `${stderrTail}${line}\n`.slice(-STDERR_TAIL_CHARS);
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutLines) {
        stdoutLines.write(chunk);
        return;
      }
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        stop(new Error(`${cmd} stdout exceeded ${maxBuffer} bytes`));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => stderrLines.write(chunk));

    const cleanup = (): void => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (settleTimer) clearTimeout(settleTimer);
    };

    child.once("error", (err) => {
      cleanup();
      reject(failure ? failure.reason : err);
    });

    child.once("close", (code, signal) => {
      cleanup();
      stdoutLines?.end();
      stderrLines.end();

      if (failure) {
        reject(failure.reason);
        return;
      }
      if (code === 0) {
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: stderrTail,
        });
        return;
      }

      const tail = stderrTail.trim().slice(-ERROR_TAIL_CHARS);
      const status = code === null ? `signal ${signal}` : `code ${code}`;
      reject(new Error(`${cmd} exited with ${status}${tail ? `: ${tail}` : ""}`));
    });
  });
}
