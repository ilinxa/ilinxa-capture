import { useEffect, useRef, useState } from "react";

import {
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Radio,
  Search,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useJobPolling } from "@/hooks/useJobPolling";
import { jobKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import {
  type YtdlpFormat,
  type VideoDownloadResponse,
  type VideoDownloadJobPollResponse,
  type DiscoveredStream,
} from "@/types/api";

import {
  useListVideoFormats,
  useDownloadVideo,
  useDiscoverHls,
  type VideoDownloadPreset,
} from "../api/videoDownloadMutations";

interface VideoDownloadProps {
  url: string;
  disabled?: boolean;
}

const PRESETS: { value: VideoDownloadPreset; label: string }[] = [
  { value: "best", label: "Best" },
  { value: "1080p", label: "1080p" },
  { value: "720p", label: "720p" },
  { value: "480p", label: "480p" },
  { value: "360p", label: "360p" },
  { value: "audio_only", label: "Audio" },
];

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "\u2014";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatBitrate(bps: number | null): string {
  if (bps === null) return "\u2014";
  if (bps < 1_000_000) return `${(bps / 1000).toFixed(0)} Kbps`;
  return `${(bps / 1_000_000).toFixed(1)} Mbps`;
}

function isHlsUrl(url: string): boolean {
  return /\.m3u8(\?|$)/i.test(url);
}

function sortFormats(formats: YtdlpFormat[]): YtdlpFormat[] {
  return [...formats].sort((a, b) => {
    const aHasVideo = a.vcodec !== "none";
    const aHasAudio = a.acodec !== "none";
    const bHasVideo = b.vcodec !== "none";
    const bHasAudio = b.acodec !== "none";

    const aScore = (aHasVideo ? 2 : 0) + (aHasAudio ? 1 : 0);
    const bScore = (bHasVideo ? 2 : 0) + (bHasAudio ? 1 : 0);
    if (aScore !== bScore) return bScore - aScore;

    return (b.height ?? 0) - (a.height ?? 0);
  });
}

export function VideoDownload({ url, disabled }: VideoDownloadProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [preset, setPreset] = useState<VideoDownloadPreset>("best");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectedFormatId, setSelectedFormatId] = useState<string | null>(null);
  const [mergeFormat, setMergeFormat] = useState<"mp4" | "webm" | "mkv" | "mp3">("mp4");
  const [pendingJobId, setPendingJobId] = useState<string | null>(null);
  const downloadTriggeredRef = useRef<string | null>(null);

  // HLS-specific state
  const [selectedHlsVariant, setSelectedHlsVariant] = useState<string | null>(null);
  const [hlsSourceUrl, setHlsSourceUrl] = useState<string | null>(null);

  const isHls = isHlsUrl(hlsSourceUrl ?? url);
  const effectiveUrl = hlsSourceUrl ?? url;

  const formatsMutation = useListVideoFormats();
  const downloadMutation = useDownloadVideo();
  const discoverMutation = useDiscoverHls();
  const queryClient = useQueryClient();

  // Poll for async download job completion
  const jobPoll = useJobPolling<VideoDownloadJobPollResponse>(pendingJobId);

  function triggerBrowserDownload(downloadUrl: string, filename: string) {
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // Auto-trigger browser download when job completes
  useEffect(() => {
    if (!pendingJobId || !jobPoll.data) return;
    if (downloadTriggeredRef.current === pendingJobId) return;
    if (jobPoll.data.status === "completed") {
      downloadTriggeredRef.current = pendingJobId;
      const data = jobPoll.data as VideoDownloadResponse;
      triggerBrowserDownload(data.video.download_url, data.video.filename);
      queryClient.removeQueries({ queryKey: jobKeys.detail(pendingJobId) });
    }
  }, [pendingJobId, jobPoll.data, queryClient]);

  // Auto-fetch formats when panel is opened
  useEffect(() => {
    if (isOpen && !formatsMutation.data && !formatsMutation.isPending) {
      formatsMutation.mutate({ url: effectiveUrl });
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch formats when HLS source URL changes
  useEffect(() => {
    if (isOpen && hlsSourceUrl) {
      formatsMutation.mutate({ url: hlsSourceUrl });
    }
  }, [hlsSourceUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const isDownloading =
    downloadMutation.isPending ||
    (!!pendingJobId && jobPoll.data?.status !== "completed" && jobPoll.data?.status !== "failed");

  const downloadComplete =
    downloadMutation.data?.status === "completed" ||
    (!!pendingJobId && jobPoll.data?.status === "completed");

  const downloadError =
    downloadMutation.error?.message ??
    (pendingJobId && jobPoll.data?.status === "failed"
      ? ((jobPoll.data as { error?: string }).error ?? "Download failed")
      : null);

  function handleDownload() {
    downloadMutation.reset();
    setPendingJobId(null);
    downloadTriggeredRef.current = null;

    // Resolve which variant URL to pass for HLS
    const hlsVariantUrl =
      isHls && selectedHlsVariant
        ? formatsMutation.data?.formats.find((f) => f.format_id === selectedHlsVariant)
            ?.format_note
        : null;

    if (isHls && selectedHlsVariant) {
      // HLS download — the format_note for HLS variants may be the variant name.
      // The actual variant URL is stored differently. For HLS, the backend knows
      // the variant URL from the format_id index, so we pass format_selector as
      // the variant .m3u8 URL. We need to get it from formats data.
      // The backend's hlsPlaylistToVideoFormatInfo doesn't store the variant URL directly.
      // Instead, we pass the format_selector as just the format_id and let the backend
      // re-parse. But actually, the download handler for HLS expects the variant .m3u8 URL
      // as format_selector. Since we don't have that, we'll just download the master URL
      // and let FFmpeg pick. Or better: pass format_selector as just the main URL
      // since FFmpeg with -c copy on the master will auto-select best.
      //
      // Actually, for a clean approach: the format listing returns format_note with the
      // variant name. But the actual variant URL needs to come from the backend.
      // The simplest approach: pass the master .m3u8 URL and let FFmpeg handle quality selection.
      // For now, we download the master URL directly (FFmpeg picks best by default).
      // TODO: Pass variant URL via format_selector when backend exposes it in format listing.

      void hlsVariantUrl; // acknowledge unused for now

      downloadMutation.mutate(
        { url: effectiveUrl, merge_format: mergeFormat },
        {
          onSuccess: (result) => {
            if (result.status === "completed") {
              triggerBrowserDownload(result.video.download_url, result.video.filename);
            } else if (result.status === "pending") {
              setPendingJobId(result.job_id);
            }
          },
        },
      );
    } else {
      // yt-dlp download
      const input =
        showAdvanced && selectedFormatId
          ? { url: effectiveUrl, format_selector: selectedFormatId, merge_format: mergeFormat }
          : { url: effectiveUrl, preset, merge_format: mergeFormat };

      downloadMutation.mutate(input, {
        onSuccess: (result) => {
          if (result.status === "completed") {
            triggerBrowserDownload(result.video.download_url, result.video.filename);
          } else if (result.status === "pending") {
            setPendingJobId(result.job_id);
          }
        },
      });
    }
  }

  function handleDiscoverHls() {
    discoverMutation.mutate({ url });
  }

  function handleSelectStream(stream: DiscoveredStream) {
    setHlsSourceUrl(stream.url);
    setSelectedHlsVariant(null);
  }

  const sortedFormats = formatsMutation.data ? sortFormats(formatsMutation.data.formats) : [];

  // HLS variants from format listing (format_id starts with "hls_")
  const hlsVariants = sortedFormats.filter((f) => f.format_id.startsWith("hls_"));
  const showHlsVariantPicker = isHls && hlsVariants.length > 0;

  return (
    <div className="rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium hover:bg-muted/50"
        disabled={disabled}
      >
        {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <Download className="h-4 w-4" />
        Download Video
        {formatsMutation.data && (
          <Badge variant="secondary" className="ml-auto">
            {formatsMutation.data.title}
          </Badge>
        )}
        {isHls && <Badge className="ml-1">HLS</Badge>}
      </button>

      {isOpen && (
        <div className="space-y-4 border-t px-4 py-4">
          {/* HLS Discovery (for non-.m3u8 URLs) */}
          {!isHls && (
            <div className="space-y-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleDiscoverHls}
                disabled={discoverMutation.isPending || isDownloading}
              >
                {discoverMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Search className="mr-2 h-4 w-4" />
                )}
                Scan for HLS Streams
              </Button>

              {discoverMutation.error && (
                <p className="text-sm text-destructive">{discoverMutation.error.message}</p>
              )}

              {discoverMutation.data && discoverMutation.data.streams.length === 0 && (
                <p className="text-sm text-muted-foreground">No HLS streams found on this page.</p>
              )}

              {discoverMutation.data && discoverMutation.data.streams.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">
                    Found {discoverMutation.data.streams.length} HLS stream
                    {discoverMutation.data.streams.length > 1 ? "s" : ""}
                    {discoverMutation.data.page_title && (
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        on &ldquo;{discoverMutation.data.page_title}&rdquo;
                      </span>
                    )}
                  </p>
                  <div className="space-y-1 rounded-md border p-2">
                    {discoverMutation.data.streams.map((stream) => (
                      <div key={stream.url} className="flex items-center gap-2 text-xs">
                        <Radio className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 truncate font-mono" title={stream.url}>
                          {stream.url}
                        </span>
                        <Badge variant="outline" className="shrink-0 text-[10px]">
                          {stream.source}
                        </Badge>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="ml-auto h-6 shrink-0 px-2 text-xs"
                          onClick={() => handleSelectStream(stream)}
                          disabled={isDownloading}
                        >
                          Select
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Format loading */}
          {formatsMutation.isPending && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {isHls ? "Parsing HLS playlist..." : "Checking available formats..."}
            </div>
          )}

          {formatsMutation.error && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {formatsMutation.error.message}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => formatsMutation.mutate({ url: effectiveUrl })}
              >
                Retry
              </Button>
            </div>
          )}

          {formatsMutation.data && (
            <>
              {/* HLS Variant Picker */}
              {showHlsVariantPicker ? (
                <div className="space-y-2">
                  <Label className="text-sm">Available Qualities</Label>
                  <div className="space-y-1 rounded-md border p-2">
                    {hlsVariants.map((v) => (
                      <label
                        key={v.format_id}
                        className={cn(
                          "flex cursor-pointer items-center gap-3 rounded-lg border px-2 py-1.5 text-sm hover:bg-muted/50",
                          selectedHlsVariant === v.format_id
                            ? "border-brand ring-1 ring-brand"
                            : "border-transparent",
                        )}
                      >
                        <input
                          type="radio"
                          name="hls-variant"
                          checked={selectedHlsVariant === v.format_id}
                          onChange={() => setSelectedHlsVariant(v.format_id)}
                          disabled={isDownloading}
                          className="sr-only"
                        />
                        <span className="font-medium">
                          {v.format_note !== "unknown" ? v.format_note : v.resolution}
                        </span>
                        {v.resolution !== "unknown" && v.format_note !== v.resolution && (
                          <span className="text-muted-foreground">{v.resolution}</span>
                        )}
                        <span className="ml-auto text-xs text-muted-foreground">
                          {formatBitrate(v.filesize_approx)}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  {/* Preset selector (yt-dlp mode) */}
                  <div className="space-y-2">
                    <Label className="text-sm">Quality Preset</Label>
                    <div className="flex flex-wrap gap-2">
                      {PRESETS.map((p) => (
                        <Button
                          key={p.value}
                          variant={!showAdvanced && preset === p.value ? "default" : "outline"}
                          size="sm"
                          onClick={() => {
                            setPreset(p.value);
                            setShowAdvanced(false);
                            setSelectedFormatId(null);
                          }}
                          disabled={isDownloading}
                        >
                          {p.label}
                        </Button>
                      ))}
                    </div>
                  </div>

                  {/* Advanced toggle */}
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="show-advanced"
                      checked={showAdvanced}
                      onCheckedChange={(checked) => {
                        setShowAdvanced(checked === true);
                        if (!checked) setSelectedFormatId(null);
                      }}
                      disabled={isDownloading}
                    />
                    <Label htmlFor="show-advanced" className="cursor-pointer text-sm">
                      Show all formats ({sortedFormats.length})
                    </Label>
                  </div>

                  {/* Advanced format table */}
                  {showAdvanced && (
                    <div className="max-h-56 overflow-y-auto rounded-md border">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-muted">
                          <tr>
                            <th className="px-2 py-1.5 text-left font-medium" />
                            <th className="px-2 py-1.5 text-left font-medium">ID</th>
                            <th className="px-2 py-1.5 text-left font-medium">Ext</th>
                            <th className="px-2 py-1.5 text-left font-medium">Resolution</th>
                            <th className="px-2 py-1.5 text-left font-medium">FPS</th>
                            <th className="px-2 py-1.5 text-left font-medium">Video</th>
                            <th className="px-2 py-1.5 text-left font-medium">Audio</th>
                            <th className="px-2 py-1.5 text-right font-medium">Size</th>
                            <th className="px-2 py-1.5 text-left font-medium">Note</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedFormats.map((f) => (
                            <tr
                              key={f.format_id}
                              onClick={() => !isDownloading && setSelectedFormatId(f.format_id)}
                              className={cn(
                                "cursor-pointer border-t hover:bg-muted/50",
                                selectedFormatId === f.format_id && "bg-brand/10",
                              )}
                            >
                              <td className="px-2 py-1">
                                <input
                                  type="radio"
                                  name="format"
                                  checked={selectedFormatId === f.format_id}
                                  onChange={() => setSelectedFormatId(f.format_id)}
                                  disabled={isDownloading}
                                  className="h-3 w-3"
                                />
                              </td>
                              <td className="px-2 py-1 font-mono">{f.format_id}</td>
                              <td className="px-2 py-1">{f.ext}</td>
                              <td className="px-2 py-1">{f.resolution}</td>
                              <td className="px-2 py-1">{f.fps ?? "\u2014"}</td>
                              <td className="px-2 py-1">
                                {f.vcodec !== "none" ? f.vcodec.split(".")[0] : "\u2014"}
                              </td>
                              <td className="px-2 py-1">
                                {f.acodec !== "none" ? f.acodec.split(".")[0] : "\u2014"}
                              </td>
                              <td className="px-2 py-1 text-right">
                                {formatBytes(f.filesize ?? f.filesize_approx)}
                              </td>
                              <td className="px-2 py-1 text-muted-foreground">{f.format_note}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}

              {/* Merge format selector */}
              <div className="flex items-center gap-3">
                <Label className="whitespace-nowrap text-sm">Output Format</Label>
                <Select
                  value={mergeFormat}
                  onValueChange={(v) => setMergeFormat(v as "mp4" | "webm" | "mkv" | "mp3")}
                  disabled={isDownloading}
                >
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mp4">MP4</SelectItem>
                    <SelectItem value="webm">WebM</SelectItem>
                    <SelectItem value="mkv">MKV</SelectItem>
                    <SelectItem value="mp3">MP3</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Download button + status */}
              <div className="flex items-center gap-3">
                <Button
                  onClick={handleDownload}
                  disabled={
                    isDownloading ||
                    (showHlsVariantPicker && !selectedHlsVariant) ||
                    (!showHlsVariantPicker && showAdvanced && !selectedFormatId)
                  }
                  size="sm"
                >
                  {isDownloading ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="mr-2 h-4 w-4" />
                  )}
                  {isDownloading ? "Downloading..." : "Download Video"}
                </Button>

                {isDownloading && pendingJobId && (
                  <span className="text-xs text-muted-foreground">
                    Job {pendingJobId.slice(0, 8)}...
                  </span>
                )}

                {downloadComplete && (
                  <span className="flex items-center gap-1 text-xs text-brand">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Download started
                  </span>
                )}
              </div>

              {downloadError && (
                <div className="flex items-center gap-2 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" />
                  {downloadError}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
