import { extname } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { JobManager } from "../core/job-manager.js";
import type { Storage } from "../core/storage.js";
import { FileNotFoundError, ValidationError } from "../utils/errors.js";

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".json": "application/json",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
};

// Job output only. job.json holds internal state, and the source video has its
// own route. Refusing a leading dot rules out `..` as the final segment.
const SERVABLE_PATH = /^(?:(?:frames|sheets|audio)\/(?!\.)[^/]+|manifest\.json)$/;

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

    if (!SERVABLE_PATH.test(relativePath.replace(/\\/g, "/"))) {
      throw new FileNotFoundError(relativePath, jobId);
    }

    // Check file exists
    const exists = await storage.fileExists(jobId, relativePath);
    if (!exists) {
      throw new FileNotFoundError(relativePath, jobId);
    }

    // Determine MIME type from extension
    const ext = extname(relativePath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    // Audio tracks can run to gigabytes; images are small enough to buffer
    if (relativePath.startsWith("audio/")) {
      const info = await storage.getFileInfo(jobId, relativePath);
      void reply
        .header("content-type", contentType)
        .header("content-length", info.size)
        .send(storage.getFileStream(jobId, relativePath));
      return;
    }

    const buffer = await storage.readFile(jobId, relativePath);

    void reply
      .header("content-type", contentType)
      .header("cache-control", "public, max-age=3600")
      .send(buffer);
  };
}
