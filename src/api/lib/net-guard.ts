import type { FastifyInstance } from "fastify";
import type { Env } from "../../lib/env.js";
import { ForbiddenHostError, ForbiddenOriginError } from "../../utils/errors.js";

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const WILDCARD_BINDS = new Set(["0.0.0.0", "::", "[::]"]);
const VITE_DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

export interface NetGuard {
  isAllowedHost(hostHeader: string): boolean;
  /** True for an origin named in config. Same-origin needs no listing. */
  isListedOrigin(origin: string): boolean;
  isAllowedOrigin(origin: string, hostHeader: string): boolean;
}

function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim().toLowerCase().replace(/\/+$/, ""))
    .filter(Boolean);
}

/** Hostname of a Host header, keeping the brackets of an IPv6 literal. */
function hostnameOf(hostHeader: string): string {
  const host = hostHeader.trim().toLowerCase();
  if (host.startsWith("[")) {
    return host.slice(0, host.indexOf("]") + 1);
  }
  return host.split(":")[0] ?? host;
}

function bindAddress(host: string): string | null {
  const normalized = host.trim().toLowerCase();
  if (!normalized || WILDCARD_BINDS.has(normalized)) return null;
  return normalized.includes(":") && !normalized.startsWith("[")
    ? `[${normalized}]`
    : normalized;
}

export function createNetGuard(
  env: Pick<Env, "HOST" | "ALLOWED_HOSTS" | "ALLOWED_ORIGINS" | "NODE_ENV">,
): NetGuard {
  const listedHosts = parseList(env.ALLOWED_HOSTS);
  const listedOrigins = parseList(env.ALLOWED_ORIGINS);
  const anyHost = listedHosts.includes("*");
  const anyOrigin = listedOrigins.includes("*");

  const hosts = new Set([...LOOPBACK_HOSTS, ...listedHosts]);
  const bound = bindAddress(env.HOST);
  if (bound) hosts.add(bound);

  const origins = new Set(listedOrigins);
  if (env.NODE_ENV === "development") {
    for (const origin of VITE_DEV_ORIGINS) origins.add(origin);
  }

  const isListedOrigin = (origin: string): boolean =>
    anyOrigin || origins.has(origin.toLowerCase().replace(/\/+$/, ""));

  return {
    isAllowedHost: (hostHeader) =>
      anyHost || hosts.has(hostnameOf(hostHeader)),

    isListedOrigin,

    isAllowedOrigin(origin, hostHeader) {
      if (isListedOrigin(origin)) return true;
      try {
        return new URL(origin).host === hostHeader.trim().toLowerCase();
      } catch {
        // "null" (sandboxed frames, file://) and malformed values land here.
        return false;
      }
    },
  };
}

/**
 * Reject requests from outside the trust boundary, on every route: REST, /mcp
 * and the static UI. Host blocks DNS rebinding, where a hostile name resolves
 * to this machine. Origin blocks other sites, including the "simple" POSTs that
 * CORS never preflights. Requests with no Origin are not from a browser page.
 */
export function registerNetGuard(app: FastifyInstance, guard: NetGuard): void {
  app.addHook("onRequest", async (request) => {
    const host = request.headers.host ?? "";
    if (!guard.isAllowedHost(host)) {
      throw new ForbiddenHostError(host);
    }

    const origin = request.headers.origin;
    if (origin !== undefined && !guard.isAllowedOrigin(origin, host)) {
      throw new ForbiddenOriginError(origin);
    }
  });
}
