import { lazy, Suspense } from "react";

import { RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { LoadingSkeleton } from "@/components/common/LoadingSkeleton";
import { ThemeToggle } from "@/components/common/ThemeToggle";
import {
  useCurrentStep,
  useExtractionResult,
  useCompositionResult,
  useWorkflowActions,
} from "@/stores/workflowStore";
import { cn } from "@/lib/utils";

const ExtractionPage = lazy(() =>
  import("@/features/extraction/pages/ExtractionPage").then((m) => ({
    default: m.ExtractionPage,
  })),
);
const PreviewPage = lazy(() =>
  import("@/features/preview/pages/PreviewPage").then((m) => ({ default: m.PreviewPage })),
);
const OutputPage = lazy(() =>
  import("@/features/output/pages/OutputPage").then((m) => ({ default: m.OutputPage })),
);

const STEPS = [
  { number: 1 as const, label: "Extract" },
  { number: 2 as const, label: "Preview & Compose" },
  { number: 3 as const, label: "Output" },
];

export function StepLayout() {
  const currentStep = useCurrentStep();
  const extractionResult = useExtractionResult();
  const compositionResult = useCompositionResult();
  const { goToStep, reset } = useWorkflowActions();

  function canNavigateTo(step: 1 | 2 | 3): boolean {
    if (step === 1) return true;
    if (step === 2) return extractionResult !== null;
    if (step === 3) return compositionResult !== null;
    return false;
  }

  function handleStepClick(step: 1 | 2 | 3) {
    if (canNavigateTo(step)) {
      goToStep(step);
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
          <h1 className="flex items-center gap-2 font-display text-2xl">
            ilinxa capture
            <span className="inline-block h-2 w-2 rounded-full bg-brand" aria-hidden="true" />
          </h1>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button variant="ghost" size="sm" onClick={reset}>
              <RotateCcw className="mr-2 h-4 w-4" />
              Start Over
            </Button>
          </div>
        </div>
      </header>

      <nav className="border-b bg-background">
        <div className="mx-auto flex max-w-5xl items-center gap-1 px-6 py-3">
          {STEPS.map((step, index) => {
            const isActive = currentStep === step.number;
            const isCompleted = currentStep > step.number;
            const isEnabled = canNavigateTo(step.number);

            return (
              <div key={step.number} className="flex items-center">
                {index > 0 && <Separator className="mx-3 w-8" />}
                <button
                  onClick={() => handleStepClick(step.number)}
                  disabled={!isEnabled}
                  className={cn(
                    "flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
                    isActive && "bg-brand text-brand-foreground",
                    isCompleted && "text-brand hover:bg-accent",
                    !isActive && !isCompleted && isEnabled && "text-muted-foreground hover:bg-accent",
                    !isEnabled && "cursor-not-allowed text-muted-foreground/50",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold",
                      isActive && "bg-brand-foreground text-brand",
                      isCompleted && "bg-brand text-brand-foreground",
                      !isActive && !isCompleted && "bg-muted text-muted-foreground",
                    )}
                  >
                    {isCompleted ? "\u2713" : step.number}
                  </span>
                  {step.label}
                </button>
              </div>
            );
          })}
        </div>
      </nav>

      <main className="flex-1">
        <div className="mx-auto max-w-5xl px-6 py-8">
          <ErrorBoundary>
            <Suspense fallback={<LoadingSkeleton />}>
              {currentStep === 1 && <ExtractionPage />}
              {currentStep === 2 && <PreviewPage />}
              {currentStep === 3 && <OutputPage />}
            </Suspense>
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
