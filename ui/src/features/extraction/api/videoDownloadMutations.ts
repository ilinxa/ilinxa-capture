import { useMutation } from "@tanstack/react-query";

import { apiClient, type ApiError } from "@/lib/api-client";
import {
  type VideoFormatsResponse,
  type VideoDownloadResponse,
  type AsyncJobResponse,
  type HlsDiscoverResponse,
} from "@/types/api";

export type VideoDownloadPreset = "best" | "1080p" | "720p" | "480p" | "360p" | "audio_only";

export interface VideoDownloadInput {
  url: string;
  preset?: VideoDownloadPreset;
  format_selector?: string;
  merge_format?: "mp4" | "webm" | "mkv" | "mp3";
  headers?: Record<string, string>;
}

export function useListVideoFormats() {
  return useMutation<
    VideoFormatsResponse,
    ApiError,
    { url: string; headers?: Record<string, string> }
  >({
    mutationFn: (data) => apiClient.post<VideoFormatsResponse>("/video/formats", data),
  });
}

export function useDownloadVideo() {
  return useMutation<VideoDownloadResponse | AsyncJobResponse, ApiError, VideoDownloadInput>({
    mutationFn: (data) =>
      apiClient.post<VideoDownloadResponse | AsyncJobResponse>("/video/download", data),
  });
}

export function useDiscoverHls() {
  return useMutation<
    HlsDiscoverResponse,
    ApiError,
    { url: string; headers?: Record<string, string> }
  >({
    mutationFn: (data) => apiClient.post<HlsDiscoverResponse>("/hls/discover", data),
  });
}
