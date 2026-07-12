import { useMutation } from "@tanstack/react-query";

import { apiClient, type ApiError } from "@/lib/api-client";
import { type ComposeResponse, type AsyncJobResponse } from "@/types/api";

import { type ComposeFormData } from "../types";

export function useCompose() {
  return useMutation<ComposeResponse | AsyncJobResponse, ApiError, ComposeFormData>({
    mutationFn: (data) =>
      apiClient.post<ComposeResponse | AsyncJobResponse>("/compose", {
        job_id: data.jobId,
        mode: data.mode,
        overlay_frame_number: data.overlayFrameNumber,
        overlay_timestamp: data.overlayTimestamp,
        ...(data.overlayTimestamp && { fps: data.fps }),
      }),
  });
}
