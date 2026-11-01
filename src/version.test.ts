import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VERSION } from "./version.js";

describe("VERSION", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf-8"),
    ) as { version: string };

    expect(VERSION).toBe(pkg.version);
  });
});
