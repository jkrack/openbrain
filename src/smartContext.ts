import { App, TFile } from "obsidian";
import { startTimer } from "./perf";
import { EmbeddingSearch } from "./embeddingSearch";
import { AttachmentManager } from "./attachmentManager";
import { ImageAttachment } from "./providers/types";

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
  limit = 3
): string[] {
  const done = startTimer("smart-context", { messageLength: message.length });
  const keywords = extractKeywords(message);
  if (keywords.length === 0) { done(); return []; }

  // Take top 5 keywords to avoid too many searches
  const searchTerms = keywords.slice(0, 5);

  // Score files by how many search terms they match
  // Uses in-memory metadataCache to avoid spawning CLI processes
  const fileScores = new Map<string, number>();

  {
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

  // Boost files whose basename exactly matches a keyword (person, project names)
  {
    const allFiles = app.vault.getMarkdownFiles();
    for (const term of searchTerms) {
      for (const file of allFiles) {
        if (file.basename.toLowerCase() === term) {
          fileScores.set(file.path, (fileScores.get(file.path) || 0) + 5);
          break;
        }
      }
    }
  }

  // Sort by score descending, return top N paths
  const results = Array.from(fileScores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([path]) => path);
  done();
  return results;
}

/**
 * Build a context string for injection into the prompt.
 * Uses embedding search when available, falls back to keyword matching.
 */
export async function buildSmartContext(
  app: App,
  message: string,
  existingFiles: string[] = [],
  embeddingSearch?: EmbeddingSearch | null,
  attachmentManager?: AttachmentManager | null
): Promise<{ text: string; images: ImageAttachment[] }> {
  // If embeddings are available, use semantic search
  if (embeddingSearch?.isReady()) {
    const passages = await embeddingSearch.searchPassages(message, 3);
    const notes = await embeddingSearch.searchNotes(message, 3);

    // Filter out already-attached files
    const newPassages = passages.filter((p) => !existingFiles.includes(p.path));
    const newNotes = notes.filter((n) =>
      !existingFiles.includes(n.path) &&
      !newPassages.some((p) => p.path === n.path)
    );

    if (newPassages.length === 0 && newNotes.length === 0) return { text: "", images: [] };

    let context = "\n\n--- Relevant context from your vault ---\n";

    for (const p of newPassages) {
      const basename = p.path.split("/").pop()?.replace(/\.md$/, "") || p.path;
      context += `\nFrom "${basename}" > ${p.heading}:\n${p.text}\n`;
    }

    if (newNotes.length > 0) {
      context += "\nRelated notes (read if helpful):\n";
      context += newNotes.map((n) => `- ${n.path}`).join("\n");
    }

    let images: ImageAttachment[] = [];
    if (attachmentManager) {
      for (const p of newPassages) {
        const file = app.vault.getAbstractFileByPath(p.path);
        if (file instanceof TFile) {
          const content = await app.vault.cachedRead(file);
          const noteImages = attachmentManager.extractFromNote(content);
          images.push(...noteImages);
        }
      }
    }
    return { text: context, images };
  }

  // Fallback: keyword matching
  const relevant = findRelevantFiles(app, message);

  // Filter out files already attached via @ mentions
  const newFiles = relevant.filter((p) => !existingFiles.includes(p));
  if (newFiles.length === 0) return { text: "", images: [] };

  return {
    text: "\n\nRelevant vault notes (read if helpful for responding):\n" +
      newFiles.map((p) => `- ${p}`).join("\n"),
    images: [],
  };
}
