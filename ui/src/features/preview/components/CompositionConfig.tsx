import { Grid2x2, Grid3x3, Image } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { type GridMode } from "../types";

interface CompositionConfigProps {
  mode: GridMode;
  overlayFrameNumber: boolean;
  overlayTimestamp: boolean;
  fps: number;
  onModeChange: (mode: GridMode) => void;
  onOverlayFrameNumberChange: (checked: boolean) => void;
  onOverlayTimestampChange: (checked: boolean) => void;
  onFpsChange: (fps: number) => void;
  disabled?: boolean;
}

const MODE_OPTIONS: { value: GridMode; label: string; description: string; icon: typeof Image }[] = [
  { value: 1, label: "1x1", description: "Overlay only", icon: Image },
  { value: 4, label: "2x2", description: "4 frames/sheet", icon: Grid2x2 },
  { value: 16, label: "4x4", description: "16 frames/sheet", icon: Grid3x3 },
];

export function CompositionConfig({
  mode,
  overlayFrameNumber,
  overlayTimestamp,
  fps,
  onModeChange,
  onOverlayFrameNumberChange,
  onOverlayTimestampChange,
  onFpsChange,
  disabled,
}: CompositionConfigProps) {
  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <Label className="text-sm font-medium">Grid Mode</Label>
        <div className="flex gap-2">
          {MODE_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            return (
              <Button
                key={opt.value}
                variant={mode === opt.value ? "default" : "outline"}
                size="sm"
                onClick={() => onModeChange(opt.value)}
                disabled={disabled}
                className="flex-1"
              >
                <Icon className="mr-2 h-4 w-4" />
                <span>
                  {opt.label}
                  <span className="ml-1 hidden text-xs opacity-70 sm:inline">
                    {opt.description}
                  </span>
                </span>
              </Button>
            );
          })}
        </div>
      </div>

      <div className="space-y-3">
        <Label className="text-sm font-medium">Overlays</Label>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Checkbox
              id="overlay-frame-number"
              checked={overlayFrameNumber}
              onCheckedChange={(checked) => onOverlayFrameNumberChange(checked === true)}
              disabled={disabled}
            />
            <Label htmlFor="overlay-frame-number" className="text-sm font-normal">
              Show frame numbers
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="overlay-timestamp"
              checked={overlayTimestamp}
              onCheckedChange={(checked) => onOverlayTimestampChange(checked === true)}
              disabled={disabled}
            />
            <Label htmlFor="overlay-timestamp" className="text-sm font-normal">
              Show timestamps
            </Label>
          </div>
        </div>
      </div>

      {overlayTimestamp && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">FPS (for timestamp calculation)</Label>
          <Input
            type="number"
            min={1}
            max={120}
            value={fps}
            onChange={(e) => onFpsChange(Number(e.target.value) || 1)}
            disabled={disabled}
            className="w-32"
          />
          <p className="text-xs text-muted-foreground">
            Used to calculate timestamps on each frame overlay
          </p>
        </div>
      )}
    </div>
  );
}
