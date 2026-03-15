import { App, TFile } from "obsidian";

export interface IndexEntry {
  path: string;
  basename: string;
  aliases: string[];
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

    this.entries.set(file.path, {
      path: file.path,
      basename: file.basename,
      aliases,
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

  search(query: string, limit = 8): IndexEntry[] {
    if (!query) {
      // No query — return recent files
      return Array.from(this.entries.values())
        .slice(0, limit);
    }

    const q = query.toLowerCase();
    const scored: { entry: IndexEntry; score: number }[] = [];

    for (const entry of this.entries.values()) {
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
}
