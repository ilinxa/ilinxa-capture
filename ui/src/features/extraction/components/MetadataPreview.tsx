import { AlertTriangle, Clock, Film, Monitor, FileVideo } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { MAX_VIDEO_DURATION_SECONDS } from "@/lib/constants";

import { type MetadataResponse } from "@/types/api";

interface MetadataPreviewProps {
  metadata: MetadataResponse;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function MetadataPreview({ metadata }: MetadataPreviewProps) {
  const isTooLong = metadata.duration > MAX_VIDEO_DURATION_SECONDS;

  return (
    <Card>
      <CardContent className="pt-4">
        {isTooLong && (
          <div className="mb-3 flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Video exceeds the 10-minute limit ({formatDuration(metadata.duration)}). Extraction will
            fail.
          </div>
        )}
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">Duration</span>
            <span className="ml-auto font-medium">{formatDuration(metadata.duration)}</span>
          </div>
          <div className="flex items-center gap-2">
            <Monitor className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">Resolution</span>
            <span className="ml-auto font-medium">
              {metadata.width} x {metadata.height}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Film className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">FPS</span>
            <span className="ml-auto font-medium">{metadata.fps.toFixed(1)}</span>
          </div>
          <div className="flex items-center gap-2">
            <FileVideo className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">Codec</span>
            <span className="ml-auto font-medium">{metadata.codec}</span>
          </div>
          <div className="flex items-center gap-2">
            <FileVideo className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">Size</span>
            <span className="ml-auto font-medium">{formatFileSize(metadata.size_bytes)}</span>
          </div>
          <div className="flex items-center gap-2">
            <FileVideo className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">Format</span>
            <Badge variant="secondary" className="ml-auto">
              {metadata.format}
            </Badge>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
