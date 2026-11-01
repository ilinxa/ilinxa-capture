import PQueue from "p-queue";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
interface MinimalLogger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}
import type { Env } from "../lib/env.js";
import {
  FilesInUseError,
  JobBusyError,
  JobCancelledError,
  JobNotFoundError,
  JobTimeoutError,
} from "../utils/errors.js";
import { assertValidJobId, JOB_ID_PATTERN } from "./job-id.js";
import { isFileInUse, removeTree, settleSwap, writeFileAtomic } from "./safe-fs.js";

export type JobStatus = "pending" | "processing" | "completed" | "failed";
export type JobType =
  | "extract"
  | "compose"
  | "combined"
  | "video_download"
  | "shots"
  | "audio";

export interface JobProgress {
  stage: string;
  percent: number | null;
}

/** A job's standing before it was reopened, to return to if the new work fails. */
export interface ReopenSnapshot {
  type: JobType;
  status: JobStatus;
  completed_at: string | null;
  failed_at: string | null;
}

export interface JobState {
  id: string;
  type: JobType;
  status: JobStatus;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  error: string | null;
  error_code: string | null;
  webhook_url: string | null;
  result: unknown | null;
  processing_time_ms: number | null;
  progress: JobProgress | null;
  /** On disk too, so a restart can undo a reopen it interrupted. */
  reopened_from: ReopenSnapshot | null;
}

const jobTypeSchema = z.enum([
  "extract",
  "compose",
  "combined",
  "video_download",
  "shots",
  "audio",
]);
const jobStatusSchema = z.enum(["pending", "processing", "completed", "failed"]);

// Kept adjacent to JobState so the two can't drift out of sync.
// Non-identity fields are nullish (absent keys tolerated) so job.json files
// written by older builds — before a field existed — still recover; the
// transform normalizes them to the `| null` shape JobState requires.
export const jobStateSchema = z
  .object({
    id: z.string().regex(JOB_ID_PATTERN),
    type: jobTypeSchema,
    status: jobStatusSchema,
    created_at: z.string(),
    started_at: z.string().nullish(),
    completed_at: z.string().nullish(),
    failed_at: z.string().nullish(),
    error: z.string().nullish(),
    error_code: z.string().nullish(),
    webhook_url: z.string().nullish(),
    result: z.unknown().nullish(),
    processing_time_ms: z.number().nullish(),
    reopened_from: z
      .object({
        type: jobTypeSchema,
        status: jobStatusSchema,
        completed_at: z.string().nullable(),
        failed_at: z.string().nullable(),
      })
      .nullish(),
  })
  .transform(
    (j): JobState => ({
      id: j.id,
      type: j.type,
      status: j.status,
      created_at: j.created_at,
      started_at: j.started_at ?? null,
      completed_at: j.completed_at ?? null,
      failed_at: j.failed_at ?? null,
      error: j.error ?? null,
      error_code: j.error_code ?? null,
      webhook_url: j.webhook_url ?? null,
      result: j.result ?? null,
      processing_time_ms: j.processing_time_ms ?? null,
      progress: null,
      reopened_from: j.reopened_from ?? null,
    }),
  );

export interface CreateJobOptions {
  type: JobType;
  webhookUrl?: string;
}

/** What a running task gets from the manager. */
export interface JobContext {
  jobId: string;
  /** Aborted on timeout, cancel and shutdown. Pass it to every child process. */
  signal: AbortSignal;
  reportProgress: (progress: JobProgress) => void;
}

export type TaskFunction<T> = (ctx: JobContext) => Promise<T>;

interface ActiveJob {
  controller: AbortController;
  settled: Promise<void>;
}

interface WebhookPayload {
  event: "job.completed" | "job.failed";
  job_id: string;
  status: JobStatus;
  result: unknown | null;
  error: string | null;
  completed_at: string | null;
  failed_at: string | null;
}

export class JobManager {
  private readonly jobs: Map<string, JobState> = new Map();
  private readonly active: Map<string, ActiveJob> = new Map();
  private readonly cancelled: Set<string> = new Set();
  private readonly deleting: Set<string> = new Set();
  private readonly queue: PQueue;
  private readonly outputDir: string;
  private readonly logger: MinimalLogger;
  private readonly timeoutSeconds: number;
  private closing = false;

  constructor(env: Env, logger: MinimalLogger) {
    this.outputDir = resolve(env.LOCAL_OUTPUT_DIR);
    this.logger = logger;
    this.timeoutSeconds = env.JOB_TIMEOUT;
    this.queue = new PQueue({ concurrency: env.MAX_CONCURRENT_JOBS });
  }

  generateJobId(): string {
    return `cap_${randomUUID().slice(0, 8)}`;
  }

  getJobDir(jobId: string): string {
    assertValidJobId(jobId);
    return resolve(this.outputDir, jobId);
  }

  async createJob(jobId: string, opts: CreateJobOptions): Promise<JobState> {
    assertValidJobId(jobId);
    const job: JobState = {
      id: jobId,
      type: opts.type,
      status: "pending",
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      failed_at: null,
      error: null,
      error_code: null,
      webhook_url: opts.webhookUrl ?? null,
      result: null,
      processing_time_ms: null,
      progress: null,
      reopened_from: null,
    };

    this.jobs.set(jobId, job);
    await this.persistJob(job);
    return job;
  }

  /**
   * Put a finished job back in the queue for more work on the same output, as
   * composing sheets from extracted frames does. `result` is kept for the task
   * to build on. The status check and change are one synchronous step, so two
   * concurrent callers can never both win.
   */
  async reopenJob(jobId: string, opts: CreateJobOptions): Promise<JobState> {
    const job = this.getJob(jobId);
    if (job.status === "pending" || job.status === "processing" || this.deleting.has(jobId)) {
      throw new JobBusyError(jobId);
    }

    const before = { ...job };

    job.reopened_from = {
      type: job.type,
      status: job.status,
      completed_at: job.completed_at,
      failed_at: job.failed_at,
    };

    job.type = opts.type;
    job.status = "pending";
    job.webhook_url = opts.webhookUrl ?? job.webhook_url;
    job.started_at = null;
    job.completed_at = null;
    job.failed_at = null;
    job.error = null;
    job.error_code = null;
    job.progress = null;

    try {
      await this.persistJob(job);
    } catch (err) {
      // Nothing is queued for it, so "pending" would be a state it never leaves.
      Object.assign(job, before);
      throw err;
    }
    return job;
  }

  getJob(jobId: string): JobState {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }
    return job;
  }

  /** Stop a job if it is running, then remove it and everything it wrote. */
  async deleteJob(jobId: string): Promise<void> {
    if (!this.jobs.has(jobId)) {
      throw new JobNotFoundError(jobId);
    }

    this.deleting.add(jobId);
    try {
      const active = this.active.get(jobId);
      if (active) {
        active.controller.abort(new JobCancelledError(jobId));
        await active.settled;
      }

      // Removed from the registry only once gone: a failed delete stays tracked.
      await removeTree(this.getJobDir(jobId));
      this.jobs.delete(jobId);
      this.cancelled.delete(jobId);
    } catch (err) {
      // The queue may have skipped this job while the delete held it.
      const job = this.jobs.get(jobId);
      if (job) await this.persistJob(job).catch(() => {});
      throw isFileInUse(err) ? new FilesInUseError(jobId) : err;
    } finally {
      this.deleting.delete(jobId);
    }
  }

  /** Stop a job but keep it and its output: a caller gave up waiting for it. */
  cancelJob(jobId: string): void {
    const active = this.active.get(jobId);
    if (active) {
      active.controller.abort(new JobCancelledError(jobId));
    } else if (this.jobs.get(jobId)?.status === "pending") {
      this.cancelled.add(jobId);
    }
  }

  /** Whether work on this job is queued or running, so it must not be swept. */
  isBusy(jobId: string): boolean {
    const status = this.jobs.get(jobId)?.status;
    return status === "pending" || status === "processing";
  }

  /** Whether anything is queued or running, including work with no job record. */
  hasWork(): boolean {
    if (this.active.size > 0) return true;
    return [...this.jobs.keys()].some((jobId) => this.isBusy(jobId));
  }

  /** Drop a job whose directory is already gone, as after a cleanup sweep. */
  forgetJob(jobId: string): void {
    if (!this.active.has(jobId)) {
      this.jobs.delete(jobId);
    }
  }

  /**
   * Run work that leaves no job record, under the same limits as a job: it
   * takes a queue slot, times out, and stops at shutdown. `caller` going away
   * stops it too, since no job ID exists for anyone to stop it by.
   */
  async runTransient<T>(
    task: (signal: AbortSignal) => Promise<T>,
    caller?: AbortSignal,
  ): Promise<T> {
    const key = `transient_${randomUUID()}`;

    const result = await this.queue.add(async () => {
      if (this.closing || caller?.aborted) throw new JobCancelledError(key);

      const { controller, finish } = this.track(key);
      const cancel = (): void => controller.abort(new JobCancelledError(key));
      caller?.addEventListener("abort", cancel, { once: true });
      try {
        return await task(controller.signal);
      } finally {
        caller?.removeEventListener("abort", cancel);
        finish();
      }
    });
    return result as T;
  }

  async runSync<T>(
    jobId: string,
    task: TaskFunction<T>,
    onSkipped?: () => Promise<void>,
  ): Promise<T> {
    this.getJob(jobId);
    const result = await this.queue.add(() =>
      this.execute(jobId, task, onSkipped),
    );
    return result as T;
  }

  runAsync(
    jobId: string,
    task: TaskFunction<unknown>,
    onSkipped?: () => Promise<void>,
  ): void {
    this.queue
      .add(async () => {
        try {
          await this.execute(jobId, task, onSkipped);
        } catch {
          // Already recorded on the job. Nothing is waiting for this promise.
        }

        const job = this.jobs.get(jobId);
        if (job && !this.closing) await this.fireWebhook(job);
      })
      .catch((err: unknown) => {
        // A rejection here would be unhandled, and that ends the process.
        this.logger.warn({ jobId, err }, "Async job failed to settle");
      });
  }

  /**
   * Run one task inside its queue slot. The slot is held until the task has
   * settled, which `execFileAsync` only does once its process is gone, so
   * MAX_CONCURRENT_JOBS stays true after a timeout.
   */
  private async execute<T>(
    jobId: string,
    task: TaskFunction<T>,
    onSkipped?: () => Promise<void>,
  ): Promise<T> {
    const job = this.jobs.get(jobId);
    const deleting = this.deleting.has(jobId);
    if (!job || this.closing || deleting || this.cancelled.has(jobId)) {
      // Deleted, cancelled or shut down while queued
      await onSkipped?.().catch(() => {});
      if (job && (this.cancelled.delete(jobId) || deleting)) {
        job.error = new JobCancelledError(jobId).message;
        job.error_code = "JOB_CANCELLED";
        if (!restoreReopened(job)) {
          job.status = "failed";
          job.failed_at = new Date().toISOString();
        }
        // A delete owns the directory now, and a write would bring it back.
        if (!this.deleting.has(jobId)) await this.persistIfTracked(job);
      }
      throw new JobCancelledError(jobId);
    }

    const { controller, finish } = this.track(jobId);

    const startTime = Date.now();
    let started = false;
    try {
      job.status = "processing";
      job.started_at = new Date().toISOString();
      await this.persistJob(job);

      // An abort during that write fired before the task could be listening.
      controller.signal.throwIfAborted();

      started = true;
      const taskResult = await task({
        jobId,
        signal: controller.signal,
        reportProgress: (progress) => {
          job.progress = progress;
        },
      });

      job.status = "completed";
      job.completed_at = new Date().toISOString();
      job.result = taskResult;
      job.processing_time_ms = Date.now() - startTime;
      job.progress = null;
      job.reopened_from = null;
      await this.persistIfTracked(job);
      return taskResult;
    } catch (err) {
      if (!started) await onSkipped?.().catch(() => {});

      // Core modules wrap process errors; the abort reason is the real cause.
      const failure: unknown = controller.signal.aborted
        ? controller.signal.reason
        : err;

      job.error = failure instanceof Error ? failure.message : String(failure);
      job.error_code = errorCode(failure);
      job.processing_time_ms = Date.now() - startTime;
      job.progress = null;

      // Failed extra work must not cost the job what it already had. The error
      // stays on the record, but the output remains reachable.
      if (!restoreReopened(job)) {
        job.status = "failed";
        job.failed_at = new Date().toISOString();
      }

      await this.persistIfTracked(job);
      throw failure;
    } finally {
      finish();
    }
  }

  /** Register running work: its abort controller, timeout and settled promise. */
  private track(key: string): { controller: AbortController; finish: () => void } {
    const controller = new AbortController();
    let markSettled: () => void = () => {};
    const settled = new Promise<void>((done) => {
      markSettled = done;
    });
    this.active.set(key, { controller, settled });

    const timer =
      this.timeoutSeconds > 0
        ? setTimeout(
            () => controller.abort(new JobTimeoutError(String(this.timeoutSeconds))),
            this.timeoutSeconds * 1000,
          )
        : null;

    return {
      controller,
      finish: () => {
        if (timer) clearTimeout(timer);
        // A reopen can start new work before the old run gets here.
        if (this.active.get(key)?.controller === controller) {
          this.active.delete(key);
        }
        markSettled();
      },
    };
  }

  async recover(): Promise<void> {
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
        return; // No job directory yet — fresh install
      }
      throw err;
    }

    for (const entry of entries) {
      const jobJsonPath = join(this.outputDir, entry, "job.json");
      try {
        const content = await readFile(jobJsonPath, "utf-8");
        const parsed: unknown = JSON.parse(content);
        const result = jobStateSchema.safeParse(parsed);
        if (!result.success || result.data.id !== entry) {
          this.logger.warn(
            { jobJsonPath },
            "Skipping invalid job.json during recovery",
          );
          continue;
        }
        const job = result.data;

        // Mark stuck jobs as failed
        if (job.status === "processing" || job.status === "pending") {
          job.error = "Server restarted during processing";
          await settleSwap(join(this.getJobDir(job.id), "sheets"));

          if (!restoreReopened(job)) {
            // Older builds did not record a reopen, but a result shows one.
            const reopened = job.result !== null;
            job.status = reopened ? "completed" : "failed";
            const now = new Date().toISOString();
            if (reopened) job.completed_at = now;
            else job.failed_at = now;
          }
          await this.persistJob(job);
        }

        this.jobs.set(job.id, job);
      } catch {
        // Skip directories without valid job.json
      }
    }

    this.logger.info(
      { recovered: this.jobs.size },
      "Job recovery completed",
    );
  }

  /**
   * Stop running jobs, so no process outlives the server. Queued jobs drain
   * through execute() and reject: clearing the queue instead would leave their
   * callers waiting forever. Recovery marks them failed on the next start.
   */
  async shutdown(): Promise<void> {
    this.closing = true;
    for (const [jobId, active] of this.active) {
      active.controller.abort(new JobCancelledError(jobId));
    }
    await this.queue.onIdle();
    this.logger.info("Job manager shut down");
  }

  private async persistIfTracked(job: JobState): Promise<void> {
    if (this.jobs.has(job.id)) {
      await this.persistJob(job);
    }
  }

  private async persistJob(job: JobState): Promise<void> {
    const jobDir = this.getJobDir(job.id);
    await mkdir(jobDir, { recursive: true });
    await writeFileAtomic(join(jobDir, "job.json"), JSON.stringify(job, null, 2));
  }

  private async fireWebhook(job: JobState): Promise<void> {
    if (!job.webhook_url) return;

    const payload: WebhookPayload = {
      event:
        job.status === "completed" && job.error === null
          ? "job.completed"
          : "job.failed",
      job_id: job.id,
      status: job.status,
      result: job.result,
      error: job.error,
      completed_at: job.completed_at,
      failed_at: job.failed_at,
    };

    try {
      await fetch(job.webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      this.logger.warn(
        { jobId: job.id, webhookUrl: job.webhook_url, err },
        "Webhook delivery failed",
      );
    }
  }
}

/** Put a reopened job back as it stood. False if it was not reopened. */
function restoreReopened(job: JobState): boolean {
  const before = job.reopened_from;
  if (!before) return false;

  job.type = before.type;
  job.status = before.status;
  job.completed_at = before.completed_at;
  job.failed_at = before.failed_at;
  job.reopened_from = null;
  return true;
}

function errorCode(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "code" in err) {
    const { code } = err as { code: unknown };
    return typeof code === "string" ? code : null;
  }
  return null;
}
