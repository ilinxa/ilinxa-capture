import { extname } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { JobManager } from "../core/job-manager.js";
import type { Storage } from "../core/storage.js";
import { FileNotFoundError, ValidationError } from "../utils/errors.js";

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

export function createFileHandler(jobManager: JobManager, storage: Storage) {
  return async function fileHandler(
    request: FastifyRequest<{ Params: { jobId: string; "*": string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { jobId } = request.params;
    const relativePath = request.params["*"];

    // Validate job exists (throws JOB_NOT_FOUND)
    const job = jobManager.getJob(jobId);
    if (job.status !== "completed") {
      throw new ValidationError(
        `Job '${jobId}' is not completed (status: ${job.status})`,
      );
    }

    // Check file exists
    const exists = await storage.fileExists(jobId, relativePath);
    if (!exists) {
      throw new FileNotFoundError(relativePath, jobId);
    }

    // Determine MIME type from extension
    const ext = extname(relativePath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    // Read file into buffer — individual frames/sheets are small enough
    const buffer = await storage.readFile(jobId, relativePath);

    void reply
      .header("content-type", contentType)
      .header("cache-control", "public, max-age=3600")
      .send(buffer);
  };
}
