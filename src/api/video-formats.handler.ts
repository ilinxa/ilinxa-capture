import type { FastifyReply, FastifyRequest } from "fastify";
import { listVideoFormats } from "../core/downloader.js";
import { videoFormatsRequestSchema } from "./schemas.js";
import { parseBody } from "./lib/validate.js";

export function createVideoFormatsHandler() {
  return async function videoFormatsHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const { url, headers } = parseBody(videoFormatsRequestSchema, request.body);
    const info = await listVideoFormats(url, headers);
    void reply.code(200).send(info);
  };
}
