import { App, TFile } from "obsidian";
import { OpenBrainSettings } from "./settings";
import { initChatFolder } from "./chatHistory";
import { initTemplates, createGettingStartedNote } from "./templates";
import { initPeopleFolder } from "./people";

/**
 * Ensure a folder path exists, creating parents as needed.
 * Safe to call even if the folder already exists.
 */
export async function ensureFolder(app: App, folderPath: string): Promise<void> {
  if (!folderPath) return;
  if (app.vault.getAbstractFileByPath(folderPath)) return;

  const parts = folderPath.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) {
      try {
        await app.vault.createFolder(current);
      } catch {
        // Folder may have been created by another concurrent call — safe to ignore
      }
    }
  }
}

/**
 * Initialize all OpenBrain vault folders and seed files.
 * Called once on plugin load (inside onLayoutReady).
 * Safe to call multiple times — idempotent.
 */
export async function initVault(app: App, settings: OpenBrainSettings): Promise<void> {
  // Create all folders (ensureFolder handles parents automatically)
  const folders = [
    settings.chatFolder || "OpenBrain/chats",
    settings.skillsFolder || "OpenBrain/skills",
    settings.templatesFolder || "OpenBrain/templates",
    settings.peopleFolder || "OpenBrain/people",
    settings.meetingsFolder || "OpenBrain/meetings",
    settings.oneOnOneFolder || "OpenBrain/meetings/1-on-1",
    settings.reviewsFolder || "OpenBrain/reviews",
    settings.projectsFolder || "OpenBrain/projects",
    settings.floatingRecorderOutputFolder || "OpenBrain/recordings",
  ];

  for (const folder of folders) {
    await ensureFolder(app, folder);
  }

  // Now seed files (folders are guaranteed to exist)
  const results = await Promise.allSettled([
    initChatFolder(app, settings.chatFolder || "OpenBrain/chats"),
    initTemplates(app, settings.templatesFolder || "OpenBrain/templates"),
    initPeopleFolder(app, settings.peopleFolder || "OpenBrain/people"),
    createGettingStartedNote(app),
  ]);

  // Log any failures but don't crash
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("OpenBrain: vault init error:", result.reason);
    }
  }

  // Migrate / seed day-aware system prompt files
  const workPath = "OpenBrain/system-prompt-work.md";
  const weekendPath = "OpenBrain/system-prompt-weekend.md";
  const genericPath = "OpenBrain/system-prompt.md";

  // If work prompt doesn't exist but generic does, copy generic → work
  if (!app.vault.getAbstractFileByPath(workPath)) {
    const genericFile = app.vault.getAbstractFileByPath(genericPath);
    if (genericFile instanceof TFile) {
      try {
        const genericContent = await app.vault.read(genericFile);
        await app.vault.create(workPath, genericContent);
      } catch {
        // ignore — folder may not be ready yet
      }
    }
  }

  // Seed weekend prompt if it doesn't exist
  if (!app.vault.getAbstractFileByPath(weekendPath)) {
    try {
      await app.vault.create(
        weekendPath,
        `You are OpenBrain, an AI assistant embedded in Obsidian. It's your user's day off.
Be warm, casual, and exploratory. Don't push tasks, meetings, or deadlines unless
asked. Suggest creative ideas, help with personal projects, or just have a
conversation. Use [[wikilinks]] when referencing notes. Use vault-relative paths only.
Search the vault before answering questions about it. Read files before editing them.`
      );
    } catch {
      // ignore
    }
  }
}
