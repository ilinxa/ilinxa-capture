import { join } from "node:path";
import { ZipArchive } from "archiver";
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
    const archive = new ZipArchive({ zlib: { level: 1 } });

    // An unhandled stream error would end the whole process.
    archive.on("error", (err: Error) => {
      request.log.error({ err, jobId }, "ZIP download failed");
      reply.raw.destroy(err);
    });

    // file(), not append(stream): a film's frames would each hold a descriptor
    // open from the start, and the OS limit is reached around 8,000 on Windows.
    for (const file of files) {
      archive.file(file.path, { name: file.relativePath });
    }

    if (await storage.fileExists(jobId, "manifest.json")) {
      archive.file(join(storage.getJobDir(jobId), "manifest.json"), {
        name: "manifest.json",
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
