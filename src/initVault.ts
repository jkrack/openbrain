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
  // Create the top-level OpenBrain folder first
  await ensureFolder(app, "OpenBrain");

  // Create all subfolders in parallel (they share the same parent)
  const folders = [
    settings.chatFolder || "OpenBrain/chats",
    settings.skillsFolder || "OpenBrain/skills",
    "OpenBrain/templates",
    "OpenBrain/people",
  ];

  for (const folder of folders) {
    await ensureFolder(app, folder);
  }

  // Now seed files (folders are guaranteed to exist)
  const results = await Promise.allSettled([
    initChatFolder(app, settings.chatFolder || "OpenBrain/chats"),
    initTemplates(app),
    initPeopleFolder(app),
    createGettingStartedNote(app),
  ]);

  // Log any failures but don't crash
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("OpenBrain: vault init error:", result.reason);
    }
  }
}
