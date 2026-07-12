import PQueue from "p-queue";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
interface MinimalLogger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}
import type { Env } from "../lib/env.js";
import { JobNotFoundError } from "../utils/errors.js";

export type JobStatus = "pending" | "processing" | "completed" | "failed";
export type JobType = "extract" | "compose" | "combined" | "video_download";

export interface JobState {
  id: string;
  type: JobType;
  status: JobStatus;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  error: string | null;
  webhook_url: string | null;
  result: unknown | null;
  processing_time_ms: number | null;
}

// Kept adjacent to JobState so the two can't drift out of sync.
// Non-identity fields are nullish (absent keys tolerated) so job.json files
// written by older builds — before a field existed — still recover; the
// transform normalizes them to the `| null` shape JobState requires.
export const jobStateSchema = z
  .object({
    id: z.string(),
    type: z.enum(["extract", "compose", "combined", "video_download"]),
    status: z.enum(["pending", "processing", "completed", "failed"]),
    created_at: z.string(),
    started_at: z.string().nullish(),
    completed_at: z.string().nullish(),
    failed_at: z.string().nullish(),
    error: z.string().nullish(),
    webhook_url: z.string().nullish(),
    result: z.unknown().nullish(),
    processing_time_ms: z.number().nullish(),
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
      webhook_url: j.webhook_url ?? null,
      result: j.result ?? null,
      processing_time_ms: j.processing_time_ms ?? null,
    }),
  );

export interface CreateJobOptions {
  type: JobType;
  webhookUrl?: string;
}

export type TaskFunction<T> = (jobId: string) => Promise<T>;

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
  private readonly queue: PQueue;
  private readonly outputDir: string;
  private readonly logger: MinimalLogger;

  constructor(env: Env, logger: MinimalLogger) {
    this.outputDir = resolve(env.LOCAL_OUTPUT_DIR);
    this.logger = logger;
    this.queue = new PQueue({
      concurrency: env.MAX_CONCURRENT_JOBS,
      timeout: env.JOB_TIMEOUT * 1000,
    });
  }

  generateJobId(): string {
    return `cap_${randomUUID().slice(0, 8)}`;
  }

  getJobDir(jobId: string): string {
    return resolve(this.outputDir, jobId);
  }

  async createJob(jobId: string, opts: CreateJobOptions): Promise<JobState> {
    const job: JobState = {
      id: jobId,
      type: opts.type,
      status: "pending",
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      failed_at: null,
      error: null,
      webhook_url: opts.webhookUrl ?? null,
      result: null,
      processing_time_ms: null,
    };

    this.jobs.set(jobId, job);
    await this.persistJob(job);
    return job;
  }

  getJob(jobId: string): JobState {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }
    return job;
  }

  async deleteJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }

    this.jobs.delete(jobId);
    const jobDir = this.getJobDir(jobId);
    await rm(jobDir, { recursive: true, force: true });
  }

  async runSync<T>(jobId: string, task: TaskFunction<T>): Promise<T> {
    const job = this.getJob(jobId);

    const result = await this.queue.add(async () => {
      job.status = "processing";
      job.started_at = new Date().toISOString();
      await this.persistJob(job);

      const startTime = Date.now();
      try {
        const taskResult = await task(jobId);
        job.status = "completed";
        job.completed_at = new Date().toISOString();
        job.result = taskResult;
        job.processing_time_ms = Date.now() - startTime;
        await this.persistJob(job);
        return taskResult;
      } catch (err) {
        job.status = "failed";
        job.failed_at = new Date().toISOString();
        job.error = err instanceof Error ? err.message : String(err);
        job.processing_time_ms = Date.now() - startTime;
        await this.persistJob(job);
        throw err;
      }
    });

    return result as T;
  }

  runAsync(jobId: string, task: TaskFunction<unknown>): void {
    void this.queue.add(async () => {
      const job = this.jobs.get(jobId);
      if (!job) return; // Job was deleted while queued

      job.status = "processing";
      job.started_at = new Date().toISOString();
      await this.persistJob(job);

      const startTime = Date.now();
      try {
        const taskResult = await task(jobId);
        job.status = "completed";
        job.completed_at = new Date().toISOString();
        job.result = taskResult;
        job.processing_time_ms = Date.now() - startTime;
        await this.persistJob(job);
      } catch (err) {
        job.status = "failed";
        job.failed_at = new Date().toISOString();
        job.error = err instanceof Error ? err.message : String(err);
        job.processing_time_ms = Date.now() - startTime;
        await this.persistJob(job);
      }

      await this.fireWebhook(job);
    });
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
        if (!result.success) {
          this.logger.warn(
            { jobJsonPath },
            "Skipping invalid job.json during recovery",
          );
          continue;
        }
        const job = result.data;

        // Mark stuck jobs as failed
        if (job.status === "processing" || job.status === "pending") {
          job.status = "failed";
          job.failed_at = new Date().toISOString();
          job.error = "Server restarted during processing";
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

  async shutdown(): Promise<void> {
    this.queue.clear();
    await this.queue.onIdle();
    this.logger.info("Job manager shut down");
  }

  private async persistJob(job: JobState): Promise<void> {
    const jobDir = this.getJobDir(job.id);
    await mkdir(jobDir, { recursive: true });
    await writeFile(
      join(jobDir, "job.json"),
      JSON.stringify(job, null, 2),
    );
  }

  private async fireWebhook(job: JobState): Promise<void> {
    if (!job.webhook_url) return;

    const payload: WebhookPayload = {
      event: job.status === "completed" ? "job.completed" : "job.failed",
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
