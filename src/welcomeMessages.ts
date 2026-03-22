/**
 * Welcome messages for the empty chat state.
 *
 * Strategy:
 *   1. On plugin load, generate a fresh batch via the LLM and cache to disk.
 *   2. On panel render, read the cache and pick one by day-of-year.
 *   3. If no cache exists yet (first run, no API key), fall back to a static pool.
 *
 * Generation is always fire-and-forget — it never blocks UI.
 */

import { App } from "obsidian";
import { OpenBrainSettings } from "./settings";
import { runChat } from "./chatEngine";
import { Skill } from "./skills";

export interface WelcomeContent {
  headline: string;
  sub: string;
  tips: string[];
}

// ---------------------------------------------------------------------------
// In-memory cache (survives across panel re-renders within a session)
// ---------------------------------------------------------------------------

let cachedWelcomes: WelcomeContent[] | null = null;
let generating = false;

const CACHE_FILE = "OpenBrain/welcome-cache.json";
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const BATCH_SIZE = 7; // one week of variety per generation

// ---------------------------------------------------------------------------
// Static fallback pool (used before first LLM generation)
// ---------------------------------------------------------------------------

const fallbackPool: WelcomeContent[] = [
  {
    headline: "Your vault has stories to tell",
    sub: "Let's find the ones that matter today",
    tips: [
      "Try: \"What did I write about last week?\"",
      "@ a note to pull it into the conversation",
      "/ to run a skill like a pro",
    ],
  },
  {
    headline: "Second brain, reporting for duty",
    sub: "I know your notes — you bring the questions",
    tips: [
      "Try: \"Find everything related to Project X\"",
      "@ to reference a specific note",
      "I'll pull in relevant context automatically",
    ],
  },
  {
    headline: "Think out loud",
    sub: "I'll catch the good parts",
    tips: [
      "Hit the mic and just talk — I'll transcribe it",
      "Try: \"Turn my voice note into action items\"",
      "@ a note to add context to any conversation",
    ],
  },
  {
    headline: "Your move, boss",
    sub: "I've got 22 tools and zero complaints",
    tips: [
      "Try: \"Search my vault for anything about quarterly goals\"",
      "/ to see available skills",
      "I can read, write, search, and connect your notes",
    ],
  },
  {
    headline: "I've been reading your notes",
    sub: "In a helpful way, not a creepy way",
    tips: [
      "Try: \"What should I be working on today?\"",
      "I'll surface relevant notes as we talk",
      "Ask me to build a skill for any repeating workflow",
    ],
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get a welcome message for today. Synchronous — uses whatever is cached.
 */
export function getWelcomeForToday(): WelcomeContent {
  const pool = cachedWelcomes && cachedWelcomes.length > 0
    ? cachedWelcomes
    : fallbackPool;
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 0);
  const diff = now.getTime() - startOfYear.getTime();
  const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));
  return pool[dayOfYear % pool.length];
}

/**
 * Load cached welcomes from disk into memory.
 * Call once on plugin load — fast, non-blocking.
 */
export async function loadWelcomeCache(app: App): Promise<void> {
  try {
    const exists = await app.vault.adapter.exists(CACHE_FILE);
    if (!exists) return;
    const raw = await app.vault.adapter.read(CACHE_FILE);
    const data = JSON.parse(raw) as { generatedAt: number; welcomes: WelcomeContent[] };
    if (Array.isArray(data.welcomes) && data.welcomes.length > 0) {
      cachedWelcomes = data.welcomes;
    }
  } catch {
    // Cache miss or corrupt — no problem, fallback pool handles it
  }
}

/**
 * Check if the cache is stale and regenerate if needed.
 * Fire-and-forget — call on plugin load after loadWelcomeCache.
 */
export async function refreshWelcomeIfStale(
  app: App,
  settings: OpenBrainSettings,
  skills: Skill[],
): Promise<void> {
  if (generating) return;

  // Check freshness
  try {
    const exists = await app.vault.adapter.exists(CACHE_FILE);
    if (exists) {
      const raw = await app.vault.adapter.read(CACHE_FILE);
      const data = JSON.parse(raw) as { generatedAt: number };
      if (Date.now() - data.generatedAt < CACHE_MAX_AGE_MS) return; // still fresh
    }
  } catch {
    // Proceed to regenerate
  }

  // Need an API key to generate
  const hasKey = settings.chatProvider === "ollama"
    || (settings.chatProvider === "anthropic" && settings.apiKey)
    || (settings.chatProvider === "openrouter" && settings.openrouterApiKey);
  if (!hasKey) return;

  generating = true;
  try {
    const welcomes = await generateWelcomeBatch(app, settings, skills);
    if (welcomes.length > 0) {
      cachedWelcomes = welcomes;
      const payload = JSON.stringify({ generatedAt: Date.now(), welcomes }, null, 2);
      await app.vault.adapter.write(CACHE_FILE, payload);
    }
  } catch {
    // Generation failed — no big deal, static pool still works
  } finally {
    generating = false;
  }
}

// ---------------------------------------------------------------------------
// LLM generation
// ---------------------------------------------------------------------------

async function generateWelcomeBatch(
  app: App,
  settings: OpenBrainSettings,
  skills: Skill[],
): Promise<WelcomeContent[]> {
  const skillNames = skills
    .filter(s => !s.trigger) // only user-facing skills
    .map(s => s.name)
    .slice(0, 10);

  const skillList = skillNames.length > 0
    ? `Available skills the user can invoke with /: ${skillNames.join(", ")}.`
    : "The user can invoke skills with /.";

  const prompt = `You are the personality engine for OpenBrain, an AI assistant that lives inside Obsidian. Your job is to generate ${BATCH_SIZE} welcome screen messages — the first thing users see when they open a new chat.

OpenBrain can:
- Search, read, create, and edit notes in the user's vault
- Record voice and transcribe it
- Run multi-step workflows called "skills" (invoked with /)
- Reference specific notes with @
- Pull in smart context from the vault automatically
- Work with multiple LLM providers
${skillList}

Generate ${BATCH_SIZE} welcome messages. Each must have:
- "headline": A short, punchy greeting (max 8 words). Be warm, witty, surprising. Mix tones — some playful, some motivating, some quirky. Never generic.
- "sub": A one-line subtitle that complements the headline (max 12 words). Can be funny, insightful, or action-oriented.
- "tips": Exactly 3 short tips (max 15 words each). Mix practical how-to hints with specific "Try:" prompts that show off capabilities. At least one tip per message should be a specific "Try:" example the user can copy. Tips should reference real features (voice, @, /, skills, smart context, vault search).

Rules:
- Never repeat the same headline or tip across entries.
- Vary the energy: some entries should be witty, some warm, some confident, some playful.
- Reference actual features — don't be vague.
- These are for a productivity tool, but one with personality. Think "helpful friend who happens to be an AI" not "corporate onboarding."
- No emojis.

Respond with ONLY a JSON array of objects. No markdown, no explanation.`;

  let response = "";
  await runChat(app, settings, {
    messages: [{ role: "user", content: prompt }],
    systemPrompt: "You generate JSON. Respond with only valid JSON, no markdown fences, no extra text.",
    allowWrite: false,
    useTools: false,
    onText: (text) => { response += text; },
    onToolStart: () => {},
    onToolEnd: () => {},
    onDone: () => {},
    onError: () => {},
  });

  // Parse — handle possible markdown fences from the model
  const cleaned = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const parsed = JSON.parse(cleaned) as WelcomeContent[];

  // Validate structure
  return parsed.filter(
    (w) =>
      typeof w.headline === "string" &&
      typeof w.sub === "string" &&
      Array.isArray(w.tips) &&
      w.tips.length >= 2 &&
      w.tips.every((t) => typeof t === "string"),
  ).slice(0, BATCH_SIZE);
}
