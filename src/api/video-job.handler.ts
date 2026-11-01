import { unlink } from "node:fs/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodType } from "zod";
import type { RunOptions, SourceInput, Submission } from "../core/service.js";
import type { CaptureService } from "../core/service.js";
import { sendSubmission } from "./lib/respond.js";
import { readVideoRequest } from "./lib/upload.js";
import { parseBody } from "./lib/validate.js";

interface VideoJobRequest {
  source: string;
  async: boolean;
  webhook_url?: string | undefined;
}

/**
 * The handler for every job that starts from a video: read the request (JSON or
 * upload), check it, hand it to the service. An upload belongs to the job once
 * submitted, and the job removes it; this removes it only if submitting failed.
 * Removing it twice is harmless.
 */
export function createVideoJobHandler<T extends VideoJobRequest, R>(
  service: CaptureService,
  schema: ZodType<T>,
  submit: (
    source: SourceInput,
    options: T,
    run: RunOptions,
  ) => Promise<Submission<R>>,
) {
  return async function videoJobHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const { fields, uploadPath } = await readVideoRequest(request);

    try {
      const parsed = parseBody(schema, fields);
      const source: SourceInput = uploadPath
        ? { kind: "upload", path: uploadPath }
        : await service.resolveSource(parsed.source);

      sendSubmission(
        reply,
        await submit(source, parsed, {
          async: parsed.async,
          webhookUrl: parsed.webhook_url,
        }),
      );
    } catch (err) {
      if (uploadPath) {
        await unlink(uploadPath).catch(() => {
          // Temp file cleanup is best-effort
        });
      }
      throw err;
    }
  };
}
