import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock obsidian module
vi.mock("obsidian", () => ({
  App: class {},
  TFile: class {},
}));

import type { IndexEntry } from "../vaultIndex";

// ── Scoring logic ────────────────────────────────────────────────────────
//
// VaultIndex.search uses this algorithm:
//   basename.startsWith(q) -> score 4
//   basename.includes(q)   -> score 3
//   alias includes(q)      -> score 2
//   path.includes(q)       -> score 1
//
// Since VaultIndex requires App in the constructor, we replicate the
// scoring algorithm here for unit testing.

interface ScoredEntry {
  entry: IndexEntry;
  score: number;
}

function scoreSearch(entries: IndexEntry[], query: string, limit = 8): IndexEntry[] {
  if (!query) {
    return entries.slice(0, limit);
  }

  const q = query.toLowerCase();
  const scored: ScoredEntry[] = [];

  for (const entry of entries) {
    const bn = entry.basename.toLowerCase();
    const p = entry.path.toLowerCase();

    let score = 0;
    if (bn.startsWith(q)) {
      score = 4;
    } else if (bn.includes(q)) {
      score = 3;
    } else if (entry.aliases.some((a) => a.toLowerCase().includes(q))) {
      score = 2;
    } else if (p.includes(q)) {
      score = 1;
    }

    if (score > 0) {
      scored.push({ entry, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.entry);
}

// ── Test data ────────────────────────────────────────────────────────────

function makeEntry(path: string, basename: string, aliases: string[] = []): IndexEntry {
  return { path, basename, aliases };
}

const testEntries: IndexEntry[] = [
  makeEntry("notes/Daily Note.md", "Daily Note"),
  makeEntry("notes/Meeting Notes.md", "Meeting Notes", ["standup"]),
  makeEntry("projects/daily-tracker.md", "daily-tracker"),
  makeEntry("archive/old/daily-log.md", "daily-log"),
  makeEntry("notes/Weekly Review.md", "Weekly Review", ["weekly", "review"]),
  makeEntry("notes/React Guide.md", "React Guide"),
  makeEntry("deep/nested/path/daily/info.md", "info"),
];

// ── Tests ────────────────────────────────────────────────────────────────

describe("VaultIndex scoring", () => {
  it("scores basename.startsWith as 4 (highest)", () => {
    const results = scoreSearch(testEntries, "daily");
    // "Daily Note" and "daily-tracker" and "daily-log" all startsWith "daily"
    expect(results.length).toBeGreaterThanOrEqual(3);
    // The first results should be the ones that start with "daily"
    const topBasenames = results.slice(0, 3).map((e) => e.basename.toLowerCase());
    for (const bn of topBasenames) {
      expect(bn.startsWith("daily")).toBe(true);
    }
  });

  it("scores basename.includes as 3", () => {
    const results = scoreSearch(testEntries, "note");
    // "Daily Note" starts with... no, "note" is in "Daily Note" but doesn't start basename
    // "Meeting Notes" includes "note"
    // Both should score 3
    const basenames = results.map((e) => e.basename);
    expect(basenames).toContain("Daily Note");
    expect(basenames).toContain("Meeting Notes");
  });

  it("scores alias match as 2", () => {
    const results = scoreSearch(testEntries, "standup");
    expect(results).toHaveLength(1);
    expect(results[0].basename).toBe("Meeting Notes");
  });

  it("scores path match as 1", () => {
    const results = scoreSearch(testEntries, "archive");
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("archive/old/daily-log.md");
  });

  it("returns results sorted by score descending", () => {
    // "daily" appears in:
    //   basename startsWith: "Daily Note", "daily-tracker", "daily-log" -> score 4
    //   path: "deep/nested/path/daily/info.md" -> score 1
    const results = scoreSearch(testEntries, "daily");

    // First 3 should be score-4 entries (basename starts with daily)
    // Last should be score-1 (path match only)
    const last = results[results.length - 1];
    expect(last.basename).toBe("info");
  });

  it("returns empty for no matches", () => {
    const results = scoreSearch(testEntries, "zzzznotfound");
    expect(results).toHaveLength(0);
  });

  it("respects limit parameter", () => {
    const results = scoreSearch(testEntries, "daily", 2);
    expect(results).toHaveLength(2);
  });

  it("returns all entries (up to limit) when query is empty", () => {
    const results = scoreSearch(testEntries, "");
    expect(results).toHaveLength(testEntries.length);
  });

  it("returns at most limit entries when query is empty", () => {
    const results = scoreSearch(testEntries, "", 3);
    expect(results).toHaveLength(3);
  });

  it("is case-insensitive", () => {
    const lower = scoreSearch(testEntries, "react");
    const upper = scoreSearch(testEntries, "REACT");
    const mixed = scoreSearch(testEntries, "ReAcT");

    expect(lower).toEqual(upper);
    expect(upper).toEqual(mixed);
    expect(lower).toHaveLength(1);
    expect(lower[0].basename).toBe("React Guide");
  });

  it("alias match is case-insensitive", () => {
    const results = scoreSearch(testEntries, "WEEKLY");
    expect(results).toHaveLength(1);
    expect(results[0].basename).toBe("Weekly Review");
  });
});
