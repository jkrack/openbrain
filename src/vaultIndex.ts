import { App, TFile } from "obsidian";

export interface IndexEntry {
  path: string;
  basename: string;
  aliases: string[];
  tags: string[];
  headings: string[];
  links: string[];           // Outgoing wikilinks
  frontmatterType: string;   // type field from frontmatter
  mentionsPeople: string[];  // parsed from frontmatter mentions_people wikilinks
  mentionsProjects: string[];// parsed from frontmatter mentions_projects wikilinks
  mentionsTopics: string[];  // parsed from frontmatter mentions_topics wikilinks
}

export interface GraphResult {
  path: string;
  score: number;
  hop: number;
  relationship: string;
}

export class VaultIndex {
  private entries = new Map<string, IndexEntry>();
  private app: App;
  private typeCache = new Map<string, IndexEntry[]>();
  private mentionedBy = new Map<string, string[]>();

  constructor(app: App) {
    this.app = app;
    this.buildIndex();
  }

  private buildIndex(): void {
    for (const file of this.app.vault.getMarkdownFiles()) {
      this.indexFile(file);
    }
    this.rebuildCaches();
  }

  /** Parse wikilinks from a YAML array field: "[[People/Scott]]" → "People/Scott.md" */
  private parseWikilinks(value: unknown): string[] {
    if (!value) return [];
    const items = Array.isArray(value) ? value : [value];
    return items
      .map(String)
      .map((s) => {
        const match = s.match(/\[\[([^\]]+)\]\]/);
        const raw = match ? match[1] : s;
        // Normalize: strip .md if present, then add it back
        return raw.replace(/\.md$/, "") + ".md";
      })
      .filter(Boolean);
  }

  private indexFile(file: TFile): void {
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;

    let aliases: string[] = [];
    if (fm?.aliases) {
      if (Array.isArray(fm.aliases)) {
        aliases = fm.aliases.map(String);
      } else if (typeof fm.aliases === "string") {
        aliases = fm.aliases.split(",").map((a: string) => a.trim()).filter(Boolean);
      }
    }

    // Extract tags
    const tags: string[] = [];
    if (fm?.tags) {
      const fmTags = Array.isArray(fm.tags) ? fm.tags : [fm.tags];
      tags.push(...fmTags.map(String));
    }
    if (cache?.tags) {
      for (const t of cache.tags) {
        const tag = t.tag.replace(/^#/, "");
        if (!tags.includes(tag)) tags.push(tag);
      }
    }

    // Extract headings
    const headings = (cache?.headings || []).map((h) => h.heading);

    // Extract outgoing links
    const links = (cache?.links || []).map((l) => l.link);

    // Extract typed relationship mentions from frontmatter
    const mentionsPeople = this.parseWikilinks(fm?.mentions_people);
    const mentionsProjects = this.parseWikilinks(fm?.mentions_projects);
    const mentionsTopics = this.parseWikilinks(fm?.mentions_topics);

    this.entries.set(file.path, {
      path: file.path,
      basename: file.basename,
      aliases,
      tags,
      headings,
      links,
      frontmatterType: fm?.type || "",
      mentionsPeople,
      mentionsProjects,
      mentionsTopics,
    });
  }

  private rebuildCaches(): void {
    this.typeCache.clear();
    this.mentionedBy.clear();

    for (const entry of this.entries.values()) {
      // Type cache
      if (entry.frontmatterType) {
        const list = this.typeCache.get(entry.frontmatterType) || [];
        list.push(entry);
        this.typeCache.set(entry.frontmatterType, list);
      }

      // Reverse mention index
      const allMentions = [
        ...entry.mentionsPeople,
        ...entry.mentionsProjects,
        ...entry.mentionsTopics,
      ];
      for (const mentioned of allMentions) {
        const list = this.mentionedBy.get(mentioned) || [];
        list.push(entry.path);
        this.mentionedBy.set(mentioned, list);
      }
    }
  }

  private invalidateCaches(): void {
    this.rebuildCaches();
  }

  update(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile && file.extension === "md") {
      this.indexFile(file);
      this.invalidateCaches();
    }
  }

  remove(path: string): void {
    this.entries.delete(path);
    this.invalidateCaches();
  }

  rename(oldPath: string, newPath: string): void {
    this.entries.delete(oldPath);
    const file = this.app.vault.getAbstractFileByPath(newPath);
    if (file instanceof TFile && file.extension === "md") {
      this.indexFile(file);
    }
    this.invalidateCaches();
  }

  /** Search by basename, aliases, tags, headings, path. */
  search(query: string, limit = 8): IndexEntry[] {
    if (!query) {
      return Array.from(this.entries.values()).slice(0, limit);
    }

    const q = query.toLowerCase();
    const scored: { entry: IndexEntry; score: number }[] = [];

    for (const entry of this.entries.values()) {
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

  /** Find notes that link TO a given path (backlinks). */
  getBacklinks(path: string): IndexEntry[] {
    const target = path.replace(/\.md$/, "");
    const results: IndexEntry[] = [];

    for (const entry of this.entries.values()) {
      if (entry.links.some((l) => l === target || l === path)) {
        results.push(entry);
      }
    }

    return results;
  }

  /** Find notes linked FROM a given path (outgoing). */
  getOutgoingLinks(path: string): IndexEntry[] {
    const entry = this.entries.get(path);
    if (!entry) return [];

    const results: IndexEntry[] = [];
    for (const link of entry.links) {
      // Resolve link to a path
      const resolved = this.entries.get(link + ".md") || this.entries.get(link);
      if (resolved) results.push(resolved);
    }

    return results;
  }

  /** Get all entries of a specific frontmatter type (O(1) via cache). */
  getByType(type: string): IndexEntry[] {
    return this.typeCache.get(type) || [];
  }

  /** Get all note paths that mention a given entity path. */
  getMentionedBy(entityPath: string): string[] {
    return this.mentionedBy.get(entityPath) || [];
  }

  /** Get related notes — notes that share tags or links with the given path. */
  getRelated(path: string, limit = 5): IndexEntry[] {
    const entry = this.entries.get(path);
    if (!entry) return [];

    const scored = new Map<string, number>();

    // Notes that link to this one
    for (const bl of this.getBacklinks(path)) {
      if (bl.path !== path) scored.set(bl.path, (scored.get(bl.path) || 0) + 3);
    }

    // Notes this one links to
    for (const ol of this.getOutgoingLinks(path)) {
      if (ol.path !== path) scored.set(ol.path, (scored.get(ol.path) || 0) + 2);
    }

    // Notes that share tags
    for (const tag of entry.tags) {
      for (const other of this.entries.values()) {
        if (other.path === path) continue;
        if (other.tags.includes(tag)) {
          scored.set(other.path, (scored.get(other.path) || 0) + 1);
        }
      }
    }

    return Array.from(scored.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([p]) => this.entries.get(p)!)
      .filter(Boolean);
  }

  /** Get an entry by path. */
  getEntry(path: string): IndexEntry | undefined {
    return this.entries.get(path);
  }

  /** Get all indexed entries. */
  getAllEntries(): IndexEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * BFS graph traversal from seed paths, returning scored related notes.
   * Scores decay by 0.5 at each hop beyond hop 0.
   */
  getGraphContext(
    seedPaths: string[],
    maxHops = 2,
    limit = 10,
    excludeFolders: string[] = []
  ): GraphResult[] {
    const visited = new Set<string>();
    const scores = new Map<string, { score: number; hop: number; relationship: string }>();

    // Queue: [path, hop]
    const queue: [string, number][] = [];

    // Initialize seeds
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
      const entry = this.entries.get(currentPath);
      if (!entry) continue;

      const addScore = (path: string, baseScore: number, relationship: string) => {
        if (excludeFolders.some((f) => path.startsWith(f + "/"))) return;
        const decayedScore = baseScore * decay;
        const existing = scores.get(path);
        if (existing) {
          existing.score += decayedScore;
          // Keep the closest hop and most descriptive relationship
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

      // Backlinks: notes that link TO this note (+5)
      for (const bl of this.getBacklinks(currentPath)) {
        addScore(bl.path, 5, "backlink");
      }

      // Outgoing links (+4)
      for (const ol of this.getOutgoingLinks(currentPath)) {
        addScore(ol.path, 4, "outgoing link");
      }

      // Shared mentions_* entity: notes that mention the same entities (+4)
      const allMentions = [
        ...entry.mentionsPeople,
        ...entry.mentionsProjects,
        ...entry.mentionsTopics,
      ];
      for (const entityPath of allMentions) {
        const mentioners = this.mentionedBy.get(entityPath) || [];
        for (const mentionerPath of mentioners) {
          if (mentionerPath !== currentPath) {
            addScore(mentionerPath, 4, `shared entity: ${entityPath.replace(/\.md$/, "")}`);
          }
        }
        // Also add the entity itself
        if (this.entries.has(entityPath)) {
          addScore(entityPath, 4, "mentioned entity");
        }
      }

      // Shared tags (+1)
      for (const tag of entry.tags) {
        for (const other of this.entries.values()) {
          if (other.path !== currentPath && other.tags.includes(tag)) {
            addScore(other.path, 1, `shared tag: ${tag}`);
          }
        }
      }
    }

    // Remove seeds from results
    for (const seed of seedPaths) {
      scores.delete(seed);
    }

    return Array.from(scores.entries())
      .map(([path, data]) => ({ path, ...data }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
