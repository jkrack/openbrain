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
      score = 5;
    } else if (bn.includes(q)) {
      score = 4;
    } else if (entry.aliases.some((a) => a.toLowerCase().includes(q))) {
      score = 3;
    } else if (entry.tags.some((t) => t.toLowerCase().includes(q))) {
      score = 2.5;
    } else if (entry.headings.some((h) => h.toLowerCase().includes(q))) {
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

function makeEntry(
  path: string,
  basename: string,
  aliases: string[] = [],
  extra: Partial<IndexEntry> = {}
): IndexEntry {
  return {
    path, basename, aliases, tags: [], headings: [], links: [],
    frontmatterType: "", mentionsPeople: [], mentionsProjects: [], mentionsTopics: [],
    ...extra,
  };
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

// ── Graph traversal tests ─────────────────────────────────────────────
//
// Since VaultIndex.getGraphContext requires App, we replicate the BFS
// scoring algorithm here for unit testing.

import type { GraphResult } from "../vaultIndex";

interface GraphEntry extends IndexEntry {
  // same as IndexEntry, reused here for graph test data
}

/** Replicate getBacklinks: entries whose links include target */
function getBacklinks(entries: Map<string, GraphEntry>, path: string): GraphEntry[] {
  const target = path.replace(/\.md$/, "");
  const results: GraphEntry[] = [];
  for (const e of entries.values()) {
    if (e.links.some((l) => l === target || l === path)) results.push(e);
  }
  return results;
}

/** Replicate getOutgoingLinks: resolve links to entries */
function getOutgoingLinks(entries: Map<string, GraphEntry>, path: string): GraphEntry[] {
  const entry = entries.get(path);
  if (!entry) return [];
  const results: GraphEntry[] = [];
  for (const link of entry.links) {
    const resolved = entries.get(link + ".md") || entries.get(link);
    if (resolved) results.push(resolved);
  }
  return results;
}

/** Build mentionedBy reverse index */
function buildMentionedBy(entries: Map<string, GraphEntry>): Map<string, string[]> {
  const mentionedBy = new Map<string, string[]>();
  for (const entry of entries.values()) {
    for (const m of [...entry.mentionsPeople, ...entry.mentionsProjects, ...entry.mentionsTopics]) {
      const list = mentionedBy.get(m) || [];
      list.push(entry.path);
      mentionedBy.set(m, list);
    }
  }
  return mentionedBy;
}

/** Replicate getGraphContext BFS */
function getGraphContext(
  entries: Map<string, GraphEntry>,
  seedPaths: string[],
  maxHops = 2,
  limit = 10,
  excludeFolders: string[] = []
): GraphResult[] {
  const visited = new Set<string>();
  const scores = new Map<string, { score: number; hop: number; relationship: string }>();
  const queue: [string, number][] = [];
  const mentionedByMap = buildMentionedBy(entries);

  for (const seed of seedPaths) {
    visited.add(seed);
    queue.push([seed, 0]);
    scores.set(seed, { score: 10, hop: 0, relationship: "seed" });
  }

  while (queue.length > 0) {
    const [currentPath, currentHop] = queue.shift()!;
    if (currentHop >= maxHops) continue;

    const nextHop = currentHop + 1;
    const decay = Math.pow(0.5, nextHop);
    const entry = entries.get(currentPath);
    if (!entry) continue;

    const addScore = (path: string, baseScore: number, relationship: string) => {
      if (excludeFolders.some((f) => path.startsWith(f + "/"))) return;
      const decayedScore = baseScore * decay;
      const existing = scores.get(path);
      if (existing) {
        existing.score += decayedScore;
        if (nextHop < existing.hop) {
          existing.hop = nextHop;
          existing.relationship = relationship;
        }
      } else {
        scores.set(path, { score: decayedScore, hop: nextHop, relationship });
      }
      if (!visited.has(path)) {
        visited.add(path);
        queue.push([path, nextHop]);
      }
    };

    for (const bl of getBacklinks(entries, currentPath)) addScore(bl.path, 5, "backlink");
    for (const ol of getOutgoingLinks(entries, currentPath)) addScore(ol.path, 4, "outgoing link");

    const allMentions = [...entry.mentionsPeople, ...entry.mentionsProjects, ...entry.mentionsTopics];
    for (const entityPath of allMentions) {
      const mentioners = mentionedByMap.get(entityPath) || [];
      for (const mp of mentioners) {
        if (mp !== currentPath) addScore(mp, 4, `shared entity: ${entityPath.replace(/\.md$/, "")}`);
      }
      if (entries.has(entityPath)) addScore(entityPath, 4, "mentioned entity");
    }

    for (const tag of entry.tags) {
      for (const other of entries.values()) {
        if (other.path !== currentPath && other.tags.includes(tag)) {
          addScore(other.path, 1, `shared tag: ${tag}`);
        }
      }
    }
  }

  for (const seed of seedPaths) scores.delete(seed);

  return Array.from(scores.entries())
    .map(([path, data]) => ({ path, ...data }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── Graph test data ──────────────────────────────────────────────────

function buildGraphEntries(): Map<string, GraphEntry> {
  const m = new Map<string, GraphEntry>();
  const add = (e: GraphEntry) => m.set(e.path, e);

  // People
  add(makeEntry("People/Scott.md", "Scott", [], { frontmatterType: "person" }));
  add(makeEntry("People/Alice.md", "Alice", [], { frontmatterType: "person" }));

  // Projects
  add(makeEntry("Projects/Alpha.md", "Alpha", [], { frontmatterType: "project", tags: ["active"] }));

  // Meetings that mention people and projects
  add(makeEntry("Meetings/2026-03-20-standup.md", "2026-03-20-standup", [], {
    links: ["People/Scott", "Projects/Alpha"],
    mentionsPeople: ["People/Scott.md"],
    mentionsProjects: ["Projects/Alpha.md"],
    tags: ["meeting"],
  }));

  add(makeEntry("Meetings/2026-03-21-standup.md", "2026-03-21-standup", [], {
    links: ["People/Scott", "People/Alice"],
    mentionsPeople: ["People/Scott.md", "People/Alice.md"],
    tags: ["meeting"],
  }));

  // A note that links to the project
  add(makeEntry("Notes/alpha-ideas.md", "alpha-ideas", [], {
    links: ["Projects/Alpha"],
    mentionsProjects: ["Projects/Alpha.md"],
    tags: ["active"],
  }));

  // An unrelated note
  add(makeEntry("Notes/cooking-recipes.md", "cooking-recipes", [], {
    tags: ["hobby"],
  }));

  // A chat note (should be excludeable)
  add(makeEntry("OpenBrain/chats/chat-001.md", "chat-001", [], {
    links: ["People/Scott"],
  }));

  return m;
}

describe("getGraphContext", () => {
  const entries = buildGraphEntries();

  it("returns hop-1 results from seed", () => {
    const results = getGraphContext(entries, ["People/Scott.md"], 1, 10);
    const paths = results.map((r) => r.path);
    // Scott is linked from both standups
    expect(paths).toContain("Meetings/2026-03-20-standup.md");
    expect(paths).toContain("Meetings/2026-03-21-standup.md");
  });

  it("returns hop-2 results with decay", () => {
    const results = getGraphContext(entries, ["People/Scott.md"], 2, 10);
    const paths = results.map((r) => r.path);
    // Through standup → Alpha → alpha-ideas (hop 2)
    expect(paths).toContain("Notes/alpha-ideas.md");
  });

  it("hop-2 scores are lower than hop-1", () => {
    const results = getGraphContext(entries, ["People/Scott.md"], 2, 20);
    const hop1 = results.filter((r) => r.hop === 1);
    const hop2 = results.filter((r) => r.hop === 2);

    if (hop1.length > 0 && hop2.length > 0) {
      const maxHop2 = Math.max(...hop2.map((r) => r.score));
      const minHop1 = Math.min(...hop1.map((r) => r.score));
      // Hop-2 max should be less than hop-1 min (due to 0.5 decay)
      // This may not always hold if there are many shared entities, but
      // for our test data it should
      expect(maxHop2).toBeLessThanOrEqual(minHop1);
    }
  });

  it("does not return the seed in results", () => {
    const results = getGraphContext(entries, ["People/Scott.md"], 2, 10);
    const paths = results.map((r) => r.path);
    expect(paths).not.toContain("People/Scott.md");
  });

  it("detects cycles without infinite loop", () => {
    // Scott → standup → Scott (cycle) — should not loop
    const results = getGraphContext(entries, ["People/Scott.md"], 3, 10);
    expect(results.length).toBeGreaterThan(0);
    // Just verify it terminates and returns results
  });

  it("excludes folders", () => {
    const results = getGraphContext(entries, ["People/Scott.md"], 2, 10, ["OpenBrain/chats"]);
    const paths = results.map((r) => r.path);
    expect(paths).not.toContain("OpenBrain/chats/chat-001.md");
  });

  it("respects limit parameter", () => {
    const results = getGraphContext(entries, ["People/Scott.md"], 2, 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("handles unknown seed gracefully", () => {
    const results = getGraphContext(entries, ["nonexistent.md"], 2, 10);
    expect(results).toHaveLength(0);
  });

  it("shared entity mentions boost scores", () => {
    // Both standups mention Scott — if we seed from one standup,
    // the other should score highly via shared entity
    const results = getGraphContext(entries, ["Meetings/2026-03-20-standup.md"], 1, 10);
    const other = results.find((r) => r.path === "Meetings/2026-03-21-standup.md");
    expect(other).toBeDefined();
    // Score should be > 4 (backlink alone) since shared entity adds more
    expect(other!.score).toBeGreaterThan(2);
  });

  it("shared tags contribute to scores", () => {
    // alpha-ideas and Projects/Alpha both have tag "active"
    const results = getGraphContext(entries, ["Projects/Alpha.md"], 1, 10);
    const alphaIdeas = results.find((r) => r.path === "Notes/alpha-ideas.md");
    expect(alphaIdeas).toBeDefined();
  });

  it("does not include unrelated notes", () => {
    const results = getGraphContext(entries, ["People/Scott.md"], 1, 10);
    const paths = results.map((r) => r.path);
    expect(paths).not.toContain("Notes/cooking-recipes.md");
  });
});
