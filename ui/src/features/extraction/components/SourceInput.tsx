import { useCallback, useRef, useState } from "react";

import { Upload, Link, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { type SourceType } from "../types";

interface SourceInputProps {
  sourceType: SourceType;
  file: File | null;
  url: string;
  onSourceTypeChange: (type: SourceType) => void;
  onFileChange: (file: File | null) => void;
  onUrlChange: (url: string) => void;
  disabled?: boolean;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SourceInput({
  sourceType,
  file,
  url,
  onSourceTypeChange,
  onFileChange,
  onUrlChange,
  disabled,
}: SourceInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (!disabled) setIsDragging(true);
    },
    [disabled],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (disabled) return;
      const droppedFile = e.dataTransfer.files[0];
      if (droppedFile?.type.startsWith("video/")) {
        onFileChange(droppedFile);
      }
    },
    [disabled, onFileChange],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = e.target.files?.[0] ?? null;
      onFileChange(selected);
    },
    [onFileChange],
  );

  return (
    <div className="space-y-3">
      <Label className="text-sm font-medium">Video Source</Label>
      <Tabs
        value={sourceType}
        onValueChange={(v) => onSourceTypeChange(v as SourceType)}
      >
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="file" disabled={disabled}>
            <Upload className="mr-2 h-4 w-4" />
            Upload File
          </TabsTrigger>
          <TabsTrigger value="url" disabled={disabled}>
            <Link className="mr-2 h-4 w-4" />
            Paste URL
          </TabsTrigger>
        </TabsList>

        <TabsContent value="file" className="mt-3">
          {file ? (
            <div className="flex items-center justify-between rounded-md border bg-muted/50 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onFileChange(null)}
                disabled={disabled}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => !disabled && fileInputRef.current?.click()}
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed px-6 py-10 transition-colors",
                isDragging && "border-primary bg-primary/5",
                !isDragging && "border-muted-foreground/25 hover:border-muted-foreground/50",
                disabled && "cursor-not-allowed opacity-50",
              )}
            >
              <Upload className="mb-3 h-8 w-8 text-muted-foreground" />
              <p className="text-sm font-medium">Drop a video file here or click to browse</p>
              <p className="mt-1 text-xs text-muted-foreground">Max 500 MB, up to 10 minutes</p>
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                onChange={handleFileSelect}
                className="hidden"
                disabled={disabled}
              />
            </div>
          )}
        </TabsContent>

        <TabsContent value="url" className="mt-3">
          <Input
            type="url"
            placeholder="https://youtube.com/watch?v=..."
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
            disabled={disabled}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            Supports YouTube, Vimeo, and direct video URLs via yt-dlp
          </p>
        </TabsContent>
      </Tabs>
    </div>
  );
}
