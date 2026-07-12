export type PresetName = "llm" | "high" | "custom";
export type ImageFormat = "jpeg" | "png";

export interface ResolvedPreset {
  width: number | null;
  format: ImageFormat;
  quality: number | null;
}

export interface CustomPresetOptions {
  width?: number;
  format?: ImageFormat;
  quality?: number;
}

export function resolvePreset(
  preset: PresetName,
  custom?: CustomPresetOptions,
): ResolvedPreset {
  switch (preset) {
    case "llm":
      return { width: 1024, format: "jpeg", quality: 80 };
    case "high":
      return { width: null, format: "png", quality: null };
    case "custom":
      return {
        width: custom?.width ?? null,
        format: custom?.format ?? "jpeg",
        quality: custom?.quality ?? 80,
      };
  }
}

/**
 * Map JPEG quality (1-100) to FFmpeg's -q:v scale (2=best, 31=worst).
 */
export function qualityToQscale(quality: number): number {
  return Math.round(2 + ((100 - quality) * 29) / 99);
}
