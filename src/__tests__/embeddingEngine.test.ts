import { describe, it, expect } from "vitest";
import { getModelCacheDir } from "../embeddingEngine";
import { homedir } from "os";
import { join } from "path";

describe("embeddingEngine", () => {
  it("returns correct model cache directory", () => {
    const dir = getModelCacheDir();
    expect(dir).toBe(join(homedir(), ".openbrain", "models", "embed"));
  });
});
