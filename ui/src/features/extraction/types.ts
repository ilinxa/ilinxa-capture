export type SourceType = "file" | "url";

export interface ExtractionFormData {
  sourceType: SourceType;
  file: File | null;
  url: string;
  fps: number;
  preset: "llm" | "high" | "custom";
  customWidth: number;
  customFormat: "jpeg" | "png";
  customQuality: number;
}
