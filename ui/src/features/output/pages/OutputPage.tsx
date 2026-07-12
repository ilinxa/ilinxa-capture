import { Clock } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useCompositionResult } from "@/stores/workflowStore";

import { DownloadActions } from "../components/DownloadActions";
import { SheetsGallery } from "../components/SheetsGallery";

export function OutputPage() {
  const compositionResult = useCompositionResult();

  if (!compositionResult) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          No composition result available. Please compose sheets first.
        </CardContent>
      </Card>
    );
  }

  const { sheets, job_id, processing_time_ms } = compositionResult;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Step 3 — Output</span>
          <span className="flex items-center gap-1.5 text-sm font-normal text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            {(processing_time_ms / 1000).toFixed(1)}s
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <SheetsGallery urls={sheets.urls} count={sheets.count} grid={sheets.grid} />

        <Separator />

        <DownloadActions jobId={job_id} sheetUrls={sheets.urls} />
      </CardContent>
    </Card>
  );
}
