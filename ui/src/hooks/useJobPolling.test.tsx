import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api-client";

import { useJobPolling } from "./useJobPolling";

vi.mock("@/lib/api-client", () => ({
  apiClient: { get: vi.fn() },
}));

interface JobStatus {
  status: string;
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useJobPolling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not fetch when jobId is null", () => {
    renderHook(() => useJobPolling<JobStatus>(null), { wrapper: createWrapper() });

    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it("fetches when jobId is set", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ status: "processing" });

    renderHook(() => useJobPolling<JobStatus>("job-1"), { wrapper: createWrapper() });

    await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith("/jobs/job-1"));
  });

  it("polls again after 2s while status is processing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(apiClient.get).mockResolvedValue({ status: "processing" });

    renderHook(() => useJobPolling<JobStatus>("job-2"), { wrapper: createWrapper() });

    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(1));

    await act(() => vi.advanceTimersByTimeAsync(2000));

    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(2));
  });

  it("does not poll again once status is completed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(apiClient.get).mockResolvedValue({ status: "completed" });

    renderHook(() => useJobPolling<JobStatus>("job-3"), { wrapper: createWrapper() });

    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(1));

    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it("does not poll again once status is failed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(apiClient.get).mockResolvedValue({ status: "failed" });

    renderHook(() => useJobPolling<JobStatus>("job-4"), { wrapper: createWrapper() });

    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(1));

    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });
});
