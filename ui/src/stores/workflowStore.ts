import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { type ExtractResponse, type ComposeResponse } from "@/types/api";

type Step = 1 | 2 | 3;

interface WorkflowState {
  currentStep: Step;
  extractionResult: ExtractResponse | null;
  compositionResult: ComposeResponse | null;
}

interface WorkflowActions {
  goToStep: (step: Step) => void;
  setExtractionResult: (result: ExtractResponse) => void;
  setCompositionResult: (result: ComposeResponse) => void;
  reset: () => void;
}

const initialState: WorkflowState = {
  currentStep: 1,
  extractionResult: null,
  compositionResult: null,
};

const useWorkflowStoreBase = create<WorkflowState & WorkflowActions>()((set) => ({
  ...initialState,
  goToStep: (step) => set({ currentStep: step }),
  setExtractionResult: (result) => set({ extractionResult: result, currentStep: 2 }),
  setCompositionResult: (result) => set({ compositionResult: result, currentStep: 3 }),
  reset: () => set(initialState),
}));

export const useCurrentStep = () => useWorkflowStoreBase((s) => s.currentStep);
export const useExtractionResult = () => useWorkflowStoreBase((s) => s.extractionResult);
export const useCompositionResult = () => useWorkflowStoreBase((s) => s.compositionResult);
export const useWorkflowActions = () =>
  useWorkflowStoreBase(
    useShallow((s) => ({
      goToStep: s.goToStep,
      setExtractionResult: s.setExtractionResult,
      setCompositionResult: s.setCompositionResult,
      reset: s.reset,
    })),
  );
