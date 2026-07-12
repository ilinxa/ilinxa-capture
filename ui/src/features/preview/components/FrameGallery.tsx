import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";

interface FrameGalleryProps {
  urls: string[];
  count: number;
}

export function FrameGallery({ urls, count }: FrameGalleryProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Label className="text-sm font-medium">Extracted Frames</Label>
        <Badge variant="secondary">{count}</Badge>
      </div>
      <div className="max-h-80 overflow-y-auto rounded-md border p-2">
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
          {urls.map((url, i) => (
            <div
              key={url}
              className="group relative aspect-video overflow-hidden rounded-lg border border-border bg-muted transition hover:ring-2 hover:ring-brand/50"
            >
              <img
                src={url}
                alt={`Frame ${i + 1}`}
                loading="lazy"
                className="h-full w-full object-cover"
              />
              <span className="absolute bottom-0 left-0 bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
                {i + 1}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
