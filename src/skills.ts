import { App, Notice, TFile, TFolder, parseYaml, moment } from "obsidian";
import { OpenBrainSettings } from "./settings";
import { runChat } from "./chatEngine";

export interface PostAction {
  type: "create_note" | "append_to_daily" | "replace_in_daily" | "open_note" | "backlink_chat";
  path?: string;
  section?: string;
  content?: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  input: "audio" | "text" | "auto";
  audioMode: "transcribe_only" | "transcribe_and_analyze";
  tools: { write?: boolean; cli?: boolean };
  autoPrompt?: string;
  trigger?: string;
  postActions: PostAction[];
  dailyNoteSection?: string;
  requiresPerson?: boolean;
  systemPrompt: string;
  filePath: string;
  dayMode?: "work" | "weekend";
  finishing?: boolean;
  slashCommand?: string;
}

/**
 * Parse a skill markdown file into a Skill object.
 * Format: YAML frontmatter between --- delimiters, then markdown body.
 */
export function parseSkillFile(content: string, filePath: string): Skill | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = parseYaml(match[1]);
  if (!frontmatter || !frontmatter.name) return null;

  const body = match[2].trim();

  const postActions: PostAction[] = [];
  if (Array.isArray(frontmatter.post_actions)) {
    for (const action of frontmatter.post_actions) {
      if (action.create_note) {
        postActions.push({
          type: "create_note",
          path: action.create_note.path || action.create_note,
          content: action.create_note.content,
        });
      } else if (action.append_to_daily) {
        postActions.push({
          type: "append_to_daily",
          section: action.append_to_daily.section,
          content: action.append_to_daily.content,
        });
      } else if (action.replace_in_daily) {
        postActions.push({
          type: "replace_in_daily",
          section: action.replace_in_daily.section,
          content: action.replace_in_daily.content,
        });
      }
    }
  }

  const id = filePath.replace(/\.md$/, "").replace(/[^a-zA-Z0-9]/g, "-");

  return {
    id,
    name: frontmatter.name,
    description: frontmatter.description || "",
    input: frontmatter.input || "auto",
    audioMode: frontmatter.audio_mode || "transcribe_and_analyze",
    tools: frontmatter.tools || {},
    autoPrompt: frontmatter.auto_prompt,
    trigger: frontmatter.trigger,
    postActions,
    dailyNoteSection: frontmatter.daily_note_section,
    requiresPerson: frontmatter.requires_person === true,
    systemPrompt: body,
    filePath,
    dayMode: frontmatter.day_mode || undefined,
    finishing: frontmatter.finishing === true || frontmatter.finishing === "true",
    slashCommand: typeof frontmatter.slash_command === "string" ? frontmatter.slash_command : undefined,
  };
}

/**
 * Scan a vault folder for skill markdown files and parse them.
 */
export async function loadSkills(app: App, folderPath: string): Promise<Skill[]> {
  const skills: Skill[] = [];
  const folder = app.vault.getAbstractFileByPath(folderPath);
  if (!(folder instanceof TFolder)) return skills;

  for (const child of folder.children) {
    if (child instanceof TFile && child.extension === "md") {
      const content = await app.vault.read(child);
      const skill = parseSkillFile(content, child.path);
      if (skill) skills.push(skill);
    }
  }

  return skills;
}

/**
 * Substitute template variables in a string.
 */
function substituteVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] || "");
}

/**
 * Extract a title from Claude's response.
 * Looks for first markdown heading, falls back to first non-empty line.
 */
function extractTitle(response: string): string {
  // Prefer a markdown heading (skip tool-use chatter and preamble)
  const headings = response.match(/^#{1,3}\s+(.+)/gm);
  if (headings) {
    // Pick the first heading that looks like a real title (not "Using vault_read...")
    for (const h of headings) {
      const text = h.replace(/^#+\s+/, "").replace(/[/:*?"<>|]/g, "").trim();
      if (text.length > 2 && !text.startsWith("Using ")) {
        return text.slice(0, 80);
      }
    }
  }

  // Fallback: first non-empty line that isn't tool chatter
  const lines = response.split("\n").filter((l) => {
    const t = l.trim();
    return t && !t.startsWith("*Using ") && !t.startsWith("Let me ");
  });
  if (lines.length > 0) {
    return lines[0].slice(0, 60).replace(/[/:*?"<>|]/g, "").trim();
  }

  return "Untitled";
}

/**
 * Find today's daily note path. Checks periodic-notes plugin first
 * (community plugin), then falls back to built-in daily-notes config.
 */
export function getDailyNotePath(app: App, settings?: OpenBrainSettings): string {
  const folder = (settings?.dailyNoteFolder || "")
    .replace("{{YYYY}}", moment().format("YYYY"))
    .replace("{{MM}}", moment().format("MM"))
    .replace("{{DD}}", moment().format("DD"));
  const dateStr = moment().format(settings?.dailyNoteFormat || "YYYY-MM-DD");
  return folder ? `${folder}/${dateStr}.md` : `${dateStr}.md`;
}

/**
 * Get paths for recent daily notes (last N days).
 */
export function getRecentDailyNotePaths(app: App, days: number, settings?: OpenBrainSettings): string[] {
  const paths: string[] = [];
  const folderTemplate = settings?.dailyNoteFolder || "";
  const format = settings?.dailyNoteFormat || "YYYY-MM-DD";

  for (let i = 1; i <= days; i++) {
    const d = moment().subtract(i, "days");
    const folder = folderTemplate
      .replace("{{YYYY}}", d.format("YYYY"))
      .replace("{{MM}}", d.format("MM"))
      .replace("{{DD}}", d.format("DD"));
    const dateStr = d.format(format);
    const path = folder ? `${folder}/${dateStr}.md` : `${dateStr}.md`;
    paths.push(path);
  }

  return paths;
}

/**
 * Insert content under a heading in a markdown document.
 * If the heading doesn't exist, appends it at the end.
 */
function insertUnderHeading(doc: string, heading: string, content: string, replace: boolean): string {
  const headingLevel = (heading.match(/^#+/) || ["##"])[0];
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `(${escapedHeading}\\s*\\n)([\\s\\S]*?)(?=\\n${headingLevel.replace(/#/g, "\\#")}\\s|$)`,
    "m"
  );

  const match = doc.match(regex);
  if (match) {
    if (replace) {
      return doc.replace(regex, `$1${content}\n`);
    }
    return doc.replace(regex, `$1$2${content}\n`);
  }

  return `${doc.trimEnd()}\n\n${heading}\n${content}\n`;
}

export interface PostActionResult {
  success: boolean;
  message: string;
}

/**
 * Execute post-actions after a skill completes.
 */
export async function executePostActions(
  app: App,
  actions: PostAction[],
  response: string,
  settings?: OpenBrainSettings,
  extraVars?: Record<string, string>
): Promise<PostActionResult[]> {
  const results: PostActionResult[] = [];
  const title = extractTitle(response);
  const date = moment().format("YYYY-MM-DD");

  const vars: Record<string, string> = {
    date,
    title,
    response,
    note_path: "",
    meetings_folder: settings?.meetingsFolder || "OpenBrain/meetings",
    reviews_folder: settings?.reviewsFolder || "OpenBrain/reviews",
    projects_folder: settings?.projectsFolder || "OpenBrain/projects",
    people_folder: settings?.peopleFolder || "OpenBrain/people",
    one_on_one_folder: settings?.oneOnOneFolder || "OpenBrain/meetings/1-on-1",
    ...extraVars,
  };

  for (const action of actions) {
    try {
      if (action.type === "create_note" && action.path) {
        const notePath = substituteVars(action.path, vars);
        const noteContent = action.content ? substituteVars(action.content, vars) : response;

        const folderPath = notePath.split("/").slice(0, -1).join("/");
        if (folderPath) {
          const folder = app.vault.getAbstractFileByPath(folderPath);
          if (!folder) {
            await app.vault.createFolder(folderPath);
          }
        }

        const existing = app.vault.getAbstractFileByPath(notePath);
        if (existing instanceof TFile) {
          await app.vault.modify(existing, noteContent);
          results.push({ success: true, message: `Updated: ${notePath}` });
        } else {
          await app.vault.create(notePath, noteContent);
          results.push({ success: true, message: `Created: ${notePath}` });
        }

        vars.note_path = notePath.replace(/\.md$/, "");
      }

      if (
        (action.type === "append_to_daily" || action.type === "replace_in_daily") &&
        action.section
      ) {
        const dailyPath = getDailyNotePath(app, settings);
        let dailyFile = app.vault.getAbstractFileByPath(dailyPath);

        if (!dailyFile) {
          const folderPath = dailyPath.split("/").slice(0, -1).join("/");
          if (folderPath) {
            const folder = app.vault.getAbstractFileByPath(folderPath);
            if (!folder) await app.vault.createFolder(folderPath);
          }
          await app.vault.create(dailyPath, `# ${moment().format("YYYY-MM-DD")}\n`);
          dailyFile = app.vault.getAbstractFileByPath(dailyPath);
        }

        if (dailyFile instanceof TFile) {
          const content = await app.vault.read(dailyFile);
          const insertContent = substituteVars(action.content || "{{response}}", vars);
          const updated = insertUnderHeading(
            content,
            action.section,
            insertContent,
            action.type === "replace_in_daily"
          );
          await app.vault.modify(dailyFile, updated);
          results.push({ success: true, message: "Updated daily note" });
        }
      }

      if (action.type === "open_note") {
        if (vars.note_path) {
          try {
            const file = app.vault.getAbstractFileByPath(vars.note_path);
            if (file && file instanceof TFile) {
              const leaf = app.workspace.getLeaf("tab");
              await leaf.openFile(file);
              results.push({ success: true, message: `Opened ${vars.note_path}` });
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ success: false, message: `Failed to open note: ${msg}` });
          }
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ success: false, message: `Post-action failed: ${message}` });
    }
  }

  return results;
}

/**
 * Run a skill in the background (for hooks/automation).
 * Spawns CLI, collects response, executes post-actions, shows notification.
 */
export async function runSkillInBackground(
  app: App,
  settings: OpenBrainSettings,
  skill: Skill,
  contextNote?: string
): Promise<void> {
  const prompt = skill.autoPrompt || `Run the ${skill.name} skill.`;

  // Build context from recent daily notes if available
  let recentContext = "";
  const recentPaths = getRecentDailyNotePaths(app, 3, settings);
  for (const path of recentPaths) {
    const file = app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      const content = await app.vault.read(file);
      const fileName = path.split("/").pop() || path;
      recentContext += `\n\n--- Recent daily note: ${fileName} ---\n${content}`;
    }
  }

  const fullContext = (contextNote || "") + recentContext;
  const folderContext = [
    `\nConfigured vault folders:`,
    `- Meetings: ${settings.meetingsFolder || "OpenBrain/meetings"}`,
    `- 1:1s: ${settings.oneOnOneFolder || "OpenBrain/meetings/1-on-1"}`,
    `- Reviews: ${settings.reviewsFolder || "OpenBrain/reviews"}`,
    `- Projects: ${settings.projectsFolder || "OpenBrain/projects"}`,
    `- People: ${settings.peopleFolder || "OpenBrain/people"}`,
  ].join("\n");
  const systemPrompt = skill.systemPrompt + (fullContext ? `\n\n---\nContext:\n${fullContext}` : "") + folderContext;

  new Notice(`OpenBrain: Running ${skill.name}...`);

  let response = "";

  await runChat(app, settings, {
    messages: [{ role: "user", content: prompt }],
    systemPrompt,
    allowWrite: skill.tools.write ?? false,
    useTools: true,
    onText: (text) => { response += text; },
    onToolStart: () => { /* background — no UI */ },
    onToolEnd: () => { /* background — no UI */ },
    onError: (err) => {
      new Notice(`OpenBrain: ${skill.name} failed — ${err}`, 8000);
    },
    onDone: () => { /* handled below */ },
  });

  if (response.trim() && skill.postActions.length > 0) {
    const results = await executePostActions(app, skill.postActions, response, settings);
    const failures = results.filter((r) => !r.success);
    if (failures.length > 0) {
      new Notice(`OpenBrain: ${skill.name} — some post-actions failed`, 5000);
    } else {
      new Notice(`OpenBrain: ${skill.name} complete`, 3000);
    }
  } else if (response.trim()) {
    new Notice(`OpenBrain: ${skill.name} complete`, 3000);
  }
}
