import { useEffect, useRef, useState } from "react";

import { AlertCircle, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useJobPolling } from "@/hooks/useJobPolling";
import { MAX_VIDEO_DURATION_SECONDS } from "@/lib/constants";
import { jobKeys } from "@/lib/query-keys";
import { useWorkflowActions } from "@/stores/workflowStore";
import { type ExtractResponse, type JobPollFailed, type JobPollResponse } from "@/types/api";

import { useExtractFrames, useGetMetadata } from "../api/extractionMutations";
import { ExtractionConfig } from "../components/ExtractionConfig";
import { MetadataPreview } from "../components/MetadataPreview";
import { SourceInput } from "../components/SourceInput";
import { VideoDownload } from "../components/VideoDownload";
import { type SourceType } from "../types";

export function ExtractionPage() {
  const { setExtractionResult } = useWorkflowActions();
  const queryClient = useQueryClient();

  // Form state
  const [sourceType, setSourceType] = useState<SourceType>("file");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [fps, setFps] = useState(2);
  const [preset, setPreset] = useState<"llm" | "high" | "custom">("llm");
  const [customWidth, setCustomWidth] = useState(0);
  const [customFormat, setCustomFormat] = useState<"jpeg" | "png">("jpeg");
  const [customQuality, setCustomQuality] = useState(80);

  // Async job polling — pendingJobId stays set after completion; derived state handles UI
  const [pendingJobId, setPendingJobId] = useState<string | null>(null);

  // Mutations & polling
  const metadataMutation = useGetMetadata();
  const extractMutation = useExtractFrames();
  const jobPoll = useJobPolling<JobPollResponse>(pendingJobId);

  // Derived state
  const hasSource = sourceType === "file" ? file !== null : url.trim().length > 0;
  const isTooLong = (metadataMutation.data?.duration ?? 0) > MAX_VIDEO_DURATION_SECONDS;
  const pollStatus = pendingJobId ? (jobPoll.data?.status ?? null) : null;
  const isExtracting =
    extractMutation.isPending ||
    (!!pendingJobId && pollStatus !== "completed" && pollStatus !== "failed");

  // Advance to step 2 when polling completes — ref guards against double-fire.
  // Only calls Zustand action (not React setState), so no cascading render concern.
  const advancedJobRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingJobId || !jobPoll.data) return;
    if (advancedJobRef.current === pendingJobId) return;
    if (jobPoll.data.status === "completed") {
      advancedJobRef.current = pendingJobId;
      setExtractionResult(jobPoll.data as ExtractResponse);
      queryClient.removeQueries({ queryKey: jobKeys.detail(pendingJobId) });
    }
  }, [pendingJobId, jobPoll.data, setExtractionResult, queryClient]);

  function handleCheckMetadata() {
    metadataMutation.mutate({ sourceType, file, url });
  }

  function handleExtract() {
    extractMutation.reset();
    setPendingJobId(null);
    advancedJobRef.current = null;
    extractMutation.mutate(
      { sourceType, file, url, fps, preset, customWidth, customFormat, customQuality },
      {
        onSuccess: (result) => {
          if (result.status === "completed") {
            setExtractionResult(result);
          } else if (result.status === "pending") {
            setPendingJobId(result.job_id);
          }
        },
      },
    );
  }

  // Collect errors from any source
  const errorMessage =
    extractMutation.error?.message ??
    (pollStatus === "failed"
      ? ((jobPoll.data as JobPollFailed).error ?? "Extraction failed")
      : null) ??
    jobPoll.error?.message ??
    null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Step 1 — Extract Frames</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <SourceInput
          sourceType={sourceType}
          file={file}
          url={url}
          onSourceTypeChange={setSourceType}
          onFileChange={setFile}
          onUrlChange={setUrl}
          disabled={isExtracting}
        />

        {hasSource && (
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={handleCheckMetadata}
              disabled={metadataMutation.isPending || isExtracting}
            >
              {metadataMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Check Metadata
            </Button>
            {metadataMutation.error && (
              <p className="text-sm text-destructive">{metadataMutation.error.message}</p>
            )}
          </div>
        )}

        {metadataMutation.data && <MetadataPreview metadata={metadataMutation.data} />}

        {sourceType === "url" && url.trim().length > 0 && (
          <VideoDownload url={url} disabled={isExtracting} />
        )}

        <Separator />

        <ExtractionConfig
          fps={fps}
          preset={preset}
          customWidth={customWidth}
          customFormat={customFormat}
          customQuality={customQuality}
          onFpsChange={setFps}
          onPresetChange={setPreset}
          onCustomWidthChange={setCustomWidth}
          onCustomFormatChange={setCustomFormat}
          onCustomQualityChange={setCustomQuality}
          disabled={isExtracting}
        />

        {errorMessage && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Extraction Failed</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}

        <div className="flex items-center gap-4">
          <Button
            onClick={handleExtract}
            disabled={!hasSource || isTooLong || isExtracting}
            size="lg"
          >
            {isExtracting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isExtracting ? "Extracting Frames…" : "Extract Frames"}
          </Button>
          {isExtracting && pendingJobId && (
            <p className="text-sm text-muted-foreground">
              Processing job {pendingJobId.slice(0, 8)}…
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
