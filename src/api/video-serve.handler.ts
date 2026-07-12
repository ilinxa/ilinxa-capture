import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { JobManager } from "../core/job-manager.js";
import type { Storage } from "../core/storage.js";
import { ValidationError, FileNotFoundError } from "../utils/errors.js";
import type { JobIdParams } from "./schemas.js";

const MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
};

export function createVideoServeHandler(
  jobManager: JobManager,
  storage: Storage,
) {
  return async function videoServeHandler(
    request: FastifyRequest<{ Params: JobIdParams }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { id: jobId } = request.params;

    const job = jobManager.getJob(jobId);
    if (job.status !== "completed") {
      throw new ValidationError(
        `Job '${jobId}' is not completed (status: ${job.status})`,
      );
    }

    const videoDir = join(storage.getJobDir(jobId), "video");
    let entries: string[];
    try {
      entries = await readdir(videoDir);
    } catch {
      throw new FileNotFoundError("video/*", jobId);
    }

    if (entries.length === 0) {
      throw new FileNotFoundError("video/*", jobId);
    }

    const videoFile = entries[0]!;
    const filePath = join(videoDir, videoFile);
    const fileStat = await stat(filePath);

    const ext = extname(videoFile).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    // Use reply.hijack() to bypass Fastify response handling for large file streaming
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": fileStat.size,
      "Content-Disposition": `attachment; filename="${encodeURIComponent(videoFile)}"`,
    });
    createReadStream(filePath).pipe(reply.raw);
  };
}
