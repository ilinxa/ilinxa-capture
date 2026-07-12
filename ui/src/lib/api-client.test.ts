import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient, ApiError } from "@/lib/api-client";

function jsonResponse(body: unknown, init: { status?: number; statusText?: string } = {}) {
  return {
    ok: (init.status ?? 200) < 300,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    json: () => Promise.resolve(body),
  } as Response;
}

describe("apiClient", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns parsed JSON body on an ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ hello: "world" }));

    const result = await apiClient.get<{ hello: string }>("/things");

    expect(result).toEqual({ hello: "world" });
    expect(fetch).toHaveBeenCalledWith("/api/v1/things", {});
  });

  it("throws ApiError with status/message/code on a non-ok JSON error body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        { error: { message: "Job not found", code: "JOB_NOT_FOUND" } },
        { status: 404, statusText: "Not Found" },
      ),
    );

    await expect(apiClient.get("/jobs/missing")).rejects.toMatchObject({
      status: 404,
      message: "Job not found",
      code: "JOB_NOT_FOUND",
    });
  });

  it("falls back to statusText when the error body is not JSON", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: () => Promise.reject(new Error("not json")),
    } as Response);

    await expect(apiClient.get("/boom")).rejects.toMatchObject({
      status: 500,
      message: "Internal Server Error",
      code: undefined,
    });
  });

  describe("ApiError helpers", () => {
    it("isNotFound is true for 404", () => {
      const error = new ApiError(404, "not found");
      expect(error.isNotFound).toBe(true);
      expect(error.isValidation).toBe(false);
      expect(error.isServerError).toBe(false);
    });

    it("isValidation is true for 400", () => {
      const error = new ApiError(400, "bad request");
      expect(error.isValidation).toBe(true);
      expect(error.isNotFound).toBe(false);
      expect(error.isServerError).toBe(false);
    });

    it("isServerError is true for 500", () => {
      const error = new ApiError(500, "server error");
      expect(error.isServerError).toBe(true);
      expect(error.isNotFound).toBe(false);
      expect(error.isValidation).toBe(false);
    });
  });
});
