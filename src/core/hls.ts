import { HlsParseError } from "../utils/errors.js";
import { execFileAsync } from "../utils/exec.js";

// ─── Types ──────────────────────────────────────────────────────────

export interface HlsVariant {
  bandwidth: number | null;
  resolution: string | null;
  width: number | null;
  height: number | null;
  name: string | null;
  codecs: string | null;
  url: string;
}

export interface HlsPlaylistInfo {
  variants: HlsVariant[];
  is_master: boolean;
  original_url: string;
}

export interface DiscoveredStream {
  url: string;
  source: string;
}

export interface HlsDiscoverResult {
  page_url: string;
  page_title: string | null;
  streams: DiscoveredStream[];
}

// ─── Helpers ────────────────────────────────────────────────────────

function buildFetchHeaders(
  headers?: Record<string, string>,
): Record<string, string> {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    ...headers,
  };
}

/**
 * Parse attributes from an EXT-X-STREAM-INF line.
 * Example: BANDWIDTH=2760704,RESOLUTION=1920x1080,NAME="1080p"
 */
function parseStreamInfAttributes(
  line: string,
): Record<string, string> {
  const attrs: Record<string, string> = {};
  // Remove the tag prefix
  const attrString = line.replace(/^#EXT-X-STREAM-INF:/, "");

  // Parse key=value pairs, handling quoted values
  const regex = /([A-Z0-9_-]+)=(?:"([^"]*)"|([^,]*))/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(attrString)) !== null) {
    const key = match[1]!.toUpperCase();
    const value = match[2] ?? match[3] ?? "";
    attrs[key] = value;
  }

  return attrs;
}

/**
 * Parse resolution string "WIDTHxHEIGHT" into width and height numbers.
 */
function parseResolution(
  resolution: string | undefined,
): { width: number | null; height: number | null } {
  if (!resolution) return { width: null, height: null };
  const parts = resolution.split("x");
  if (parts.length !== 2) return { width: null, height: null };
  const width = parseInt(parts[0]!, 10);
  const height = parseInt(parts[1]!, 10);
  if (isNaN(width) || isNaN(height)) return { width: null, height: null };
  return { width, height };
}

/**
 * Resolve a potentially relative URL against a base URL.
 */
function resolveUrl(relative: string, base: string): string {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Check if a URL points to an HLS playlist (.m3u8).
 */
export function isHlsUrl(source: string): boolean {
  return /\.m3u8(\?|$)/i.test(source);
}

/**
 * Fetch and parse an HLS master playlist to extract available quality variants.
 * If the URL points to a media playlist (not a master), returns a single variant.
 */
export async function parseHlsMasterPlaylist(
  url: string,
  headers?: Record<string, string>,
): Promise<HlsPlaylistInfo> {
  let text: string;
  try {
    const response = await fetch(url, { headers: buildFetchHeaders(headers) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    text = await response.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HlsParseError(`Failed to fetch playlist: ${message}`);
  }

  if (!text.includes("#EXTM3U")) {
    throw new HlsParseError("Not a valid M3U8 playlist");
  }

  const lines = text.split("\n").map((l) => l.trim());
  const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF:"));

  if (!isMaster) {
    // Media playlist — return as single variant
    return {
      variants: [
        {
          bandwidth: null,
          resolution: null,
          width: null,
          height: null,
          name: null,
          codecs: null,
          url,
        },
      ],
      is_master: false,
      original_url: url,
    };
  }

  const variants: HlsVariant[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;

    const attrs = parseStreamInfAttributes(line);
    const nextLine = lines[i + 1];
    if (!nextLine || nextLine.startsWith("#")) continue;

    const variantUrl = resolveUrl(nextLine, url);
    const { width, height } = parseResolution(attrs["RESOLUTION"]);
    const bandwidth = attrs["BANDWIDTH"]
      ? parseInt(attrs["BANDWIDTH"], 10)
      : null;

    variants.push({
      bandwidth: bandwidth !== null && !isNaN(bandwidth) ? bandwidth : null,
      resolution: attrs["RESOLUTION"] ?? null,
      width,
      height,
      name: attrs["NAME"] ?? null,
      codecs: attrs["CODECS"] ?? null,
      url: variantUrl,
    });
  }

  // Sort by bandwidth descending (highest quality first)
  variants.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));

  return {
    variants,
    is_master: true,
    original_url: url,
  };
}

/**
 * Scan a web page for HLS (.m3u8) stream URLs by fetching and parsing its HTML.
 */
export async function discoverHlsUrls(
  pageUrl: string,
  headers?: Record<string, string>,
): Promise<HlsDiscoverResult> {
  let html: string;
  try {
    const response = await fetch(pageUrl, {
      headers: buildFetchHeaders(headers),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    html = await response.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HlsParseError(`Failed to fetch page: ${message}`);
  }

  // Extract page title
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const pageTitle = titleMatch?.[1]?.trim() ?? null;

  const found = new Map<string, DiscoveredStream>();

  // Pattern 1: src="...m3u8..." or href="...m3u8..."
  const attrRegex = /(?:src|href)\s*=\s*["']([^"']*\.m3u8[^"']*)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(html)) !== null) {
    const url = resolveUrl(match[1]!, pageUrl);
    if (!found.has(url)) {
      found.set(url, { url, source: "html_attribute" });
    }
  }

  // Pattern 2: URLs in script content and inline JS
  const scriptRegex = /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi;
  while ((match = scriptRegex.exec(html)) !== null) {
    const url = match[0]!;
    if (!found.has(url)) {
      found.set(url, { url, source: "script_tag" });
    }
  }

  // Pattern 3: Protocol-relative URLs (//cdn.example.com/...m3u8)
  const protoRelRegex = /(?:["'])?(\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)["']?/gi;
  while ((match = protoRelRegex.exec(html)) !== null) {
    const url = resolveUrl(match[1]!, pageUrl);
    if (!found.has(url)) {
      found.set(url, { url, source: "script_tag" });
    }
  }

  return {
    page_url: pageUrl,
    page_title: pageTitle,
    streams: [...found.values()],
  };
}

/**
 * Download an HLS stream using FFmpeg, re-muxing to a single output file.
 * Uses -c copy (no re-encoding) for speed.
 */
export async function downloadHlsStream(
  url: string,
  outputPath: string,
  headers?: Record<string, string>,
): Promise<void> {
  const args: string[] = [];

  // FFmpeg -headers format: "Key: Value\r\n"
  if (headers && Object.keys(headers).length > 0) {
    const headerStr = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("");
    args.push("-headers", headerStr);
  }

  args.push(
    "-i",
    url,
    "-c",
    "copy",
    "-bsf:a",
    "aac_adtstoasc",
    "-movflags",
    "+faststart",
    "-y",
    outputPath,
  );

  try {
    await execFileAsync("ffmpeg", args, { maxBuffer: 50 * 1024 * 1024 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HlsParseError(`FFmpeg HLS download failed: ${message}`);
  }
}
