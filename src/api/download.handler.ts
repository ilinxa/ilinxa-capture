import { open } from "node:fs/promises";
import type { ReadStream } from "node:fs";
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

    const queue = files.map((file) => ({ path: file.path, name: file.relativePath }));
    if (await storage.fileExists(jobId, "manifest.json")) {
      queue.push({
        path: join(storage.getJobDir(jobId), "manifest.json"),
        name: "manifest.json",
      });
    }

    // One file open at a time: a film's frames all opened up front would pass
    // the OS limit. Held here, not inside archiver, so a client that hangs up
    // leaves nothing open, which on Windows would stop the job being deleted.
    let current: ReadStream | null = null;
    const next = async (): Promise<void> => {
      const entry = queue.shift();
      if (!entry) {
        current = null;
        archive.finalize().catch(() => {});
        return;
      }
      // Opened first: a file gone by now is skipped, as archive.file() would.
      const handle = await open(entry.path).catch(() => null);
      if (!handle) return next();
      if (reply.raw.destroyed) {
        await handle.close();
        return;
      }
      current = handle.createReadStream();
      current.on("error", (err: Error) => {
        request.log.error({ err, jobId }, "ZIP read failed");
        reply.raw.destroy(err);
      });
      archive.append(current, { name: entry.name });
    };
    const feed = (): void => {
      next().catch((err: unknown) => {
        request.log.error({ err, jobId }, "ZIP read failed");
        reply.raw.destroy();
      });
    };
    archive.on("entry", feed);

    reply.raw.once("close", () => {
      if (reply.raw.writableFinished) return;
      queue.length = 0;
      current?.destroy();
      archive.abort();
    });

    void reply
      .header("content-type", "application/zip")
      .header(
        "content-disposition",
        `attachment; filename="${jobId}-${include}.zip"`,
      )
      .send(archive);

    feed();
    await reply;
  };
}
