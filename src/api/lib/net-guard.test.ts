import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildApp } from "../../app.js";
import { createNetGuard, exposureWarning } from "./net-guard.js";
import { createTestEnv } from "../../test/env.js";
import type { FastifyInstance } from "fastify";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readdir: vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
  };
});

describe("exposureWarning", () => {
  it.each(["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]"])(
    "stays quiet about %s",
    (host) => {
      expect(exposureWarning(host)).toBeNull();
    },
  );

  it.each(["0.0.0.0", "::", "192.168.1.20"])("warns about %s", (host) => {
    expect(exposureWarning(host)).toContain("no login");
  });
});

describe("createNetGuard", () => {
  const guard = createNetGuard({
    HOST: "127.0.0.1",
    ALLOWED_HOSTS: "",
    ALLOWED_ORIGINS: "",
    NODE_ENV: "production",
  });

  it("allows loopback names with any port", () => {
    expect(guard.isAllowedHost("localhost:3000")).toBe(true);
    expect(guard.isAllowedHost("127.0.0.1:3000")).toBe(true);
    expect(guard.isAllowedHost("[::1]:3000")).toBe(true);
    expect(guard.isAllowedHost("LOCALHOST")).toBe(true);
  });

  it("refuses rebound and look-alike hosts", () => {
    expect(guard.isAllowedHost("attacker.example:3000")).toBe(false);
    expect(guard.isAllowedHost("localhost.attacker.example")).toBe(false);
    expect(guard.isAllowedHost("127.0.0.1.nip.io")).toBe(false);
    expect(guard.isAllowedHost("")).toBe(false);
  });

  it("adds a specific bind address but not a wildcard", () => {
    const lan = createNetGuard({
      HOST: "192.168.1.5",
      ALLOWED_HOSTS: "",
      ALLOWED_ORIGINS: "",
      NODE_ENV: "production",
    });
    expect(lan.isAllowedHost("192.168.1.5:3000")).toBe(true);

    const wildcard = createNetGuard({
      HOST: "0.0.0.0",
      ALLOWED_HOSTS: "",
      ALLOWED_ORIGINS: "",
      NODE_ENV: "production",
    });
    expect(wildcard.isAllowedHost("0.0.0.0:3000")).toBe(false);
    expect(wildcard.isAllowedHost("192.168.1.5:3000")).toBe(false);
  });

  it("honors ALLOWED_HOSTS, and * as an explicit opt-out", () => {
    const listed = createNetGuard({
      HOST: "0.0.0.0",
      ALLOWED_HOSTS: "capture.example.com, Other.example",
      ALLOWED_ORIGINS: "",
      NODE_ENV: "production",
    });
    expect(listed.isAllowedHost("capture.example.com")).toBe(true);
    expect(listed.isAllowedHost("other.example:8080")).toBe(true);

    const any = createNetGuard({
      HOST: "0.0.0.0",
      ALLOWED_HOSTS: "*",
      ALLOWED_ORIGINS: "",
      NODE_ENV: "production",
    });
    expect(any.isAllowedHost("anything.example")).toBe(true);
  });

  it("treats only same host and port as same-origin", () => {
    expect(guard.isAllowedOrigin("http://localhost:3000", "localhost:3000")).toBe(true);
    expect(guard.isAllowedOrigin("http://localhost:9999", "localhost:3000")).toBe(false);
    expect(guard.isAllowedOrigin("https://evil.example", "localhost:3000")).toBe(false);
  });

  it("refuses the opaque null origin", () => {
    expect(guard.isAllowedOrigin("null", "localhost:3000")).toBe(false);
  });

  it("allows the Vite dev origin only in development", () => {
    const dev = createNetGuard({
      HOST: "127.0.0.1",
      ALLOWED_HOSTS: "",
      ALLOWED_ORIGINS: "",
      NODE_ENV: "development",
    });
    expect(dev.isListedOrigin("http://localhost:5173")).toBe(true);
    expect(guard.isListedOrigin("http://localhost:5173")).toBe(false);
  });

  it("matches ALLOWED_ORIGINS ignoring case and a trailing slash", () => {
    const listed = createNetGuard({
      HOST: "127.0.0.1",
      ALLOWED_HOSTS: "",
      ALLOWED_ORIGINS: "https://Tools.Example/",
      NODE_ENV: "production",
    });
    expect(listed.isListedOrigin("https://tools.example")).toBe(true);
    expect(listed.isListedOrigin("https://other.example")).toBe(false);
  });
});

describe("guard on the running app", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({ env: createTestEnv(), logger: false });
  });

  const mcpInitialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  };

  it("serves a normal local request with no Origin", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
  });

  it("refuses a rebound Host on REST", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { host: "attacker.example:3000" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN_HOST");
  });

  it("refuses a foreign Origin on a JSON POST", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/compose",
      headers: { origin: "https://evil.example" },
      payload: { frames: ["/x.jpg"], mode: 1 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN_ORIGIN");
  });

  it("refuses a foreign Origin on a multipart POST, which CORS never preflights", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/extract",
      headers: {
        origin: "https://evil.example",
        "content-type": "multipart/form-data; boundary=x",
      },
      payload: "--x--",
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses a preflight from a foreign Origin and sends no CORS grant", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/extract",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses a foreign Origin on /mcp", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        origin: "https://evil.example",
        accept: "application/json, text/event-stream",
      },
      payload: mcpInitialize,
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers["mcp-session-id"]).toBeUndefined();
  });

  it("refuses a rebound Host on /mcp", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: "attacker.example",
        accept: "application/json, text/event-stream",
      },
      payload: mcpInitialize,
    });
    expect(res.statusCode).toBe(403);
  });

  it("grants CORS to a listed origin, without credentials", async () => {
    const listed = await buildApp({
      env: createTestEnv({ ALLOWED_ORIGINS: "https://tools.example" }),
      logger: false,
    });
    const res = await listed.inject({
      method: "OPTIONS",
      url: "/api/v1/extract",
      headers: {
        origin: "https://tools.example",
        "access-control-request-method": "POST",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://tools.example");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});
