import { z } from "zod";
import type { FastifyReply, FastifyRequest } from "fastify";

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
    version: "0.1.1",
    uptime: process.uptime(),
    environment: process.env["NODE_ENV"] ?? "development",
  };

  void reply.code(200).send(response);
}
