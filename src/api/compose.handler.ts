import type { FastifyReply, FastifyRequest } from "fastify";
import type { CaptureService } from "../core/service.js";
import { ValidationError } from "../utils/errors.js";
import { composeRequestSchema } from "./schemas.js";
import { clientGone, sendSubmission } from "./lib/respond.js";
import { parseBody } from "./lib/validate.js";

export function createComposeHandler(service: CaptureService) {
  return async function composeHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const body = request.body as Record<string, unknown> | null;
    if (!body) {
      throw new ValidationError("Request body is required");
    }

    const parsed = parseBody(composeRequestSchema, body);

    sendSubmission(
      reply,
      await service.compose(parsed, {
        async: parsed.async,
        webhookUrl: parsed.webhook_url,
        signal: parsed.async ? undefined : clientGone(reply),
      }),
    );
  };
}
