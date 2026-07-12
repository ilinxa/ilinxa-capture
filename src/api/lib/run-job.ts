import { unlink } from "node:fs/promises";
import type { FastifyReply } from "fastify";
import type { JobManager, TaskFunction } from "../../core/job-manager.js";

export interface RunJobOptions<T> {
  jobManager: JobManager;
  jobId: string;
  isAsync: boolean;
  task: TaskFunction<T>;
  reply: FastifyReply;
  /**
   * Temp file (uploaded/downloaded source) owned by the caller, if any. In
   * async mode, ownership transfers into the background task — it is
   * unlinked (best-effort) once the task settles. In sync mode the caller
   * retains ownership and must clean it up itself (e.g. in its own
   * try/finally) since runJob has already replied by the time it returns.
   */
  tempPath?: string | null;
}

export interface RunJobResult {
  /**
   * True when async mode took ownership of tempPath cleanup. Callers that
   * track tempPath in a local variable should null it out when this is true,
   * to avoid a double-unlink in their own finally block.
   */
  tempPathOwnershipTransferred: boolean;
}

/**
 * Shared async/sync job execution + reply logic used by extract, compose,
 * combined, and video-download handlers. Behavior is identical across all
 * four: async mode kicks off the task in the background and replies 202
 * with a poll_url; sync mode awaits the task and replies 200 with the
 * result.
 */
export async function runJob<T>(opts: RunJobOptions<T>): Promise<RunJobResult> {
  const { jobManager, jobId, isAsync, task, reply, tempPath } = opts;

  if (isAsync) {
    const capturedTemp = tempPath ?? null;
    const wrappedTask: TaskFunction<T> = async (id) => {
      try {
        return await task(id);
      } finally {
        if (capturedTemp) {
          await unlink(capturedTemp).catch(() => {
            // best-effort temp cleanup
          });
        }
      }
    };
    jobManager.runAsync(jobId, wrappedTask);
    void reply.code(202).send({
      job_id: jobId,
      status: "pending",
      poll_url: `/api/v1/jobs/${jobId}`,
    });
    return { tempPathOwnershipTransferred: capturedTemp !== null };
  }

  const result = await jobManager.runSync(jobId, task);
  void reply.code(200).send(result);
  return { tempPathOwnershipTransferred: false };
}
