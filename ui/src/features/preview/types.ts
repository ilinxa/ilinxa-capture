export type GridMode = 1 | 4 | 16;

export interface ComposeFormData {
  jobId: string;
  mode: GridMode;
  overlayFrameNumber: boolean;
  overlayTimestamp: boolean;
  fps: number;
}
