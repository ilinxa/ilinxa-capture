import type { FastifyReply, FastifyRequest } from "fastify";
import { discoverHlsUrls } from "../core/hls.js";
import { hlsDiscoverRequestSchema } from "./schemas.js";
import { parseBody } from "./lib/validate.js";

export function createHlsDiscoverHandler() {
  return async function hlsDiscoverHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const { url, headers } = parseBody(hlsDiscoverRequestSchema, request.body);
    const result = await discoverHlsUrls(url, headers);
    void reply.code(200).send(result);
  };
}
