import { unlink } from "node:fs/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { CaptureService } from "../core/service.js";
import { metadataRequestSchema } from "./schemas.js";
import type { MetadataResponse } from "./schemas.js";
import { readVideoRequest } from "./lib/upload.js";
import { parseBody } from "./lib/validate.js";

export function createMetadataHandler(service: CaptureService) {
  return async function metadataHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (request.isMultipart()) {
      const { uploadPath } = await readVideoRequest(request);
      try {
        const metadata = await service.probeFile(uploadPath ?? "");
        void reply.code(200).send(metadata satisfies MetadataResponse);
      } finally {
        if (uploadPath) {
          await unlink(uploadPath).catch(() => {
            // Temp file cleanup is best-effort
          });
        }
      }
      return;
    }

    const { source } = parseBody(metadataRequestSchema, request.body);
    const metadata = await service.probe(source);
    void reply.code(200).send(metadata satisfies MetadataResponse);
  };
}
