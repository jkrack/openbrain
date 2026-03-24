import { App, Notice, TFile, moment } from "obsidian";
import { OpenBrainSettings } from "./settings";
import { loadPeople, getPersonMeetingFolder } from "./people";

/**
 * Run notification checks once on plugin load (after vault is ready).
 * Shows Notices for actionable items.
 */
export async function checkNotifications(app: App, settings: OpenBrainSettings): Promise<void> {
  const notices: string[] = [];

  // 1. Check for overdue tasks in daily note
  try {
    const now = moment();
    const dailyPath = getDailyNotePath(settings, now);
    const file = app.vault.getAbstractFileByPath(dailyPath);
    if (file instanceof TFile) {
      const content = await app.vault.cachedRead(file);
      const overdueTasks = (content.match(/- \[ \] .+/g) || []).length;
      if (overdueTasks > 5) {
        notices.push(`${overdueTasks} open tasks in today's daily note`);
      }
    }
  } catch { /* ignore */ }

  // 2. Check for stale 1:1s (no session in 14+ days)
  try {
    const people = await loadPeople(app, settings.peopleFolder);
    for (const person of people) {
      const folder = getPersonMeetingFolder(person.name, settings.oneOnOneFolder || "OpenBrain/meetings/1-on-1");
      const files = app.vault.getMarkdownFiles()
        .filter(f => f.path.startsWith(folder + "/"))
        .sort((a, b) => b.stat.mtime - a.stat.mtime);

      if (files.length > 0) {
        const lastMeeting = moment(files[0].stat.mtime);
        const daysSince = moment().diff(lastMeeting, "days");
        if (daysSince >= 14) {
          notices.push(`No 1:1 with ${person.name} in ${daysSince} days`);
        }
      }
    }
  } catch { /* ignore */ }

  // 3. Check if yesterday's EOD was filled
  try {
    const yesterday = moment().subtract(1, "day");
    const yesterdayPath = getDailyNotePath(settings, yesterday);
    const file = app.vault.getAbstractFileByPath(yesterdayPath);
    if (file instanceof TFile) {
      const content = await app.vault.cachedRead(file);
      const eodSection = content.match(/## \**End of day\**([\s\S]*?)(?=\n## |\n$)/);
      if (eodSection) {
        const eodContent = eodSection[1].trim();
        // Check if section is empty or just has the template placeholder
        if (!eodContent || eodContent === "---" || eodContent.includes("What shipped")) {
          notices.push("Yesterday's End of day section is empty");
        }
      }
    }
  } catch { /* ignore */ }

  // Show combined notice if there are items
  if (notices.length > 0) {
    new Notice(`OpenBrain:\n${notices.map(n => `\u2022 ${n}`).join("\n")}`, 10000);
  }
}

function getDailyNotePath(settings: OpenBrainSettings, date: ReturnType<typeof moment>): string {
  const folder = (settings.dailyNoteFolder || "Daily")
    .replace(/\{\{YYYY\}\}/g, date.format("YYYY"))
    .replace(/\{\{MM\}\}/g, date.format("MM"))
    .replace(/\{\{DD\}\}/g, date.format("DD"));
  const format = settings.dailyNoteFormat || "YYYY-MM-DD";
  return `${folder}/${date.format(format)}.md`;
}
