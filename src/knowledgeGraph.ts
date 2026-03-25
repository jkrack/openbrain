import { App, TFile } from "obsidian";
import { VaultIndex, IndexEntry } from "./vaultIndex";

export interface InferredRelationship {
  type: "people" | "projects" | "topics";
  path: string;       // entity path e.g. "People/Scott.md"
  confidence: "linked" | "mentioned";
}

/**
 * Infer typed relationships for a file based on its links and content.
 * - "linked" confidence: explicit wikilinks to typed entities
 * - "mentioned" confidence: basename matches in content (for LLM review)
 */
export function inferRelationships(
  app: App,
  filePath: string,
  vaultIndex: VaultIndex
): InferredRelationship[] {
  const entry = vaultIndex.getEntry(filePath);
  if (!entry) return [];

  const results: InferredRelationship[] = [];
  const seen = new Set<string>();

  // 1. Check outgoing links against typed entities
  for (const link of entry.links) {
    const targetPath = link.endsWith(".md") ? link : link + ".md";
    const target = vaultIndex.getEntry(targetPath);
    if (!target) continue;

    if (target.frontmatterType === "person") {
      if (!seen.has(targetPath)) {
        seen.add(targetPath);
        results.push({ type: "people", path: targetPath, confidence: "linked" });
      }
    } else if (target.frontmatterType === "project") {
      if (!seen.has(targetPath)) {
        seen.add(targetPath);
        results.push({ type: "projects", path: targetPath, confidence: "linked" });
      }
    }
  }

  // 2. Scan content for basename mentions of known entities
  const file = app.vault.getAbstractFileByPath(filePath);
  if (file instanceof TFile) {
    const cache = app.metadataCache.getFileCache(file);
    const content = cache ? "" : ""; // We only use metadata-based detection here

    // Check people
    for (const person of vaultIndex.getByType("person")) {
      if (person.path === filePath) continue;
      if (seen.has(person.path)) continue;

      // Check if the person's basename appears in the file's headings or tags
      const bn = person.basename.toLowerCase();
      const inHeadings = entry.headings.some((h) => h.toLowerCase().includes(bn));
      const inAliases = person.aliases.some((a) =>
        entry.headings.some((h) => h.toLowerCase().includes(a.toLowerCase()))
      );
      if (inHeadings || inAliases) {
        seen.add(person.path);
        results.push({ type: "people", path: person.path, confidence: "mentioned" });
      }
    }

    // Check projects
    for (const project of vaultIndex.getByType("project")) {
      if (project.path === filePath) continue;
      if (seen.has(project.path)) continue;

      const bn = project.basename.toLowerCase();
      const inHeadings = entry.headings.some((h) => h.toLowerCase().includes(bn));
      if (inHeadings) {
        seen.add(project.path);
        results.push({ type: "projects", path: project.path, confidence: "mentioned" });
      }
    }
  }

  return results;
}

/**
 * Apply inferred relationships to a file's frontmatter.
 * Only writes "linked" confidence relationships (explicit wikilinks).
 * Returns true if frontmatter was modified.
 */
export async function applyRelationships(
  app: App,
  filePath: string,
  relationships: InferredRelationship[]
): Promise<boolean> {
  // Only auto-write "linked" confidence
  const linked = relationships.filter((r) => r.confidence === "linked");
  if (linked.length === 0) return false;

  const file = app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) return false;

  const content = await app.vault.read(file);

  const people = linked
    .filter((r) => r.type === "people")
    .map((r) => `"[[${r.path.replace(/\.md$/, "")}]]"`);
  const projects = linked
    .filter((r) => r.type === "projects")
    .map((r) => `"[[${r.path.replace(/\.md$/, "")}]]"`);
  const topics = linked
    .filter((r) => r.type === "topics")
    .map((r) => `"[[${r.path.replace(/\.md$/, "")}]]"`);

  // Build new frontmatter lines
  const newProps: string[] = [];
  if (people.length > 0) newProps.push(`mentions_people: [${people.join(", ")}]`);
  if (projects.length > 0) newProps.push(`mentions_projects: [${projects.join(", ")}]`);
  if (topics.length > 0) newProps.push(`mentions_topics: [${topics.join(", ")}]`);

  if (newProps.length === 0) return false;

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  let updated: string;

  if (fmMatch) {
    let fmBlock = fmMatch[1];

    // Update or add each property
    for (const prop of newProps) {
      const key = prop.split(":")[0];
      const keyRegex = new RegExp(`^${key}:.*$`, "m");
      if (keyRegex.test(fmBlock)) {
        fmBlock = fmBlock.replace(keyRegex, prop);
      } else {
        fmBlock = fmBlock + "\n" + prop;
      }
    }

    updated = content.replace(fmMatch[0], `---\n${fmBlock}\n---`);
  } else {
    const fm = `---\n${newProps.join("\n")}\n---\n\n`;
    updated = fm + content;
  }

  if (updated !== content) {
    await app.vault.modify(file, updated);
    return true;
  }
  return false;
}
