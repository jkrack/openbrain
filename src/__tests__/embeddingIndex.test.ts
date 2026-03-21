import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  createEmbeddingIndex,
  type EmbeddingIndex,
  type NoteMatch,
  type PassageMatch,
} from "../embeddingIndex";

let testDir: string;
let index: EmbeddingIndex;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "ob-embed-test-"));
  index = createEmbeddingIndex(384);
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// Helper: create a normalized random vector
function randomVector(dims: number): Float32Array {
  const v = new Float32Array(dims);
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    v[i] = Math.random() - 0.5;
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dims; i++) v[i] /= norm;
  return v;
}

// Helper: create a vector similar to another (high cosine similarity)
function similarVector(base: Float32Array, noise = 0.1): Float32Array {
  const v = new Float32Array(base.length);
  let norm = 0;
  for (let i = 0; i < base.length; i++) {
    v[i] = base[i] + (Math.random() - 0.5) * noise;
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < base.length; i++) v[i] /= norm;
  return v;
}

describe("embeddingIndex", () => {
  it("adds and retrieves note vectors", () => {
    const vec = randomVector(384);
    index.add("notes/test.md", 1000, vec, []);
    expect(index.has("notes/test.md", 1000)).toBe(true);
    expect(index.has("notes/test.md", 999)).toBe(false);
    expect(index.has("notes/other.md", 1000)).toBe(false);
  });

  it("removes entries", () => {
    const vec = randomVector(384);
    index.add("notes/test.md", 1000, vec, []);
    index.remove("notes/test.md");
    expect(index.has("notes/test.md", 1000)).toBe(false);
  });

  it("searches notes by cosine similarity", () => {
    const queryVec = randomVector(384);
    const similarVec = similarVector(queryVec, 0.05);
    const dissimilarVec = randomVector(384);

    index.add("notes/relevant.md", 1000, similarVec, []);
    index.add("notes/irrelevant.md", 1000, dissimilarVec, []);

    const results = index.searchNotes(queryVec, 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].path).toBe("notes/relevant.md");
    expect(results[0].score).toBeGreaterThan(results[results.length - 1]?.score || 0);
  });

  it("searches passages by cosine similarity", () => {
    const queryVec = randomVector(384);
    const relevantSection = similarVector(queryVec, 0.05);
    const irrelevantSection = randomVector(384);

    index.add("notes/meeting.md", 1000, randomVector(384), [
      { heading: "## Decisions", text: "Decided to launch in April", vector: relevantSection },
      { heading: "## Attendees", text: "John, Sarah, Mike", vector: irrelevantSection },
    ]);

    const results = index.searchPassages(queryVec, 5, 0.3);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].heading).toBe("## Decisions");
    expect(results[0].text).toBe("Decided to launch in April");
  });

  it("persists and loads from binary file", async () => {
    const vec1 = randomVector(384);
    const vec2 = randomVector(384);
    index.add("notes/a.md", 1000, vec1, [
      { heading: "## Summary", text: "A summary", vector: randomVector(384) },
    ]);
    index.add("notes/b.md", 2000, vec2, []);

    const filePath = join(testDir, "index.bin");
    await index.save(filePath);

    const loaded = createEmbeddingIndex(384);
    await loaded.load(filePath);

    expect(loaded.has("notes/a.md", 1000)).toBe(true);
    expect(loaded.has("notes/b.md", 2000)).toBe(true);

    const stats = loaded.stats();
    expect(stats.noteCount).toBe(2);
    expect(stats.sectionCount).toBe(1);
  });

  it("reports stats correctly", () => {
    index.add("a.md", 1, randomVector(384), [
      { heading: "## H1", text: "text1", vector: randomVector(384) },
      { heading: "## H2", text: "text2", vector: randomVector(384) },
    ]);
    index.add("b.md", 2, randomVector(384), []);

    const stats = index.stats();
    expect(stats.noteCount).toBe(2);
    expect(stats.sectionCount).toBe(2);
  });

  it("clears all entries", () => {
    index.add("a.md", 1, randomVector(384), []);
    index.add("b.md", 2, randomVector(384), []);
    index.clear();
    expect(index.stats().noteCount).toBe(0);
  });
});
