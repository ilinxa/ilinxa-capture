import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  useCompositionResult,
  useCurrentStep,
  useExtractionResult,
  useWorkflowActions,
} from "@/stores/workflowStore";
import type { ComposeResponse, ExtractResponse } from "@/types/api";

const extractionResult: ExtractResponse = {
  job_id: "job-1",
  status: "completed",
  frames: { count: 4, files: ["a.jpg"], urls: ["/a.jpg"] },
  source_metadata: { duration: 10, width: 1920, height: 1080, fps: 30 },
  processing_time_ms: 123,
};

const compositionResult: ComposeResponse = {
  job_id: "job-1",
  status: "completed",
  sheets: { count: 1, mode: 4, grid: "2x2", files: ["sheet.jpg"], urls: ["/sheet.jpg"] },
  processing_time_ms: 456,
};

function renderStore() {
  return renderHook(() => ({
    currentStep: useCurrentStep(),
    extractionResult: useExtractionResult(),
    compositionResult: useCompositionResult(),
    actions: useWorkflowActions(),
  }));
}

describe("workflowStore", () => {
  beforeEach(() => {
    const { result } = renderStore();
    act(() => result.current.actions.reset());
  });

  it("goToStep updates currentStep", () => {
    const { result } = renderStore();

    act(() => result.current.actions.goToStep(3));

    expect(result.current.currentStep).toBe(3);
  });

  it("setExtractionResult stores the result and advances to step 2", () => {
    const { result } = renderStore();

    act(() => result.current.actions.setExtractionResult(extractionResult));

    expect(result.current.extractionResult).toEqual(extractionResult);
    expect(result.current.currentStep).toBe(2);
  });

  it("setCompositionResult stores the result and advances to step 3", () => {
    const { result } = renderStore();

    act(() => result.current.actions.setCompositionResult(compositionResult));

    expect(result.current.compositionResult).toEqual(compositionResult);
    expect(result.current.currentStep).toBe(3);
  });

  it("reset returns to initial state", () => {
    const { result } = renderStore();

    act(() => {
      result.current.actions.setExtractionResult(extractionResult);
      result.current.actions.setCompositionResult(compositionResult);
    });
    act(() => result.current.actions.reset());

    expect(result.current.currentStep).toBe(1);
    expect(result.current.extractionResult).toBeNull();
    expect(result.current.compositionResult).toBeNull();
  });
});
