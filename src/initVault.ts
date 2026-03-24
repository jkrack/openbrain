import { App } from "obsidian";
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
}
