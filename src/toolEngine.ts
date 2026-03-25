import { App, TFile } from "obsidian";
import { OpenBrainSettings } from "./settings";
import * as cli from "./obsidianCli";
import { appendToDailySection } from "./chatHistory";
import { getDailyNotePath } from "./skills";
import { startTimer } from "./perf";
import { ToolResultData } from "./providers/types";
import { EmbeddingSearch } from "./embeddingSearch";
import { VaultIndex } from "./vaultIndex";

let embeddingSearchInstance: EmbeddingSearch | null = null;
let vaultIndexInstance: VaultIndex | null = null;

export function setEmbeddingSearch(search: EmbeddingSearch | null): void {
  embeddingSearchInstance = search;
}

export function getEmbeddingSearch(): EmbeddingSearch | null {
  return embeddingSearchInstance;
}

export function setVaultIndex(index: VaultIndex | null): void {
  vaultIndexInstance = index;
}

export function getVaultIndex(): VaultIndex | null {
  return vaultIndexInstance;
}

/**
 * Execute a tool call and return the result.
 */
export async function executeTool(
  app: App,
  settings: OpenBrainSettings,
  toolName: string,
  toolId: string,
  input: Record<string, string>
): Promise<ToolResultData> {
  const done = startTimer("tool-exec", { tool: toolName });

  try {
    const result = await executeToolInner(app, settings, toolName, input);
    done();
    return { tool_use_id: toolId, content: result, is_error: false };
  } catch (err: unknown) {
    done();
    const message = err instanceof Error ? err.message : String(err);
    return { tool_use_id: toolId, content: `Error: ${message}`, is_error: true };
  }
}

async function executeToolInner(
  app: App,
  settings: OpenBrainSettings,
  toolName: string,
  input: Record<string, string>
): Promise<string> {
  switch (toolName) {
    // --- Read tools ---
    case "vault_search": {
      if (!input.query) throw new Error("query required");
      if (cli.isAvailable()) {
        const result = cli.search(input.query);
        return result || "No results found";
      }
      // Fallback: VaultIndex metadata search + content scan
      const query = input.query.toLowerCase();
      const matches: string[] = [];
      if (vaultIndexInstance) {
        const indexed = vaultIndexInstance.search(query, 20);
        for (const entry of indexed) {
          matches.push(entry.path);
        }
      }
      if (matches.length === 0) {
        // Content scan fallback
        const allFiles = app.vault.getMarkdownFiles();
        for (const f of allFiles.slice(0, 200)) {
          const content = await app.vault.cachedRead(f);
          if (content.toLowerCase().includes(query)) {
            matches.push(f.path);
            if (matches.length >= 20) break;
          }
        }
      }
      return matches.length > 0 ? matches.join("\n") : "No results found";
    }
    case "vault_search_context": {
      if (!input.query) throw new Error("query required");
      if (cli.isAvailable()) {
        const result = cli.search(input.query);
        return result || "No results found";
      }
      // Same fallback as vault_search
      const query = input.query.toLowerCase();
      const matches: string[] = [];
      const allFiles = app.vault.getMarkdownFiles();
      for (const f of allFiles.slice(0, 200)) {
        const content = await app.vault.cachedRead(f);
        const idx = content.toLowerCase().indexOf(query);
        if (idx !== -1) {
          const snippet = content.slice(Math.max(0, idx - 50), idx + 100).replace(/\n/g, " ");
          matches.push(`${f.path}: ...${snippet}...`);
          if (matches.length >= 20) break;
        }
      }
      return matches.length > 0 ? matches.join("\n") : "No results found";
    }
    case "vault_read": {
      if (!input.path) throw new Error("path required");
      const file = app.vault.getAbstractFileByPath(input.path);
      if (!(file instanceof TFile)) throw new Error(`File not found: ${input.path}`);
      return await app.vault.read(file);
    }
    case "vault_list": {
      const folder = input.folder || "";
      const files = app.vault.getMarkdownFiles()
        .filter(f => folder ? f.path.startsWith(folder + "/") : true)
        .map(f => f.path)
        .sort();
      return files.length > 0 ? files.join("\n") : "No files found";
    }
    case "vault_outline": {
      if (!input.path) throw new Error("path required");
      const file = app.vault.getAbstractFileByPath(input.path);
      if (!(file instanceof TFile)) throw new Error(`File not found: ${input.path}`);
      const cache = app.metadataCache.getFileCache(file);
      const headings = cache?.headings || [];
      if (headings.length === 0) return "No headings found";
      return headings.map(h => `${"  ".repeat(h.level - 1)}${"#".repeat(h.level)} ${h.heading}`).join("\n");
    }
    case "vault_backlinks": {
      if (!input.path) throw new Error("path required");
      if (cli.isAvailable()) {
        const result = cli.backlinks(input.path);
        return result || "No backlinks found";
      }
      // Fallback: scan metadataCache
      const target = input.path.replace(/\.md$/, "");
      const backlinks: string[] = [];
      for (const file of app.vault.getMarkdownFiles()) {
        const cache = app.metadataCache.getFileCache(file);
        if (cache?.links?.some(l => l.link === target)) {
          backlinks.push(file.path);
        }
      }
      return backlinks.length > 0 ? backlinks.join("\n") : "No backlinks found";
    }
    case "vault_links": {
      if (!input.path) throw new Error("path required");
      const file = app.vault.getAbstractFileByPath(input.path);
      if (!(file instanceof TFile)) throw new Error(`File not found: ${input.path}`);
      const cache = app.metadataCache.getFileCache(file);
      const links = cache?.links?.map(l => l.link) || [];
      return links.length > 0 ? links.join("\n") : "No outgoing links";
    }
    case "vault_properties": {
      if (!input.path) throw new Error("path required");
      const file = app.vault.getAbstractFileByPath(input.path);
      if (!(file instanceof TFile)) throw new Error(`File not found: ${input.path}`);
      const cache = app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (!fm) return "No frontmatter";
      return Object.entries(fm)
        .filter(([k]) => k !== "position")
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join("\n");
    }
    case "vault_tags": {
      const tagCounts = new Map<string, number>();
      for (const file of app.vault.getMarkdownFiles()) {
        const cache = app.metadataCache.getFileCache(file);
        if (cache?.tags) {
          for (const t of cache.tags) {
            const tag = t.tag.replace(/^#/, "");
            tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
          }
        }
        const fm = cache?.frontmatter;
        if (fm?.tags) {
          const fmTags = Array.isArray(fm.tags) ? fm.tags : [fm.tags];
          for (const tag of fmTags) {
            const t = String(tag);
            tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
          }
        }
      }
      const sorted = Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1]);
      return sorted.map(([tag, count]) => `${tag}: ${count}`).join("\n") || "No tags found";
    }
    case "vault_tasks": {
      const filter = (input.filter === "todo" || input.filter === "done") ? input.filter : undefined;
      if (input.file) {
        if (cli.isAvailable()) {
          const result = cli.tasks(input.file, filter);
          return result || "No tasks found";
        }
        // Fallback: read file and find task patterns
        const file = app.vault.getAbstractFileByPath(input.file);
        if (!(file instanceof TFile)) throw new Error(`File not found: ${input.file}`);
        const content = await app.vault.read(file);
        const tasks = content.match(/- \[[ x]\] .+/g) || [];
        const filtered = filter === "todo" ? tasks.filter(t => t.startsWith("- [ ]"))
          : filter === "done" ? tasks.filter(t => t.startsWith("- [x]"))
          : tasks;
        return filtered.join("\n") || "No tasks found";
      }
      if (cli.isAvailable()) {
        const result = cli.dailyTasks(filter);
        return result || "No tasks found";
      }
      // Fallback: read daily note and extract tasks
      const dailyPath = getDailyNotePath(app, settings);
      const dailyFile = app.vault.getAbstractFileByPath(dailyPath);
      if (dailyFile instanceof TFile) {
        const content = await app.vault.read(dailyFile);
        const tasks = content.match(/- \[[ x]\] .+/g) || [];
        const filtered = filter === "todo" ? tasks.filter(t => t.startsWith("- [ ]"))
          : filter === "done" ? tasks.filter(t => t.startsWith("- [x]"))
          : tasks;
        return filtered.join("\n") || "No tasks found";
      }
      return "No daily note found";
    }
    case "daily_read": {
      if (cli.isAvailable()) {
        const result = cli.dailyRead();
        return result || "No daily note found";
      }
      // Fallback: read daily note via vault API
      const dailyPath = getDailyNotePath(app, settings);
      const dailyFile = app.vault.getAbstractFileByPath(dailyPath);
      if (dailyFile instanceof TFile) {
        return await app.vault.read(dailyFile);
      }
      return "No daily note found";
    }
    case "vault_orphans": {
      // Find files with no backlinks via metadataCache
      const orphans: string[] = [];
      const allFiles = app.vault.getMarkdownFiles();
      const linkedTargets = new Set<string>();
      for (const file of allFiles) {
        const cache = app.metadataCache.getFileCache(file);
        if (cache?.links) {
          for (const link of cache.links) {
            linkedTargets.add(link.link);
            linkedTargets.add(link.link + ".md");
          }
        }
      }
      for (const file of allFiles) {
        const basename = file.path.replace(/\.md$/, "");
        if (!linkedTargets.has(basename) && !linkedTargets.has(file.path)) {
          orphans.push(file.path);
        }
      }
      return orphans.length > 0 ? `${orphans.length} orphan notes:\n${orphans.join("\n")}` : "No orphan notes found";
    }
    case "vault_deadends": {
      const deadends: string[] = [];
      for (const file of app.vault.getMarkdownFiles()) {
        const cache = app.metadataCache.getFileCache(file);
        if (cache?.links) {
          for (const link of cache.links) {
            const target = app.vault.getAbstractFileByPath(link.link + ".md")
              || app.vault.getAbstractFileByPath(link.link);
            if (!target) {
              deadends.push(`${file.path} → [[${link.link}]]`);
            }
          }
        }
      }
      return deadends.length > 0 ? `${deadends.length} broken links:\n${deadends.join("\n")}` : "No broken links found";
    }
    case "vault_unresolved": {
      // Same as deadends for our purposes
      const unresolved: string[] = [];
      for (const file of app.vault.getMarkdownFiles()) {
        const cache = app.metadataCache.getFileCache(file);
        if (cache?.links) {
          for (const link of cache.links) {
            const target = app.vault.getAbstractFileByPath(link.link + ".md")
              || app.vault.getAbstractFileByPath(link.link);
            if (!target) {
              unresolved.push(`[[${link.link}]] in ${file.path}`);
            }
          }
        }
      }
      return unresolved.length > 0 ? `${unresolved.length} unresolved links:\n${unresolved.join("\n")}` : "No unresolved links";
    }
    case "vault_semantic_search": {
      if (!embeddingSearchInstance?.isReady()) {
        return "Semantic search is not available. Enable it in Settings > OpenBrain > Semantic search.";
      }
      const query = input.query as string;
      const limit = ((input.limit as unknown) as number) || 5;

      const notes = await embeddingSearchInstance.searchNotes(query, limit);
      const passages = await embeddingSearchInstance.searchPassages(query, limit);

      let result = "";
      if (passages.length > 0) {
        result += "Relevant passages:\n";
        for (const p of passages) {
          const basename = p.path.split("/").pop()?.replace(/\.md$/, "") || p.path;
          result += `\n"${basename}" > ${p.heading} (score: ${p.score.toFixed(2)}):\n${p.text}\n`;
        }
      }
      if (notes.length > 0) {
        result += "\nRelated notes:\n";
        for (const n of notes) {
          result += `- ${n.path} (score: ${n.score.toFixed(2)})\n`;
        }
      }
      if (!result) result = "No semantically similar content found.";
      return result;
    }

    // --- Graph tools ---
    case "vault_graph_walk": {
      if (!input.path) throw new Error("path required");
      if (!vaultIndexInstance) throw new Error("Vault index not available");
      const hops = Math.min(((input.hops as unknown) as number) || 2, 3);
      const limit = ((input.limit as unknown) as number) || 10;
      const excludeFolders = [
        settings.chatFolder || "OpenBrain/chats",
        settings.templatesFolder || "OpenBrain/templates",
      ];
      const results = vaultIndexInstance.getGraphContext([input.path], hops, limit, excludeFolders);
      if (results.length === 0) return "No related notes found in graph";
      return results
        .map((r) => {
          const basename = r.path.split("/").pop()?.replace(/\.md$/, "") || r.path;
          return `${basename} (${r.path}) — score: ${r.score.toFixed(1)}, hop: ${r.hop}, via: ${r.relationship}`;
        })
        .join("\n");
    }
    case "vault_graph_stats": {
      if (!vaultIndexInstance) throw new Error("Vault index not available");
      const allEntries = vaultIndexInstance.getAllEntries();
      const typeCounts = new Map<string, number>();
      let totalMentions = 0;
      let orphanCount = 0;

      for (const entry of allEntries) {
        if (entry.frontmatterType) {
          typeCounts.set(entry.frontmatterType, (typeCounts.get(entry.frontmatterType) || 0) + 1);
        }
        totalMentions += entry.mentionsPeople.length + entry.mentionsProjects.length + entry.mentionsTopics.length;
      }

      // Find orphans: notes with no backlinks, no mentions, and no outgoing links
      for (const entry of allEntries) {
        const backlinks = vaultIndexInstance.getBacklinks(entry.path);
        const mentioners = vaultIndexInstance.getMentionedBy(entry.path);
        if (backlinks.length === 0 && mentioners.length === 0 && entry.links.length === 0) {
          orphanCount++;
        }
      }

      // Most connected nodes
      const connectionScores = allEntries
        .map((e) => ({
          path: e.path,
          connections: vaultIndexInstance!.getBacklinks(e.path).length +
            e.links.length +
            e.mentionsPeople.length + e.mentionsProjects.length + e.mentionsTopics.length +
            vaultIndexInstance!.getMentionedBy(e.path).length,
        }))
        .sort((a, b) => b.connections - a.connections)
        .slice(0, 5);

      let result = `Knowledge Graph Stats\n`;
      result += `Total notes: ${allEntries.length}\n`;
      result += `Total typed relationships: ${totalMentions}\n`;
      result += `Orphan notes: ${orphanCount}\n\n`;
      result += `Entity counts by type:\n`;
      for (const [type, count] of Array.from(typeCounts.entries()).sort((a, b) => b[1] - a[1])) {
        result += `  ${type}: ${count}\n`;
      }
      result += `\nMost connected nodes:\n`;
      for (const node of connectionScores) {
        const basename = node.path.split("/").pop()?.replace(/\.md$/, "") || node.path;
        result += `  ${basename} (${node.path}): ${node.connections} connections\n`;
      }
      return result;
    }
    case "vault_entity_search": {
      if (!input.entity) throw new Error("entity required");
      if (!vaultIndexInstance) throw new Error("Vault index not available");
      const entity = input.entity;
      const results: string[] = [];

      // Search by exact path match in mentions_* fields
      const entityPath = entity.endsWith(".md") ? entity : entity + ".md";
      const mentioners = vaultIndexInstance.getMentionedBy(entityPath);
      for (const p of mentioners) {
        if (!results.includes(p)) results.push(p);
      }

      // Also search by basename in mentions fields
      const entityBasename = entity.replace(/\.md$/, "").split("/").pop()?.toLowerCase() || "";
      for (const entry of vaultIndexInstance.getAllEntries()) {
        const allMentions = [
          ...entry.mentionsPeople,
          ...entry.mentionsProjects,
          ...entry.mentionsTopics,
        ];
        for (const m of allMentions) {
          const mBasename = m.replace(/\.md$/, "").split("/").pop()?.toLowerCase() || "";
          if (mBasename === entityBasename && !results.includes(entry.path)) {
            results.push(entry.path);
          }
        }

        // Also check direct links
        for (const link of entry.links) {
          const linkBasename = link.split("/").pop()?.toLowerCase() || "";
          if ((linkBasename === entityBasename || link.toLowerCase() === entity.toLowerCase()) &&
              !results.includes(entry.path)) {
            results.push(entry.path);
          }
        }
      }

      if (results.length === 0) return `No notes found mentioning "${entity}"`;
      return `Notes mentioning "${entity}":\n${results.map((p) => `- ${p}`).join("\n")}`;
    }

    // --- Write tools ---
    case "vault_create": {
      if (!input.path || !input.content) throw new Error("path and content required");
      // Create parent folders
      const folderPath = input.path.substring(0, input.path.lastIndexOf("/"));
      if (folderPath && !app.vault.getAbstractFileByPath(folderPath)) {
        // Create folders recursively
        const parts = folderPath.split("/");
        let current = "";
        for (const part of parts) {
          current = current ? `${current}/${part}` : part;
          if (!app.vault.getAbstractFileByPath(current)) {
            try { await app.vault.createFolder(current); } catch { /* exists */ }
          }
        }
      }
      if (app.vault.getAbstractFileByPath(input.path)) {
        throw new Error(`File already exists: ${input.path}`);
      }
      await app.vault.create(input.path, input.content);
      return `Created ${input.path}`;
    }
    case "vault_edit": {
      if (!input.path || !input.old_text || !input.new_text) throw new Error("path, old_text, and new_text required");
      const file = app.vault.getAbstractFileByPath(input.path);
      if (!(file instanceof TFile)) throw new Error(`File not found: ${input.path}`);
      const content = await app.vault.read(file);
      if (!content.includes(input.old_text)) throw new Error("old_text not found in file");
      const updated = content.replace(input.old_text, input.new_text);
      await app.vault.modify(file, updated);
      return `Edited ${input.path}`;
    }
    case "vault_append": {
      if (!input.path || !input.content) throw new Error("path and content required");
      const file = app.vault.getAbstractFileByPath(input.path);
      if (!(file instanceof TFile)) throw new Error(`File not found: ${input.path}`);
      const existing = await app.vault.read(file);
      await app.vault.modify(file, existing + "\n" + input.content);
      return `Appended to ${input.path}`;
    }
    case "daily_append": {
      if (!input.section || !input.content) throw new Error("section and content required");
      await appendToDailySection(app, input.content, input.section, settings);
      return `Appended to daily note section: ${input.section}`;
    }
    case "vault_property_set": {
      if (!input.path || !input.name || !input.value) throw new Error("path, name, and value required");
      if (cli.isAvailable()) {
        cli.propertySet(input.path, input.name, input.value, input.type);
        return `Set ${input.name} = ${input.value} on ${input.path}`;
      }
      // Fallback: manual frontmatter edit
      const file = app.vault.getAbstractFileByPath(input.path);
      if (!(file instanceof TFile)) throw new Error(`File not found: ${input.path}`);
      const content = await app.vault.read(file);
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const fmBlock = fmMatch[1];
        const keyRegex = new RegExp(`^${input.name}:.*$`, "m");
        const newLine = `${input.name}: ${input.value}`;
        const updatedFm = keyRegex.test(fmBlock)
          ? fmBlock.replace(keyRegex, newLine)
          : fmBlock + "\n" + newLine;
        const updated = content.replace(fmMatch[0], `---\n${updatedFm}\n---`);
        await app.vault.modify(file, updated);
      } else {
        const fm = `---\n${input.name}: ${input.value}\n---\n\n`;
        await app.vault.modify(file, fm + content);
      }
      return `Set ${input.name} = ${input.value} on ${input.path}`;
    }
    case "vault_rename": {
      if (!input.path || !input.new_name) throw new Error("path and new_name required");
      const file = app.vault.getAbstractFileByPath(input.path);
      if (!(file instanceof TFile)) throw new Error(`File not found: ${input.path}`);
      const folder = input.path.substring(0, input.path.lastIndexOf("/"));
      const newPath = folder ? `${folder}/${input.new_name}.md` : `${input.new_name}.md`;
      await app.vault.rename(file, newPath);
      return `Renamed to ${newPath}`;
    }
    case "vault_move": {
      if (!input.path || !input.to) throw new Error("path and to required");
      const file = app.vault.getAbstractFileByPath(input.path);
      if (!(file instanceof TFile)) throw new Error(`File not found: ${input.path}`);
      // Create destination folder if needed
      if (!app.vault.getAbstractFileByPath(input.to)) {
        try { await app.vault.createFolder(input.to); } catch { /* exists */ }
      }
      const newPath = `${input.to}/${file.name}`;
      await app.vault.rename(file, newPath);
      return `Moved to ${newPath}`;
    }
    case "vault_delete": {
      if (!input.path) throw new Error("path required");
      const file = app.vault.getAbstractFileByPath(input.path);
      if (!(file instanceof TFile)) throw new Error(`File not found: ${input.path}`);
      await app.vault.trash(file, false);
      return `Deleted ${input.path}`;
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
