import { useMutation } from "@tanstack/react-query";

import { apiClient, type ApiError } from "@/lib/api-client";

import { type ExtractResponse, type AsyncJobResponse, type MetadataResponse } from "@/types/api";

import { type ExtractionFormData } from "../types";

function buildExtractFormData(data: ExtractionFormData): FormData {
  const formData = new FormData();
  if (data.file) {
    formData.append("file", data.file);
  }
  formData.append("fps", String(data.fps));
  formData.append("preset", data.preset);
  if (data.preset === "custom") {
    if (data.customWidth > 0) {
      formData.append("width", String(data.customWidth));
    }
    formData.append("format", data.customFormat);
    formData.append("quality", String(data.customQuality));
  }
  return formData;
}

export function useExtractFrames() {
  return useMutation<ExtractResponse | AsyncJobResponse, ApiError, ExtractionFormData>({
    mutationFn: async (data) => {
      if (data.sourceType === "file" && data.file) {
        const formData = buildExtractFormData(data);
        return apiClient.postMultipart<ExtractResponse | AsyncJobResponse>("/extract", formData);
      }
      return apiClient.post<ExtractResponse | AsyncJobResponse>("/extract", {
        source: data.url,
        fps: data.fps,
        preset: data.preset,
        ...(data.preset === "custom" && {
          ...(data.customWidth > 0 && { width: data.customWidth }),
          format: data.customFormat,
          quality: data.customQuality,
        }),
      });
    },
  });
}

interface MetadataInput {
  sourceType: "file" | "url";
  file: File | null;
  url: string;
}

export function useGetMetadata() {
  return useMutation<MetadataResponse, ApiError, MetadataInput>({
    mutationFn: async (input) => {
      if (input.sourceType === "file" && input.file) {
        const formData = new FormData();
        formData.append("file", input.file);
        return apiClient.postMultipart<MetadataResponse>("/metadata", formData);
      }
      return apiClient.post<MetadataResponse>("/metadata", { source: input.url });
    },
  });
}
