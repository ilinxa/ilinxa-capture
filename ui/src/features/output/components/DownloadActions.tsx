import { useState } from "react";

import { AlertCircle, Archive, Download, Loader2 } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

import { downloadFile } from "../utils/downloadFile";

interface DownloadActionsProps {
  jobId: string;
  sheetUrls: string[];
}

export function DownloadActions({ jobId, sheetUrls }: DownloadActionsProps) {
  const [isDownloading, setIsDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleZipDownload(include: "sheets" | "all") {
    setError(null);
    setIsDownloading(include);
    try {
      await downloadFile(
        `/api/v1/jobs/${jobId}/download?include=${include}`,
        `${jobId}-${include}.zip`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setIsDownloading(null);
    }
  }

  return (
    <div className="space-y-3">
      <Label className="text-sm font-medium">Downloads</Label>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => handleZipDownload("sheets")}
          disabled={isDownloading !== null}
        >
          {isDownloading === "sheets" ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Archive className="mr-2 h-4 w-4" />
          )}
          Download Sheets (ZIP)
        </Button>

        <Button
          variant="outline"
          onClick={() => handleZipDownload("all")}
          disabled={isDownloading !== null}
        >
          {isDownloading === "all" ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Archive className="mr-2 h-4 w-4" />
          )}
          Download All (ZIP)
        </Button>
      </div>

      {sheetUrls.length > 1 && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">Individual sheets:</p>
          <div className="flex flex-wrap gap-1.5">
            {sheetUrls.map((url, i) => (
              <a
                key={url}
                href={url}
                download
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-muted"
              >
                <Download className="h-3 w-3" />
                Sheet {i + 1}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
