import { z } from "zod";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../lib/env.js";
import { VERSION } from "../version.js";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  version: z.string(),
  uptime: z.number(),
  environment: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export function createHealthHandler(env: Pick<Env, "NODE_ENV">) {
  return async function healthCheckHandler(
    _request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const response: HealthResponse = {
      status: "ok",
      version: VERSION,
      uptime: process.uptime(),
      environment: env.NODE_ENV,
    };

    void reply.code(200).send(response);
  };
}
