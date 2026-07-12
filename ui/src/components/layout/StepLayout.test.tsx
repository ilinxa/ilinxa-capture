import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkflowActions } from "@/stores/workflowStore";
import type { ComposeResponse, ExtractResponse } from "@/types/api";

import { StepLayout } from "./StepLayout";

// Feature pages pull in TanStack Query mutations and real API calls — mock them so
// this suite stays focused on StepLayout's own step-guard/navigation behavior.
vi.mock("@/features/extraction/pages/ExtractionPage", () => ({
  ExtractionPage: () => <h2>Extraction Page Mock</h2>,
}));
vi.mock("@/features/preview/pages/PreviewPage", () => ({
  PreviewPage: () => <h2>Preview Page Mock</h2>,
}));
vi.mock("@/features/output/pages/OutputPage", () => ({
  OutputPage: () => <h2>Output Page Mock</h2>,
}));

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

function resetStore() {
  const { result } = renderHook(() => useWorkflowActions());
  act(() => result.current.reset());
}

describe("StepLayout", () => {
  beforeEach(() => {
    resetStore();
  });

  it("guards steps 2 and 3 when no extraction/composition result exists", async () => {
    const user = userEvent.setup();
    render(<StepLayout />);

    expect(await screen.findByRole("heading", { name: "Extraction Page Mock" })).toBeVisible();

    const step2Button = screen.getByRole("button", { name: /preview & compose/i });
    const step3Button = screen.getByRole("button", { name: /output/i });

    expect(step2Button).toBeDisabled();
    expect(step3Button).toBeDisabled();

    await user.click(step2Button);
    await user.click(step3Button);

    // Clicking disabled step buttons must not change the rendered page.
    expect(screen.getByRole("heading", { name: "Extraction Page Mock" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Preview Page Mock" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Output Page Mock" })).not.toBeInTheDocument();
  });

  it("enables and navigates to step 2 once an extraction result is set", async () => {
    const user = userEvent.setup();
    const { result } = renderHook(() => useWorkflowActions());
    act(() => result.current.setExtractionResult(extractionResult));

    render(<StepLayout />);

    const step2Button = await screen.findByRole("button", { name: /preview & compose/i });
    const step3Button = screen.getByRole("button", { name: /output/i });

    expect(step2Button).toBeEnabled();
    expect(step3Button).toBeDisabled();

    await user.click(step2Button);

    expect(await screen.findByRole("heading", { name: "Preview Page Mock" })).toBeVisible();
  });

  it("enables and navigates to step 3 once a composition result is set", async () => {
    const user = userEvent.setup();
    const { result } = renderHook(() => useWorkflowActions());
    act(() => {
      result.current.setExtractionResult(extractionResult);
      result.current.setCompositionResult(compositionResult);
    });

    render(<StepLayout />);

    const step3Button = await screen.findByRole("button", { name: /output/i });
    expect(step3Button).toBeEnabled();

    await user.click(step3Button);

    expect(await screen.findByRole("heading", { name: "Output Page Mock" })).toBeVisible();
  });

  it("resets to step 1 with disabled steps 2/3 when Start Over is clicked", async () => {
    const user = userEvent.setup();
    const { result } = renderHook(() => useWorkflowActions());
    act(() => {
      result.current.setExtractionResult(extractionResult);
      result.current.setCompositionResult(compositionResult);
    });

    render(<StepLayout />);

    await user.click(screen.getByRole("button", { name: /start over/i }));

    expect(await screen.findByRole("heading", { name: "Extraction Page Mock" })).toBeVisible();
    expect(screen.getByRole("button", { name: /preview & compose/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /output/i })).toBeDisabled();
  });
});
