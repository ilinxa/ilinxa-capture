import type { FastifyReply } from "fastify";
import type { Submission } from "../../core/service.js";

/** Aborts if the client hangs up first, so its sync job stops holding a slot. */
export function clientGone(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.once("close", () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller.signal;
}

/** 200 with the result, or 202 with a poll URL for a job left running. */
export function sendSubmission<T>(
  reply: FastifyReply,
  submission: Submission<T>,
): void {
  if (submission.status === "accepted") {
    void reply.code(202).send({
      job_id: submission.jobId,
      status: "pending",
      poll_url: `/api/v1/jobs/${submission.jobId}`,
    });
    return;
  }

  void reply.code(200).send(submission.result);
}
