import { App } from "obsidian";
import * as cli from "./obsidianCli";

/**
 * Smart context: automatically find vault notes relevant to the user's message.
 * Returns file paths that Claude should read before responding.
 *
 * Strategy:
 * 1. Extract key terms from the message (skip stop words)
 * 2. Search vault via Obsidian CLI for each term
 * 3. Score results by frequency across terms
 * 4. Return top N file paths
 */

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "out", "off", "over",
  "under", "again", "further", "then", "once", "here", "there", "when",
  "where", "why", "how", "all", "both", "each", "few", "more", "most",
  "other", "some", "such", "no", "not", "only", "own", "same", "so",
  "than", "too", "very", "just", "about", "also", "and", "but", "or",
  "if", "while", "because", "until", "although", "what", "which", "who",
  "whom", "this", "that", "these", "those", "i", "me", "my", "we", "our",
  "you", "your", "he", "him", "his", "she", "her", "it", "its", "they",
  "them", "their", "up", "down", "get", "got", "let", "make", "like",
  "know", "think", "want", "need", "look", "tell", "say", "said",
  "please", "help", "thanks", "yes", "no", "ok", "okay",
]);

/**
 * Extract meaningful keywords from a message.
 */
function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  // Deduplicate, keep order
  return [...new Set(words)];
}

/**
 * Find relevant vault files for a user message.
 * Returns up to `limit` file paths, scored by relevance.
 */
export function findRelevantFiles(
  app: App,
  message: string,
  limit = 5
): string[] {
  const keywords = extractKeywords(message);
  if (keywords.length === 0) return [];

  // Take top 5 keywords to avoid too many searches
  const searchTerms = keywords.slice(0, 5);

  // Score files by how many search terms they match
  const fileScores = new Map<string, number>();

  // Try Obsidian CLI search first (fast, full-text)
  if (cli.isAvailable()) {
    for (const term of searchTerms) {
      const result = cli.search(term);
      if (!result) continue;

      // Parse CLI output — typically one file path per line
      const lines = result.split("\n").filter(Boolean);
      for (const line of lines) {
        const path = line.trim();
        if (!path.endsWith(".md")) continue;
        // Skip chat files and templates
        if (path.includes("OpenBrain/chats/") || path.includes("OpenBrain/templates/")) continue;
        fileScores.set(path, (fileScores.get(path) || 0) + 1);
      }
    }
  }

  // Fallback: search via metadataCache if CLI not available
  if (fileScores.size === 0) {
    const allFiles = app.vault.getMarkdownFiles();
    for (const file of allFiles) {
      if (file.path.includes("OpenBrain/chats/") || file.path.includes("OpenBrain/templates/")) continue;

      const cache = app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      const searchableText = [
        file.basename,
        fm?.title || "",
        ...(fm?.tags || []),
        ...(fm?.aliases || []),
      ].join(" ").toLowerCase();

      let score = 0;
      for (const term of searchTerms) {
        if (searchableText.includes(term)) score++;
      }

      if (score > 0) {
        fileScores.set(file.path, score);
      }
    }
  }

  // Also check backlinks for any directly mentioned files
  if (cli.isAvailable()) {
    for (const term of searchTerms) {
      // Look for notes whose basename matches a keyword (likely a person, project, etc.)
      const allFiles = app.vault.getMarkdownFiles();
      for (const file of allFiles) {
        if (file.basename.toLowerCase() === term) {
          // Boost this file significantly
          fileScores.set(file.path, (fileScores.get(file.path) || 0) + 5);

          // Also find its backlinks
          const links = cli.backlinks(file.path);
          if (links) {
            for (const line of links.split("\n").filter(Boolean)) {
              const path = line.trim();
              if (path.endsWith(".md") && !path.includes("OpenBrain/chats/")) {
                fileScores.set(path, (fileScores.get(path) || 0) + 2);
              }
            }
          }
          break;
        }
      }
    }
  }

  // Sort by score descending, return top N paths
  return Array.from(fileScores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([path]) => path);
}

/**
 * Build a context string for injection into the prompt.
 * Returns file paths formatted for Claude to read.
 */
export function buildSmartContext(
  app: App,
  message: string,
  existingFiles: string[] = []
): string {
  const relevant = findRelevantFiles(app, message);

  // Filter out files already attached via @ mentions
  const newFiles = relevant.filter((p) => !existingFiles.includes(p));
  if (newFiles.length === 0) return "";

  return "\n\nRelevant vault notes (read if helpful for responding):\n" +
    newFiles.map((p) => `- ${p}`).join("\n");
}
