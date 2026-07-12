import type { FastifyReply, FastifyRequest } from "fastify";
import type { JobManager } from "../core/job-manager.js";
import type { JobIdParams } from "./schemas.js";

export function createGetJobHandler(jobManager: JobManager) {
  return async function getJobHandler(
    request: FastifyRequest<{ Params: JobIdParams }>,
    reply: FastifyReply,
  ): Promise<void> {
    const job = jobManager.getJob(request.params.id);

    if (job.status === "completed") {
      // Return the full sync response body directly (per spec)
      void reply
        .header("content-type", "application/json; charset=utf-8")
        .send(JSON.stringify(job.result));
      return;
    }

    if (job.status === "failed") {
      void reply
        .header("content-type", "application/json; charset=utf-8")
        .send(
          JSON.stringify({
            job_id: job.id,
            status: "failed",
            error: job.error,
            failed_at: job.failed_at,
          }),
        );
      return;
    }

    // pending or processing
    void reply
      .header("content-type", "application/json; charset=utf-8")
      .send(
        JSON.stringify({
          job_id: job.id,
          status: job.status,
          progress: null,
          started_at: job.started_at,
        }),
      );
  };
}

export function createDeleteJobHandler(jobManager: JobManager) {
  return async function deleteJobHandler(
    request: FastifyRequest<{ Params: JobIdParams }>,
    reply: FastifyReply,
  ): Promise<void> {
    await jobManager.deleteJob(request.params.id);
    void reply.code(204).send();
  };
}
