import { ExternalLink } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";

interface SheetsGalleryProps {
  urls: string[];
  count: number;
  grid: string;
}

export function SheetsGallery({ urls, count, grid }: SheetsGalleryProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Label className="text-sm font-medium">Composed Sheets</Label>
        <Badge variant="secondary">{count}</Badge>
        <Badge variant="outline">{grid} grid</Badge>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {urls.map((url, i) => (
          <a
            key={url}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open sheet ${i + 1} full size`}
            className="group relative overflow-hidden rounded-lg border border-border bg-muted transition hover:shadow-md hover:ring-2 hover:ring-brand/50"
          >
            <img
              src={url}
              alt={`Sheet ${i + 1}`}
              loading="lazy"
              className="w-full object-contain"
            />
            <span className="absolute bottom-0 left-0 bg-black/60 px-2 py-1 text-xs font-medium text-white">
              Sheet {i + 1}
            </span>
            <span className="absolute right-2 top-2 rounded-md bg-black/50 p-1 opacity-0 transition-opacity group-hover:opacity-100">
              <ExternalLink className="h-3.5 w-3.5 text-white" />
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}
