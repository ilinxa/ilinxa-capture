import archiver from "archiver";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { JobManager } from "../core/job-manager.js";
import type { Storage } from "../core/storage.js";
import { ValidationError } from "../utils/errors.js";
import type { JobIdParams, DownloadQuery } from "./schemas.js";

export function createDownloadHandler(jobManager: JobManager, storage: Storage) {
  return async function downloadHandler(
    request: FastifyRequest<{ Params: JobIdParams; Querystring: DownloadQuery }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { id: jobId } = request.params;
    const { include } = request.query;

    // Validate job exists (throws JOB_NOT_FOUND)
    const job = jobManager.getJob(jobId);
    if (job.status !== "completed") {
      throw new ValidationError(
        `Job '${jobId}' is not completed (status: ${job.status})`,
      );
    }

    // Get file list based on include filter
    const subDir = include === "all" ? undefined : (include as "frames" | "sheets");
    const files = await storage.listFiles(jobId, subDir);
    if (files.length === 0) {
      throw new ValidationError(`No ${include} files found for job '${jobId}'`);
    }

    // Create ZIP archive with fast compression (images already compressed)
    const archive = archiver("zip", { zlib: { level: 1 } });

    for (const file of files) {
      archive.append(storage.getFileStream(jobId, file.relativePath), {
        name: file.relativePath,
      });
    }

    void reply
      .header("content-type", "application/zip")
      .header(
        "content-disposition",
        `attachment; filename="${jobId}-${include}.zip"`,
      )
      .send(archive);

    // Finalize AFTER send — Fastify pipes the stream, archiver pushes data
    await archive.finalize();
  };
}
