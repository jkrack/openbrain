import { App, TFile } from "obsidian";

export interface IndexEntry {
  path: string;
  basename: string;
  aliases: string[];
  tags: string[];
  headings: string[];
  links: string[];      // Outgoing wikilinks
  frontmatterType: string; // type field from frontmatter
}

export class VaultIndex {
  private entries = new Map<string, IndexEntry>();
  private app: App;

  constructor(app: App) {
    this.app = app;
    this.buildIndex();
  }

  private buildIndex(): void {
    for (const file of this.app.vault.getMarkdownFiles()) {
      this.indexFile(file);
    }
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

    this.entries.set(file.path, {
      path: file.path,
      basename: file.basename,
      aliases,
      tags,
      headings,
      links,
      frontmatterType: fm?.type || "",
    });
  }

  update(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile && file.extension === "md") {
      this.indexFile(file);
    }
  }

  remove(path: string): void {
    this.entries.delete(path);
  }

  rename(oldPath: string, newPath: string): void {
    this.entries.delete(oldPath);
    this.update(newPath);
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

  /** Get all entries of a specific frontmatter type. */
  getByType(type: string): IndexEntry[] {
    return Array.from(this.entries.values()).filter(
      (e) => e.frontmatterType === type
    );
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
}
