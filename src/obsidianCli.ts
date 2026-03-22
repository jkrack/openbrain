let execSyncFn: ((cmd: string, opts?: any) => Buffer | string) | null = null;
try {
  execSyncFn = require("child_process").execSync;
} catch { /* not available on mobile */ }

let cliPath = "obsidian";
let availableCache: boolean | null = null;

/** Set the Obsidian CLI path from settings. */
export function configure(path: string): void {
  cliPath = path || "obsidian";
  availableCache = null; // reset cache on config change
}

/**
 * Build env with extended PATH so CLI tools are discoverable in Electron.
 */
function getEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  const home = env.HOME || "";
  const extraPaths = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    `${home}/.local/bin`,
    "/Applications/Obsidian.app/Contents/MacOS",
  ];
  env.PATH = [...extraPaths, env.PATH].filter(Boolean).join(":");
  return env;
}

/**
 * Execute an Obsidian CLI command and return stdout.
 * Returns null if the command fails.
 */
function exec(command: string): string | null {
  if (!execSyncFn) return null;
  try {
    return (execSyncFn(`${cliPath} ${command}`, {
      encoding: "utf-8",
      timeout: 10000,
      env: getEnv(),
    }) as string).trim();
  } catch { /* expected — CLI may not be installed or command failed */
    return null;
  }
}

/**
 * Escape a value for use as an Obsidian CLI parameter.
 * Wraps in quotes if it contains spaces or special chars.
 */
function escapeValue(val: string): string {
  if (/[\s"\\]/.test(val)) {
    return `"${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return val;
}

// ── Daily Notes ────────────────────────────────────────────────────────

/** Append content to today's daily note. Creates the note if missing. */
export function dailyAppend(content: string): boolean {
  const escaped = escapeValue(content);
  return exec(`daily:append content=${escaped}`) !== null;
}

/** Read today's daily note content. */
export function dailyRead(): string | null {
  return exec("daily:read");
}

/** Get today's daily note path. */
export function dailyPath(): string | null {
  return exec("daily:path");
}

// ── Files ──────────────────────────────────────────────────────────────

/** Create a new note. Returns true on success. */
export function createNote(
  name: string,
  opts?: { content?: string; template?: string; open?: boolean }
): boolean {
  let cmd = `create name=${escapeValue(name)}`;
  if (opts?.content) cmd += ` content=${escapeValue(opts.content)}`;
  if (opts?.template) cmd += ` template=${escapeValue(opts.template)}`;
  if (opts?.open) cmd += " open";
  return exec(cmd) !== null;
}

/** Append content to a file. */
export function appendToFile(file: string, content: string): boolean {
  return exec(`append file=${escapeValue(file)} content=${escapeValue(content)}`) !== null;
}

/** Read a file's content. */
export function readFile(file: string): string | null {
  return exec(`read file=${escapeValue(file)}`);
}

// ── Search ─────────────────────────────────────────────────────────────

/** Search the vault. Returns results as a string. */
export function search(query: string): string | null {
  return exec(`search query=${escapeValue(query)}`);
}

// ── Tasks ──────────────────────────────────────────────────────────────

/** Get tasks from a file. */
export function tasks(file: string, filter?: "todo" | "done"): string | null {
  let cmd = `tasks file=${escapeValue(file)}`;
  if (filter) cmd += ` ${filter}`;
  return exec(cmd);
}

/** Get tasks from today's daily note. */
export function dailyTasks(filter?: "todo" | "done"): string | null {
  let cmd = "tasks daily";
  if (filter) cmd += ` ${filter}`;
  return exec(cmd);
}

// ── Properties ─────────────────────────────────────────────────────────

/** Set a property on a file. */
export function propertySet(
  file: string,
  name: string,
  value: string,
  type?: string
): boolean {
  let cmd = `property:set file=${escapeValue(file)} name=${escapeValue(name)} value=${escapeValue(value)}`;
  if (type) cmd += ` type=${escapeValue(type)}`;
  return exec(cmd) !== null;
}

/** Read a property from a file. */
export function propertyRead(file: string, name: string): string | null {
  return exec(`property:read file=${escapeValue(file)} name=${escapeValue(name)}`);
}

// ── Links ──────────────────────────────────────────────────────────────

/** Get backlinks for a file. */
export function backlinks(file: string): string | null {
  return exec(`backlinks file=${escapeValue(file)}`);
}

/** Check if the Obsidian CLI is available. */
export function isAvailable(): boolean {
  if (availableCache !== null) return availableCache;
  availableCache = exec("version") !== null;
  return availableCache;
}
