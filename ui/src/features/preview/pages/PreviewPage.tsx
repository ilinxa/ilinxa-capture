import { useEffect, useRef, useState } from "react";

import { AlertCircle, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useJobPolling } from "@/hooks/useJobPolling";
import { jobKeys } from "@/lib/query-keys";
import { useExtractionResult, useWorkflowActions } from "@/stores/workflowStore";
import {
  type ComposeJobPollResponse,
  type ComposeResponse,
  type JobPollFailed,
} from "@/types/api";

import { useCompose } from "../api/composeMutations";
import { CompositionConfig } from "../components/CompositionConfig";
import { FrameGallery } from "../components/FrameGallery";
import { type GridMode } from "../types";

export function PreviewPage() {
  const extractionResult = useExtractionResult();
  const { setCompositionResult } = useWorkflowActions();
  const queryClient = useQueryClient();

  // Compose config state
  const [mode, setMode] = useState<GridMode>(4);
  const [overlayFrameNumber, setOverlayFrameNumber] = useState(false);
  const [overlayTimestamp, setOverlayTimestamp] = useState(false);
  const [fps, setFps] = useState(extractionResult?.source_metadata.fps ?? 24);

  // Async job polling
  const [pendingJobId, setPendingJobId] = useState<string | null>(null);

  // Mutations & polling
  const composeMutation = useCompose();
  const jobPoll = useJobPolling<ComposeJobPollResponse>(pendingJobId);

  // Derived state
  const pollStatus = pendingJobId ? (jobPoll.data?.status ?? null) : null;
  const isComposing =
    composeMutation.isPending ||
    (!!pendingJobId && pollStatus !== "completed" && pollStatus !== "failed");

  // Advance to step 3 when compose job completes — ref guards against double-fire
  const advancedJobRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingJobId || !jobPoll.data) return;
    if (advancedJobRef.current === pendingJobId) return;
    if (jobPoll.data.status === "completed") {
      advancedJobRef.current = pendingJobId;
      setCompositionResult(jobPoll.data as ComposeResponse);
      queryClient.removeQueries({ queryKey: jobKeys.detail(pendingJobId) });
    }
  }, [pendingJobId, jobPoll.data, setCompositionResult, queryClient]);

  function handleCompose() {
    if (!extractionResult) return;
    composeMutation.reset();
    setPendingJobId(null);
    advancedJobRef.current = null;
    composeMutation.mutate(
      {
        jobId: extractionResult.job_id,
        mode,
        overlayFrameNumber,
        overlayTimestamp,
        fps,
      },
      {
        onSuccess: (result) => {
          if (result.status === "completed") {
            setCompositionResult(result);
          } else if (result.status === "pending") {
            setPendingJobId(result.job_id);
          }
        },
      },
    );
  }

  // Collect errors
  const errorMessage =
    composeMutation.error?.message ??
    (pollStatus === "failed"
      ? ((jobPoll.data as JobPollFailed).error ?? "Composition failed")
      : null) ??
    jobPoll.error?.message ??
    null;

  if (!extractionResult) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          No extraction result available. Please extract frames first.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Step 2 — Preview & Compose</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <FrameGallery
          urls={extractionResult.frames.urls}
          count={extractionResult.frames.count}
        />

        <Separator />

        <CompositionConfig
          mode={mode}
          overlayFrameNumber={overlayFrameNumber}
          overlayTimestamp={overlayTimestamp}
          fps={fps}
          onModeChange={setMode}
          onOverlayFrameNumberChange={setOverlayFrameNumber}
          onOverlayTimestampChange={setOverlayTimestamp}
          onFpsChange={setFps}
          disabled={isComposing}
        />

        {errorMessage && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Composition Failed</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}

        <div className="flex items-center gap-4">
          <Button onClick={handleCompose} disabled={isComposing} size="lg">
            {isComposing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isComposing ? "Composing Sheets…" : "Compose Sheets"}
          </Button>
          {isComposing && pendingJobId && (
            <p className="text-sm text-muted-foreground">
              Processing job {pendingJobId.slice(0, 8)}…
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
