import { App } from "obsidian";

const PEOPLE_FOLDER = "OpenBrain/people";

export interface PersonProfile {
  name: string;
  role: string;
  domain: string;
  projects: string[];
  filePath: string;
  fullContent: string;
}

/**
 * Initialize the people folder with an example profile.
 */
export async function initPeopleFolder(app: App): Promise<void> {
  if (!app.vault.getAbstractFileByPath(PEOPLE_FOLDER)) {
    const parts = PEOPLE_FOLDER.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!app.vault.getAbstractFileByPath(current)) {
        await app.vault.createFolder(current);
      }
    }
  }

  // Seed an example profile (don't overwrite)
  const examplePath = `${PEOPLE_FOLDER}/Example Person.md`;
  if (!app.vault.getAbstractFileByPath(examplePath)) {
    await app.vault.create(examplePath, EXAMPLE_PROFILE);
  }
}

/**
 * Load all person profiles from the people folder.
 */
export async function loadPeople(app: App): Promise<PersonProfile[]> {
  const people: PersonProfile[] = [];
  const files = app.vault.getMarkdownFiles().filter(
    (f) => f.path.startsWith(PEOPLE_FOLDER + "/")
  );

  for (const file of files) {
    const content = await app.vault.read(file);
    const profile = parseProfile(content, file.path);
    if (profile && profile.name !== "Example Person") {
      people.push(profile);
    }
  }

  return people.sort((a, b) => a.name.localeCompare(b.name));
}

function parseProfile(content: string, filePath: string): PersonProfile | null {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;

  const get = (key: string): string => {
    const m = fm[1].match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  };

  // Parse projects array
  const projectsMatch = fm[1].match(/projects:\n((?:\s+-\s+.+\n?)*)/);
  const projects = projectsMatch
    ? projectsMatch[1].split("\n").map((l) => l.replace(/^\s+-\s+/, "").trim()).filter(Boolean)
    : [];

  const name = get("name") || filePath.split("/").pop()?.replace(".md", "") || "";

  return {
    name,
    role: get("role"),
    domain: get("domain"),
    projects,
    filePath,
    fullContent: content,
  };
}

/**
 * Get the folder path for a person's 1:1 notes.
 */
export function getPersonMeetingFolder(name: string): string {
  return `Meetings/1-on-1/${name}`;
}

/**
 * Load recent 1:1 notes for a person (last 3).
 */
export async function getRecentOneOnOnes(
  app: App,
  name: string,
  limit = 3
): Promise<string[]> {
  const folder = getPersonMeetingFolder(name);
  const files = app.vault.getMarkdownFiles()
    .filter((f) => f.path.startsWith(folder + "/"))
    .sort((a, b) => b.stat.mtime - a.stat.mtime)
    .slice(0, limit);

  const summaries: string[] = [];
  for (const file of files) {
    const content = await app.vault.read(file);
    // Take first 500 chars as summary
    summaries.push(`### ${file.basename}\n${content.slice(0, 500)}`);
  }
  return summaries;
}

const EXAMPLE_PROFILE = `---
name: Example Person
role: Senior Engineer
domain: Payments Platform
projects:
  - Checkout Redesign
  - Payment Gateway Migration
---

## Working Style
- Prefers async communication
- Likes detailed technical specs before starting work

## Current Focus
- Leading the payment gateway migration from Stripe v2 to v3
- Mentoring two junior engineers

## Notes
- Delete this file and create profiles for your actual team members
`;
