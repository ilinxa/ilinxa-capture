import { readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface MinimalLogger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

interface CleanupOptions {
  outputDir: string;
  ttlSeconds: number;
  intervalMs?: number;
  logger: MinimalLogger;
}

export class CleanupScheduler {
  private readonly outputDir: string;
  private readonly ttlMs: number;
  private readonly intervalMs: number;
  private readonly logger: MinimalLogger;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: CleanupOptions) {
    this.outputDir = resolve(opts.outputDir);
    this.ttlMs = opts.ttlSeconds * 1000;
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.logger = opts.logger;
  }

  start(): void {
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sweep(): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.outputDir);
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: string }).code === "ENOENT"
      ) {
        return 0;
      }
      throw err;
    }

    const now = Date.now();
    let cleaned = 0;

    for (const entry of entries) {
      const jobJsonPath = join(this.outputDir, entry, "job.json");

      let content: string;
      try {
        content = await readFile(jobJsonPath, "utf-8");
      } catch (err: unknown) {
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code: string }).code === "ENOENT"
        ) {
          continue; // No job.json in this dir — silent skip
        }
        this.logger.warn(
          { jobJsonPath, err },
          "Skipping invalid job.json during cleanup sweep",
        );
        continue;
      }

      let job: {
        status: string;
        completed_at: string | null;
        failed_at: string | null;
      };
      try {
        const parsed: unknown = JSON.parse(content);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          typeof (parsed as Record<string, unknown>)["status"] !== "string"
        ) {
          throw new Error("job.json has an invalid shape");
        }
        job = parsed as {
          status: string;
          completed_at: string | null;
          failed_at: string | null;
        };
      } catch (err) {
        this.logger.warn(
          { jobJsonPath, err },
          "Skipping invalid job.json during cleanup sweep",
        );
        continue;
      }

      if (job.status !== "completed" && job.status !== "failed") {
        continue;
      }

      const terminalTimestamp = job.completed_at ?? job.failed_at;
      if (!terminalTimestamp) continue;

      const terminalTime = new Date(terminalTimestamp).getTime();
      if (now - terminalTime < this.ttlMs) continue;

      await rm(join(this.outputDir, entry), { recursive: true, force: true });
      cleaned++;
    }

    if (cleaned > 0) {
      this.logger.info({ cleaned }, "Cleanup sweep completed");
    }

    const tempCleaned = await this.sweepTempFiles(now);
    if (tempCleaned > 0) {
      this.logger.info({ cleaned: tempCleaned }, "Temp file cleanup sweep completed");
    }

    return cleaned;
  }

  private async sweepTempFiles(now: number): Promise<number> {
    let tempEntries: string[];
    try {
      tempEntries = await readdir(tmpdir());
    } catch {
      // Best-effort: tmpdir may be unreadable — silently skip
      return 0;
    }

    let cleaned = 0;

    for (const entry of tempEntries) {
      if (!entry.startsWith("ilinxa-capture-")) continue;

      try {
        const entryPath = join(tmpdir(), entry);
        const stats = await stat(entryPath);
        if (now - stats.mtimeMs < this.ttlMs) continue;

        await rm(entryPath, { force: true });
        cleaned++;
      } catch {
        // Best-effort: file may be in use (esp. on Windows) or already gone — silent skip
        continue;
      }
    }

    return cleaned;
  }
}
