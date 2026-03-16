import { App, TFile, Notice, moment } from "obsidian";
import { Message } from "./claude";
import { OpenBrainSettings } from "./settings";
import { createFromTemplate } from "./templates";
import * as cli from "./obsidianCli";

// ── Interfaces ──────────────────────────────────────────────────────────

export interface ChatMeta {
  type: "openbrain-chat";
  formatVersion: number;
  created: string;
  updated: string;
  skill: string;
  sessionId: string;
  messageCount: number;
  hasAudio: boolean;
  title: string;
  tags: string[];
}

export interface ChatFile {
  path: string;
  frontmatter: ChatMeta;
  messages: Message[];
}

// ── Helpers ─────────────────────────────────────────────────────────────

function stripMarkdown(text: string): string {
  return text
    .replace(/[#*_`~\[\]()>!]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── 1. generateChatTitle ────────────────────────────────────────────────

export function generateChatTitle(messages: Message[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "Untitled chat";

  const content = firstUser.content.trim();

  // Voice message fallback
  if (!content || content.startsWith("\uD83C\uDFA4") || content.startsWith("\uD83C\uDF99")) {
    const d = firstUser.timestamp instanceof Date ? firstUser.timestamp : new Date();
    return `Voice chat \u2014 ${formatDate(d)}`;
  }

  const clean = stripMarkdown(content);
  return clean.length > 60 ? clean.slice(0, 60).trimEnd() + "\u2026" : clean;
}

// ── 2. generateChatFilename ─────────────────────────────────────────────

export function generateChatFilename(): string {
  const d = new Date();
  const suffix = Math.random().toString(36).slice(2, 5);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${suffix}.md`;
}

// ── 3. serializeChat ────────────────────────────────────────────────────

export function serializeChat(messages: Message[], meta: ChatMeta): string {
  // Build YAML frontmatter with snake_case keys
  const yamlLines = [
    "---",
    `type: "${meta.type}"`,
    `format_version: ${meta.formatVersion}`,
    `created: "${meta.created}"`,
    `updated: "${meta.updated}"`,
    `skill: "${meta.skill}"`,
    `session_id: "${meta.sessionId}"`,
    `message_count: ${meta.messageCount}`,
    `has_audio: ${meta.hasAudio}`,
    `title: "${meta.title.replace(/"/g, '\\"')}"`,
    `tags: [${meta.tags.map((t) => `"${t}"`).join(", ")}]`,
    "---",
  ];

  const messageParts = messages.map((m) => {
    const ts = m.timestamp instanceof Date ? m.timestamp.getTime() : new Date(m.timestamp).getTime();
    const audio = m.isAudio ? "true" : "false";
    const roleLabel = m.role === "user" ? "User" : "Assistant";
    return `<!-- msg:${m.id}:${m.role}:${ts}:${audio} -->\n### ${roleLabel}\n${m.content}`;
  });

  return yamlLines.join("\n") + "\n\n" + messageParts.join("\n\n") + "\n";
}

// ── 4. parseChat ────────────────────────────────────────────────────────

export function parseChat(content: string, path: string): ChatFile | { error: string } {
  // Split frontmatter from body
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) {
    return { error: "Missing frontmatter" };
  }

  const fmBlock = fmMatch[1];
  const body = content.slice(fmMatch[0].length);

  // Simple YAML parsing for known structure
  const get = (key: string): string => {
    const m = fmBlock.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
    return m ? m[1].trim() : "";
  };

  const unquote = (s: string): string => s.replace(/^["']|["']$/g, "");

  const formatVersion = parseInt(get("format_version"), 10);
  if (formatVersion > 1) {
    return { error: `Unsupported format_version: ${formatVersion}` };
  }

  // Parse tags array
  const tagsRaw = get("tags");
  const tags: string[] = [];
  const tagPattern = /"([^"]*)"/g;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagPattern.exec(tagsRaw)) !== null) {
    tags.push(tagMatch[1]);
  }

  const meta: ChatMeta = {
    type: unquote(get("type")) as "openbrain-chat",
    formatVersion: formatVersion || 1,
    created: unquote(get("created")),
    updated: unquote(get("updated")),
    skill: unquote(get("skill")),
    sessionId: unquote(get("session_id")),
    messageCount: parseInt(get("message_count"), 10) || 0,
    hasAudio: get("has_audio") === "true",
    title: unquote(get("title")),
    tags,
  };

  // Parse messages from body
  const messages: Message[] = [];
  const msgRegex = /<!-- msg:([^:]+):([^:]+):(\d+):(true|false) -->\n### (?:User|Assistant)\n([\s\S]*?)(?=\n\n<!-- msg:|$)/g;
  let match: RegExpExecArray | null;

  while ((match = msgRegex.exec(body)) !== null) {
    messages.push({
      id: match[1],
      role: match[2] as "user" | "assistant",
      content: match[5].trimEnd(),
      isAudio: match[4] === "true",
      timestamp: new Date(parseInt(match[3], 10)),
    });
  }

  return { path, frontmatter: meta, messages };
}

// ── 5. saveChat ─────────────────────────────────────────────────────────

export async function saveChat(
  app: App,
  path: string,
  messages: Message[],
  meta: ChatMeta
): Promise<string> {
  try {
    const content = serializeChat(messages, meta);

    // Create parent folders if missing
    const folderPath = path.substring(0, path.lastIndexOf("/"));
    if (folderPath && !app.vault.getAbstractFileByPath(folderPath)) {
      const parts = folderPath.split("/");
      let current = "";
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        if (!app.vault.getAbstractFileByPath(current)) {
          await app.vault.createFolder(current);
        }
      }
    }

    const existing = app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await app.vault.modify(existing, content);
    } else {
      await app.vault.create(path, content);
    }

    return path;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    new Notice(`Failed to save chat: ${message}`);
    throw err;
  }
}

// ── 6. loadChat ─────────────────────────────────────────────────────────

export async function loadChat(app: App, path: string): Promise<ChatFile | null> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return null;

  try {
    const content = await app.vault.read(file);
    const result = parseChat(content, path);
    if ("error" in result) {
      console.warn(`OpenBrain: failed to parse ${path}: ${result.error}`);
      return null;
    }
    return result;
  } catch { /* expected — file may be unreadable or corrupt */
    return null;
  }
}

// ── 7. listRecentChats ──────────────────────────────────────────────────

export function listRecentChats(app: App, folder: string, limit = 10): ChatMeta[] {
  const results: ChatMeta[] = [];

  const allFiles = app.vault.getMarkdownFiles();
  for (const file of allFiles) {
    if (!file.path.startsWith(folder)) continue;

    const cache = app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    if (!fm || fm.type !== "openbrain-chat") continue;

    results.push({
      type: fm.type,
      formatVersion: fm.format_version ?? 1,
      created: fm.created ?? "",
      updated: fm.updated ?? "",
      skill: fm.skill ?? "",
      sessionId: fm.session_id ?? "",
      messageCount: fm.message_count ?? 0,
      hasAudio: fm.has_audio ?? false,
      title: fm.title ?? "",
      tags: fm.tags ?? [],
    });
  }

  // Sort by updated descending
  results.sort((a, b) => {
    if (a.updated > b.updated) return -1;
    if (a.updated < b.updated) return 1;
    return 0;
  });

  return results.slice(0, limit);
}

// ── 8. initChatFolder ───────────────────────────────────────────────────

const BASE_CONTENT = `filters: 'type == "openbrain-chat"'
properties:
  title:
    displayName: Title
  created:
    displayName: Created
  skill:
    displayName: Skill
  message_count:
    displayName: Messages
  has_audio:
    displayName: Audio
views:
  - type: table
    name: Chat History
    order:
      - title
      - created
      - skill
      - message_count
      - has_audio
`;

export async function initChatFolder(app: App, folder: string): Promise<void> {
  // Create folder (and parents) if missing
  if (!app.vault.getAbstractFileByPath(folder)) {
    const parts = folder.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!app.vault.getAbstractFileByPath(current)) {
        await app.vault.createFolder(current);
      }
    }
  }

  // Create Base file if missing (never overwrite).
  // Use adapter.exists() + adapter.write() since vault API doesn't handle .base files.
  const basePath = `${folder}/Chat History.base`;
  const adapter = app.vault.adapter as { exists?: (path: string) => Promise<boolean>; write?: (path: string, data: string) => Promise<void> };
  if (adapter.exists && !(await adapter.exists(basePath))) {
    await adapter.write?.(basePath, BASE_CONTENT);
  }
}

// ── 9. linkInDailyNote ─────────────────────────────────────────────────

/**
 * Add a [[wikilink]] to a section of today's daily note.
 * Creates the daily note from template if it doesn't exist.
 * Tries Obsidian CLI first, falls back to vault API.
 * Skips if the link is already present (idempotent).
 */
export async function linkInDailyNote(
  app: App,
  filePath: string,
  section: string,
  displayTitle?: string,
  settings?: OpenBrainSettings
): Promise<void> {
  const linkTarget = filePath.replace(/\.md$/, "");
  const link = displayTitle
    ? `- [[${linkTarget}|${displayTitle}]]`
    : `- [[${linkTarget}]]`;

  return linkInDailyNoteVaultApi(app, linkTarget, link, section, settings);
}

/** Vault API for section-specific daily note linking. */
async function linkInDailyNoteVaultApi(
  app: App,
  linkTarget: string,
  link: string,
  section: string,
  settings?: OpenBrainSettings
): Promise<void> {
  const dailyPath = getDailyPath(app, settings);
  let file = app.vault.getAbstractFileByPath(dailyPath);

  if (!(file instanceof TFile)) {
    await createFromTemplate(app, "Daily Note.md", dailyPath);
    file = app.vault.getAbstractFileByPath(dailyPath);
  }

  if (!(file instanceof TFile)) return;

  const content = await app.vault.read(file);
  if (content.includes(`[[${linkTarget}`)) return;

  // Find the section and insert after it
  const sectionRegex = new RegExp(`^##\\s+\\**${escapeRegex(section)}\\**\\s*$`, "m");
  const match = content.match(sectionRegex);

  if (match && match.index !== undefined) {
    const insertPos = match.index + match[0].length;
    const before = content.slice(0, insertPos);
    const after = content.slice(insertPos);

    const separatorMatch = after.match(/^\n---\n/);
    if (separatorMatch) {
      const updated = before + "\n---\n" + link + "\n" + after.slice(separatorMatch[0].length);
      await app.vault.modify(file, updated);
    } else {
      const updated = before + "\n" + link + "\n" + after;
      await app.vault.modify(file, updated);
    }
  } else {
    const updated = content.trimEnd() + `\n\n## ${section}\n${link}\n`;
    await app.vault.modify(file, updated);
  }
}

/**
 * Append plain text (not a wikilink) to a section of today's daily note.
 * Creates the daily note from template if it doesn't exist.
 */
export async function appendToDailySection(
  app: App,
  text: string,
  section: string,
  settings?: OpenBrainSettings
): Promise<void> {
  const dailyPath = getDailyPath(app, settings);
  let file = app.vault.getAbstractFileByPath(dailyPath);

  if (!(file instanceof TFile)) {
    await createFromTemplate(app, "Daily Note.md", dailyPath);
    file = app.vault.getAbstractFileByPath(dailyPath);
  }

  if (!(file instanceof TFile)) return;

  const content = await app.vault.read(file);
  const sectionRegex = new RegExp(`^##\\s+\\**${escapeRegex(section)}\\**\\s*$`, "m");
  const match = content.match(sectionRegex);

  if (match && match.index !== undefined) {
    const insertPos = match.index + match[0].length;
    const before = content.slice(0, insertPos);
    const after = content.slice(insertPos);

    const separatorMatch = after.match(/^\n---\n/);
    if (separatorMatch) {
      const updated = before + "\n---\n" + text + "\n" + after.slice(separatorMatch[0].length);
      await app.vault.modify(file, updated);
    } else {
      const updated = before + "\n" + text + "\n" + after;
      await app.vault.modify(file, updated);
    }
  } else {
    const updated = content.trimEnd() + `\n\n## ${section}\n${text}\n`;
    await app.vault.modify(file, updated);
  }
}

/** Exported so other modules can resolve the daily note path. */
export { getDailyPath };

function getDailyPath(app: App, settings?: OpenBrainSettings): string {
  // Use OpenBrain settings if configured
  if (settings?.dailyNoteFolder) {
    const now = moment();
    // Resolve date variables in folder path
    const folder = settings.dailyNoteFolder
      .replace(/\{\{YYYY\}\}/g, now.format("YYYY"))
      .replace(/\{\{MM\}\}/g, now.format("MM"))
      .replace(/\{\{DD\}\}/g, now.format("DD"));
    const format = settings.dailyNoteFormat || "YYYY-MM-DD";
    const filename = now.format(format);
    return `${folder}/${filename}.md`;
  }

  // Try Obsidian CLI
  const cliPath = cli.dailyPath();
  if (cliPath) return cliPath;

  // Check periodic-notes plugin (internal API — not publicly typed)
  const appRecord = app as unknown as Record<string, unknown>;
  const periodicNotesPlugin = (appRecord.plugins as Record<string, unknown> | undefined);
  const periodicPlugins = periodicNotesPlugin?.plugins as Record<string, Record<string, unknown>> | undefined;
  const periodicNotes = periodicPlugins?.["periodic-notes"];
  const periodicSettings = periodicNotes?.settings as Record<string, Record<string, unknown>> | undefined;
  const dailySettings = periodicSettings?.daily;
  if (dailySettings?.enabled) {
    const folder = (dailySettings.folder as string) || "";
    const format = (dailySettings.format as string) || "YYYY-MM-DD";
    const dateStr = moment().format(format);
    return folder ? `${folder}/${dateStr}.md` : `${dateStr}.md`;
  }

  // Check core daily-notes plugin (internal API — not publicly typed)
  const internalPlugins = appRecord.internalPlugins as Record<string, unknown> | undefined;
  const internalPluginMap = internalPlugins?.plugins as Record<string, Record<string, unknown>> | undefined;
  const dailyNotes = internalPluginMap?.["daily-notes"];
  if (dailyNotes?.enabled) {
    const instance = dailyNotes.instance as Record<string, unknown> | undefined;
    const config = (instance?.options ?? {}) as Record<string, string>;
    const folder = config.folder || "";
    const format = config.format || "YYYY-MM-DD";
    const dateStr = moment().format(format);
    return folder ? `${folder}/${dateStr}.md` : `${dateStr}.md`;
  }

  // Default
  return `${moment().format("YYYY-MM-DD")}.md`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
