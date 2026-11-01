import type { FastifyReply, FastifyRequest } from "fastify";
import type { CaptureService } from "../core/service.js";
import { ValidationError } from "../utils/errors.js";
import { videoDownloadRequestSchema } from "./schemas.js";
import { clientGone, sendSubmission } from "./lib/respond.js";
import { parseBody } from "./lib/validate.js";

export function createVideoDownloadHandler(service: CaptureService) {
  return async function videoDownloadHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const body = request.body as Record<string, unknown> | null;
    if (!body?.["url"]) {
      throw new ValidationError("Missing 'url' field");
    }

    const parsed = parseBody(videoDownloadRequestSchema, body);

    sendSubmission(
      reply,
      await service.downloadVideo(parsed, {
        async: parsed.async,
        webhookUrl: parsed.webhook_url,
        signal: parsed.async ? undefined : clientGone(reply),
      }),
    );
  };
}
