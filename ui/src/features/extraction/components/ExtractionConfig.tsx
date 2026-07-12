import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";

interface ExtractionConfigProps {
  fps: number;
  preset: "llm" | "high" | "custom";
  customWidth: number;
  customFormat: "jpeg" | "png";
  customQuality: number;
  onFpsChange: (fps: number) => void;
  onPresetChange: (preset: "llm" | "high" | "custom") => void;
  onCustomWidthChange: (width: number) => void;
  onCustomFormatChange: (format: "jpeg" | "png") => void;
  onCustomQualityChange: (quality: number) => void;
  disabled?: boolean;
}

export function ExtractionConfig({
  fps,
  preset,
  customWidth,
  customFormat,
  customQuality,
  onFpsChange,
  onPresetChange,
  onCustomWidthChange,
  onCustomFormatChange,
  onCustomQualityChange,
  disabled,
}: ExtractionConfigProps) {
  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">Frames Per Second</Label>
          <span className="text-sm font-mono text-muted-foreground">{fps} fps</span>
        </div>
        <Slider
          min={1}
          max={30}
          step={1}
          value={[fps]}
          onValueChange={([v]) => {
            if (v !== undefined) onFpsChange(v);
          }}
          disabled={disabled}
        />
        <p className="text-xs text-muted-foreground">
          Lower values extract fewer frames. 1-2 fps is recommended for most use cases.
        </p>
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">Quality Preset</Label>
        <Select
          value={preset}
          onValueChange={(v) => onPresetChange(v as "llm" | "high" | "custom")}
          disabled={disabled}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="llm">LLM — 1024px, JPEG 80%</SelectItem>
            <SelectItem value="high">High — Original size, PNG</SelectItem>
            <SelectItem value="custom">Custom</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {preset === "custom" && (
        <div className="space-y-4 rounded-md border bg-muted/30 p-4">
          <div className="space-y-2">
            <Label className="text-sm font-medium">Width (px)</Label>
            <Input
              type="number"
              min={1}
              placeholder="Leave empty for original"
              value={customWidth || ""}
              onChange={(e) => onCustomWidthChange(Number(e.target.value) || 0)}
              disabled={disabled}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">Format</Label>
            <Select
              value={customFormat}
              onValueChange={(v) => onCustomFormatChange(v as "jpeg" | "png")}
              disabled={disabled}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="jpeg">JPEG</SelectItem>
                <SelectItem value="png">PNG</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {customFormat === "jpeg" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Quality</Label>
                <span className="text-sm font-mono text-muted-foreground">{customQuality}%</span>
              </div>
              <Slider
                min={1}
                max={100}
                step={1}
                value={[customQuality]}
                onValueChange={([v]) => {
                  if (v !== undefined) onCustomQualityChange(v);
                }}
                disabled={disabled}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
