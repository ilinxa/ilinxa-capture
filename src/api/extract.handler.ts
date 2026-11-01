import { unlink } from "node:fs/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { CaptureService, SourceInput } from "../core/service.js";
import { extractRequestSchema } from "./schemas.js";
import { sendSubmission } from "./lib/respond.js";
import { readVideoRequest } from "./lib/upload.js";
import { parseBody } from "./lib/validate.js";

export function createExtractHandler(service: CaptureService) {
  return async function extractHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const { fields, uploadPath } = await readVideoRequest(request);

    try {
      const parsed = parseBody(extractRequestSchema, fields);
      const source: SourceInput = uploadPath
        ? { kind: "upload", path: uploadPath }
        : await service.resolveSource(parsed.source);

      sendSubmission(
        reply,
        await service.extract(source, parsed, {
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
