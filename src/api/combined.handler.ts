import { unlink } from "node:fs/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { CaptureService, SourceInput } from "../core/service.js";
import { combinedRequestSchema } from "./schemas.js";
import { sendSubmission } from "./lib/respond.js";
import { readVideoRequest } from "./lib/upload.js";
import { parseBody } from "./lib/validate.js";

export function createCombinedHandler(service: CaptureService) {
  return async function combinedHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const { fields, uploadPath } = await readVideoRequest(request);

    try {
      const parsed = parseBody(combinedRequestSchema, fields);
      const source: SourceInput = uploadPath
        ? { kind: "upload", path: uploadPath }
        : await service.resolveSource(parsed.source);

      sendSubmission(
        reply,
        await service.extractAndCompose(source, parsed, {
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
