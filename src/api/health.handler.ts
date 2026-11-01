import { z } from "zod";
import type { FastifyReply, FastifyRequest } from "fastify";
import { VERSION } from "../version.js";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  version: z.string(),
  uptime: z.number(),
  environment: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export async function healthCheckHandler(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const response: HealthResponse = {
    status: "ok",
    version: VERSION,
    uptime: process.uptime(),
    environment: process.env["NODE_ENV"] ?? "development",
  };

  void reply.code(200).send(response);
}
