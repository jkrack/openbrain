#!/usr/bin/env npx tsx
/**
 * eval-skills.ts — Live evaluation of skill outputs against quality criteria.
 *
 * Reads skill files from the vault, simulates skill execution by sending the
 * system prompt + auto_prompt to the configured LLM, and scores the output.
 *
 * Usage:
 *   npx tsx scripts/eval-skills.ts                    # eval all skills
 *   npx tsx scripts/eval-skills.ts morning-briefing   # eval one skill
 *   npx tsx scripts/eval-skills.ts --dry-run          # show prompts, don't call API
 *
 * Supports OpenRouter (OPENROUTER_API_KEY) or Anthropic (ANTHROPIC_API_KEY).
 * OpenRouter is checked first.
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";

// ── Config ─────────────────────────────────────────────────────────────

const SKILLS_DIR = join(__dirname, "..", "..", "Obsidian", "OpenBrain", "skills");

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const PROVIDER = OPENROUTER_KEY ? "openrouter" : ANTHROPIC_KEY ? "anthropic" : "";
const API_KEY = OPENROUTER_KEY || ANTHROPIC_KEY;
const MODEL = OPENROUTER_KEY ? "anthropic/claude-sonnet-4" : "claude-sonnet-4-20250514";
const MAX_TOKENS = 2048;

// ── Scoring criteria ───────────────────────────────────────────────────

interface ScoreResult {
  skill: string;
  pass: boolean;
  narration: { pass: boolean; violations: string[] };
  format: { pass: boolean; issues: string[] };
  toolBudget: { declared: number | null; mentioned: boolean };
  outputLength: number;
  durationMs: number;
}

const NARRATION_PATTERNS = [
  /^Let me /m,
  /^I'll /m,
  /^Now I /m,
  /^I have /m,
  /^I can see /m,
  /^Looking at .*(vault|note|file|folder|data|content)/m,
  /^Searching /m,
  /^Reading /m,
  /^Here's what I found/m,
  /^\*Using \w+\.\.\.\*/m,
  /^Writing to /m,
  /^Today's note is /m,
];

function scoreOutput(skillName: string, systemPrompt: string, output: string, durationMs: number): ScoreResult {
  // Narration check
  const narrationViolations: string[] = [];
  for (const pattern of NARRATION_PATTERNS) {
    const match = output.match(pattern);
    if (match) {
      narrationViolations.push(match[0].trim());
    }
  }

  // Format check
  const formatIssues: string[] = [];

  // Check if skill expects checkboxes in its direct output
  // Skip for conversational skills (interviews, pickers) where checkboxes appear in created notes, not chat output
  const isConversational = /Ask me|Ask the user|Ask questions ONE AT A TIME|ask.*which one|Step \d+: Ask/i.test(systemPrompt);
  if (systemPrompt.includes("- [ ]") && !output.includes("- [ ]") && !isConversational) {
    formatIssues.push("Expected checkboxes (- [ ]) but found none");
  }

  // Check for stray headings when skill says "No heading"
  if (systemPrompt.includes("No heading") && /^#\s/m.test(output)) {
    formatIssues.push("Output contains heading but skill says 'No heading'");
  }

  // Check for excessive length
  const wordCount = output.split(/\s+/).length;
  const maxWords = systemPrompt.match(/under (\d+) words/i);
  if (maxWords && wordCount > parseInt(maxWords[1]) * 1.2) {
    formatIssues.push(`Output is ${wordCount} words, skill caps at ${maxWords[1]}`);
  }

  // Tool budget — extract from "max N vault_read" patterns
  const budgetMatch = systemPrompt.match(/max (\d+) vault/i);
  const declaredBudget = budgetMatch ? parseInt(budgetMatch[1]) : null;
  const mentionsBudget = /max \d+ vault/i.test(systemPrompt);

  return {
    skill: skillName,
    pass: narrationViolations.length === 0 && formatIssues.length === 0,
    narration: { pass: narrationViolations.length === 0, violations: narrationViolations },
    format: { pass: formatIssues.length === 0, issues: formatIssues },
    toolBudget: { declared: declaredBudget, mentioned: mentionsBudget },
    outputLength: wordCount,
    durationMs,
  };
}

// ── Skill parser (simplified) ──────────────────────────────────────────

interface SkillDef {
  name: string;
  autoPrompt: string;
  systemPrompt: string;
  hasPostActions: boolean;
  filename: string;
}

function parseSkill(filename: string): SkillDef | null {
  const content = readFileSync(join(SKILLS_DIR, filename), "utf8");
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const fm = match[1];
  const body = match[2].trim();

  const nameMatch = fm.match(/^name:\s*["']?(.+?)["']?\s*$/m);
  const autoMatch = fm.match(/^auto_prompt:\s*["']?(.+?)["']?\s*$/m);
  const hasPostActions = fm.includes("post_actions:");

  if (!nameMatch) return null;

  return {
    name: nameMatch[1],
    autoPrompt: autoMatch ? autoMatch[1] : "",
    systemPrompt: body,
    hasPostActions,
    filename,
  };
}

// ── API call ───────────────────────────────────────────────────────────

async function callLLM(systemPrompt: string, userMessage: string): Promise<{ text: string; durationMs: number }> {
  const start = Date.now();

  if (PROVIDER === "openrouter") {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenRouter API error ${response.status}: ${err}`);
    }

    const data = await response.json() as { choices: { message: { content: string } }[] };
    return { text: data.choices[0]?.message?.content || "", durationMs: Date.now() - start };
  }

  // Anthropic
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${err}`);
  }

  const data = await response.json() as { content: { type: string; text: string }[] };
  const text = data.content
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("");

  return { text, durationMs: Date.now() - start };
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const filterName = args.find(a => !a.startsWith("--"));

  if (!dryRun && !API_KEY) {
    console.error("Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY env var, or use --dry-run");
    process.exit(1);
  }

  // Load skills
  const files = readdirSync(SKILLS_DIR).filter(f => f.endsWith(".md"));
  const skills = files.map(parseSkill).filter((s): s is SkillDef => s !== null);

  const filtered = filterName
    ? skills.filter(s => s.filename.includes(filterName))
    : skills;

  if (filtered.length === 0) {
    console.error(`No skills found${filterName ? ` matching "${filterName}"` : ""}`);
    process.exit(1);
  }

  console.log(`\n  Evaluating ${filtered.length} skill(s)${dryRun ? " (dry run)" : ` via ${PROVIDER} (${MODEL})`}\n`);
  console.log("  " + "─".repeat(60));

  const results: ScoreResult[] = [];

  for (const skill of filtered) {
    if (!skill.autoPrompt) {
      console.log(`  ⊘ ${skill.name} — no auto_prompt, skipping`);
      continue;
    }

    if (dryRun) {
      console.log(`\n  ▸ ${skill.name} (${skill.filename})`);
      console.log(`    auto_prompt: "${skill.autoPrompt.slice(0, 80)}..."`);
      console.log(`    system_prompt: ${skill.systemPrompt.split("\n").length} lines`);
      console.log(`    has_post_actions: ${skill.hasPostActions}`);
      console.log(`    has_anti_narration: ${/[Dd]o not narrate|[Nn]o narration/.test(skill.systemPrompt)}`);
      console.log(`    has_tool_budget: ${/max \d+ vault/i.test(skill.systemPrompt)}`);
      continue;
    }

    process.stdout.write(`  ▸ ${skill.name}...`);

    try {
      // Provide minimal fake context so the skill doesn't error on missing vault data
      const context = [
        "Active note: OpenBrain/daily/2026/04/2026-04-04.md",
        "Recent daily notes: 2026-04-03, 2026-04-02, 2026-04-01",
        "Folders: Meetings=OpenBrain/meetings, People=OpenBrain/people, Projects=OpenBrain/projects",
        "",
        "Note: This is an evaluation run. Vault tools are not available.",
        "Respond as if you had gathered the data. Use placeholder content where needed.",
      ].join("\n");

      const fullSystem = `${skill.systemPrompt}\n\n---\nContext:\n${context}`;
      const { text, durationMs } = await callLLM(fullSystem, skill.autoPrompt);

      const score = scoreOutput(skill.name, skill.systemPrompt, text, durationMs);
      results.push(score);

      const status = score.pass ? "✓" : "✗";
      const details: string[] = [];
      if (!score.narration.pass) details.push(`narration(${score.narration.violations.length})`);
      if (!score.format.pass) details.push(`format(${score.format.issues.length})`);

      console.log(` ${status} ${score.durationMs}ms, ${score.outputLength}w${details.length ? " — " + details.join(", ") : ""}`);

      if (!score.pass) {
        for (const v of score.narration.violations) {
          console.log(`      narration: "${v}"`);
        }
        for (const i of score.format.issues) {
          console.log(`      format: ${i}`);
        }
        // Show the actual output for debugging
        console.log(`      output: "${text.slice(0, 200).replace(/\n/g, "\\n")}"`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(` ERROR: ${message.slice(0, 80)}`);
    }
  }

  if (!dryRun && results.length > 0) {
    console.log("\n  " + "─".repeat(60));
    const passed = results.filter(r => r.pass).length;
    const failed = results.filter(r => !r.pass).length;
    console.log(`\n  Results: ${passed} passed, ${failed} failed out of ${results.length} evaluated`);

    if (failed > 0) {
      console.log("\n  Failed skills:");
      for (const r of results.filter(r => !r.pass)) {
        console.log(`    - ${r.skill}`);
      }
    }
    console.log();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
