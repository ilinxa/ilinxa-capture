// archiver 8 ships no types. Only what download.handler.ts uses.
declare module "archiver" {
  import type { Readable, Transform } from "node:stream";

  export class ZipArchive extends Transform {
    constructor(options?: { zlib?: { level?: number } });
    append(source: Readable | Buffer | string, data: { name: string }): this;
    finalize(): Promise<void>;
  }
}
