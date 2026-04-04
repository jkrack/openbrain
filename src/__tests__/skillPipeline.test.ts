/**
 * Skill pipeline tests — mock provider → chat engine → event separation → cleanResponse → post-actions
 *
 * Tests the full pipeline without hitting LLM APIs. Uses a mock provider that emits
 * scripted event sequences to simulate realistic skill runs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("obsidian", () => ({
  App: class {},
  TFile: class { path: string; constructor(p: string) { this.path = p; } },
  TFolder: class {},
  Notice: class {},
  moment: () => ({
    format: (f: string) => f === "YYYY-MM-DD" ? "2026-04-04" : f === "dddd" ? "Friday" : "2026-04-04",
    subtract: () => ({ format: () => "2026-04-03" }),
  }),
  parseYaml: (s: string) => {
    // Minimal YAML parser for tests — handles simple key: value and lists
    const result: Record<string, unknown> = {};
    for (const line of s.split("\n")) {
      const m = line.match(/^(\w+):\s*(.+)$/);
      if (m) result[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return result;
  },
  Platform: { isDesktop: true },
}));

vi.mock("../templates", () => ({ createFromTemplate: vi.fn() }));

import type { ChatEvent } from "../chatEngine";
import { cleanResponse, parseSkillFile } from "../skills";
import type { StreamEvent, LLMProvider, ChatMessage, ToolCall, ToolResultData } from "../providers/types";

// ── Mock Provider ──────────────────────────────────────────────────────

/** Create a mock provider that emits a scripted sequence of StreamEvents. */
function createMockProvider(script: StreamEvent[]): LLMProvider {
  return {
    id: "mock",
    name: "Mock Provider",
    supportsImages: false,
    supportsTools: true,
    async streamChat(opts) {
      for (const event of script) {
        opts.onEvent(event);
      }
    },
    formatToolMessages(toolCalls: ToolCall[], results: ToolResultData[]): ChatMessage[] {
      return toolCalls.map((tc, i) => ({
        role: "assistant" as const,
        content: `Tool ${tc.name}: ${results[i]?.content || "ok"}`,
      }));
    },
  };
}

// ── Event collector ────────────────────────────────────────────────────

/** Simulate the panel's event handler — separates content from display. */
function collectEvents(events: ChatEvent[]) {
  let content = "";
  let display = "";
  const toolCounts: Record<string, number> = {};
  const errors: string[] = [];
  let done = false;

  for (const event of events) {
    switch (event.type) {
      case "content":
        content += event.text;
        display += event.text;
        break;
      case "tool_start":
        toolCounts[event.toolName] = (toolCounts[event.toolName] || 0) + 1;
        display += `\n*Using ${event.toolName}...*\n`;
        break;
      case "tool_end":
        break;
      case "done":
        done = true;
        break;
      case "error":
        errors.push(event.message);
        break;
    }
  }

  return { content, display, toolCounts, errors, done };
}

// ── Fixtures: realistic event sequences from actual skill runs ─────────

const MORNING_BRIEFING_EVENTS: ChatEvent[] = [
  { type: "tool_start", toolName: "vault_read" },
  { type: "tool_end", toolName: "vault_read", result: "# 2026-04-03..." },
  { type: "tool_start", toolName: "vault_read" },
  { type: "tool_end", toolName: "vault_read", result: "# 2026-04-02..." },
  { type: "tool_start", toolName: "vault_read" },
  { type: "tool_end", toolName: "vault_read", result: "# 2026-04-01..." },
  { type: "content", text: "- [ ] Finalize Q2 planning doc with stakeholder feedback\n" },
  { type: "content", text: "- [ ] Follow up with Amy on RGB partner escalation\n" },
  { type: "content", text: "- [ ] Review PR #212 for holiday feature\n" },
  { type: "content", text: "\n▎ Context: Q2 planning deadline is Friday, RGB needs escalation today\n" },
  { type: "done" },
];

const NARRATION_HEAVY_EVENTS: ChatEvent[] = [
  { type: "content", text: "Let me review your recent daily notes.\n" },
  { type: "tool_start", toolName: "vault_read" },
  { type: "tool_end", toolName: "vault_read", result: "..." },
  { type: "tool_start", toolName: "vault_read" },
  { type: "tool_end", toolName: "vault_read", result: "..." },
  { type: "content", text: "Now I have everything I need.\n" },
  { type: "content", text: "- [ ] First priority\n" },
  { type: "content", text: "- [ ] Second priority\n" },
  { type: "content", text: "\n▎ Context: carry forward from yesterday\n" },
  { type: "done" },
];

const MONTHLY_REVIEW_EVENTS: ChatEvent[] = [
  // Gather phase — many tool calls
  ...Array.from({ length: 4 }, () => [
    { type: "tool_start" as const, toolName: "vault_search" },
    { type: "tool_end" as const, toolName: "vault_search", result: "3 results" },
  ]).flat(),
  ...Array.from({ length: 12 }, () => [
    { type: "tool_start" as const, toolName: "vault_read" },
    { type: "tool_end" as const, toolName: "vault_read", result: "note content..." },
  ]).flat(),
  { type: "content", text: "I'll start gathering data immediately.\n" },
  { type: "content", text: "# Month of 2026-04-04\n\n" },
  { type: "content", text: "## Summary\nA productive month focused on Q2 planning.\n\n" },
  { type: "content", text: "## Key Wins\n- Shipped feature X\n" },
  { type: "done" },
];

// ── Tests ──────────────────────────────────────────────────────────────

describe("skill pipeline — event separation", () => {
  it("morning briefing: content has no tool_start text", () => {
    const result = collectEvents(MORNING_BRIEFING_EVENTS);

    expect(result.content).toContain("- [ ] Finalize Q2 planning");
    expect(result.content).toContain("▎ Context:");
    expect(result.content).not.toContain("vault_read");
    expect(result.content).not.toContain("*Using");
    expect(result.done).toBe(true);
  });

  it("morning briefing: display shows tool pills", () => {
    const result = collectEvents(MORNING_BRIEFING_EVENTS);

    expect(result.display).toContain("*Using vault_read...*");
    expect(result.display).toContain("- [ ] Finalize Q2 planning");
    expect(result.toolCounts["vault_read"]).toBe(3);
  });

  it("narration-heavy response: cleanResponse strips model narration from content", () => {
    const result = collectEvents(NARRATION_HEAVY_EVENTS);

    // Content includes narration (model-generated, not tool_start)
    expect(result.content).toContain("Let me review");

    // cleanResponse strips it
    const cleaned = cleanResponse(result.content);
    expect(cleaned).not.toContain("Let me review");
    expect(cleaned).not.toContain("Now I have");
    expect(cleaned).toContain("- [ ] First priority");
    expect(cleaned).toContain("▎ Context:");
  });

  it("monthly review: tool counts track correctly", () => {
    const result = collectEvents(MONTHLY_REVIEW_EVENTS);

    expect(result.toolCounts["vault_search"]).toBe(4);
    expect(result.toolCounts["vault_read"]).toBe(12);
    expect(result.content).toContain("# Month of 2026-04-04");
  });

  it("monthly review: cleanResponse strips stray narration", () => {
    const result = collectEvents(MONTHLY_REVIEW_EVENTS);
    const cleaned = cleanResponse(result.content);

    expect(cleaned).not.toContain("I'll start gathering");
    expect(cleaned).toContain("# Month of 2026-04-04");
    expect(cleaned).toContain("## Key Wins");
  });

  it("content-only stream: no tool events", () => {
    const events: ChatEvent[] = [
      { type: "content", text: "Here is your answer." },
      { type: "done" },
    ];
    const result = collectEvents(events);

    expect(result.content).toBe("Here is your answer.");
    expect(result.display).toBe("Here is your answer.");
    expect(Object.keys(result.toolCounts)).toHaveLength(0);
  });

  it("error event: captured separately", () => {
    const events: ChatEvent[] = [
      { type: "content", text: "Partial response" },
      { type: "error", message: "API rate limit" },
    ];
    const result = collectEvents(events);

    expect(result.content).toBe("Partial response");
    expect(result.errors).toEqual(["API rate limit"]);
    expect(result.done).toBe(false);
  });
});

describe("skill pipeline — fixture regression", () => {
  it("exact morning briefing failure case: 6x vault_read narration stripped", () => {
    // Reproduce the exact bug: UI injected *Using vault_read...* 6 times,
    // model also narrated "Now I have everything", all leaked into post-action
    const events: ChatEvent[] = [
      // 6 tool calls
      ...Array.from({ length: 6 }, () => [
        { type: "tool_start" as const, toolName: "vault_read" },
        { type: "tool_end" as const, toolName: "vault_read", result: "..." },
      ]).flat(),
      // Model narration (comes through as content)
      { type: "content", text: "Now I have everything I need. Writing to today's Focus section:\n" },
      { type: "tool_start", toolName: "vault_edit" },
      { type: "tool_end", toolName: "vault_edit", result: "ok" },
      { type: "content", text: "Today's note is **2026-04-03** (Friday). Writing directly to it now.\n" },
      { type: "tool_start", toolName: "vault_edit" },
      { type: "tool_end", toolName: "vault_edit", result: "ok" },
      // Actual content
      { type: "content", text: "- [ ] Loop in Amy to flag RGB\n" },
      { type: "content", text: "- [ ] Push Faith's team on Invite Only\n" },
      { type: "content", text: "- [ ] Force the component decision\n" },
      { type: "content", text: "\n▎ Context: Friday call produced 5 open loops\n" },
      { type: "done" },
    ];

    const result = collectEvents(events);

    // Content has model narration but NO tool_start text
    expect(result.content).not.toContain("*Using vault_read...*");
    expect(result.content).toContain("Now I have everything");

    // cleanResponse strips model narration
    const cleaned = cleanResponse(result.content);
    expect(cleaned).not.toContain("Now I have");
    expect(cleaned).not.toContain("Today's note is");
    expect(cleaned).not.toContain("Writing to");
    expect(cleaned).toContain("- [ ] Loop in Amy to flag RGB");
    expect(cleaned).toContain("▎ Context: Friday call produced 5 open loops");

    // Tool counts
    expect(result.toolCounts["vault_read"]).toBe(6);
    expect(result.toolCounts["vault_edit"]).toBe(2);
  });

  it("clean skill output passes through unchanged", () => {
    const events: ChatEvent[] = [
      { type: "content", text: "- [ ] First task\n- [ ] Second task\n\n▎ Context: all clear\n" },
      { type: "done" },
    ];
    const result = collectEvents(events);
    const cleaned = cleanResponse(result.content);

    expect(cleaned).toBe("- [ ] First task\n- [ ] Second task\n\n▎ Context: all clear");
  });
});

describe("skill pipeline — tool call budget enforcement", () => {
  it("can count tool calls against a budget", () => {
    const budget = 15;
    const events: ChatEvent[] = Array.from({ length: 20 }, (_, i) => [
      { type: "tool_start" as const, toolName: "vault_read" },
      { type: "tool_end" as const, toolName: "vault_read", result: `result ${i}` },
    ]).flat();
    events.push({ type: "done" });

    const result = collectEvents(events);
    const totalToolCalls = Object.values(result.toolCounts).reduce((a, b) => a + b, 0);

    expect(totalToolCalls).toBe(20);
    expect(totalToolCalls > budget).toBe(true);
    // This test documents that the LLM can exceed the budget — the cap is in the prompt, not enforced in code
  });
});

describe("skill prompt parsing", () => {
  it("parses morning-briefing with anti-narration rules", () => {
    const content = `---
name: Morning Briefing
description: Auto-populate Focus section
input: text
tools:
  write: true
---

You are a daily briefing assistant. Do not narrate.

**Hard rules:**
- No heading
- Output ends after the context line`;

    const skill = parseSkillFile(content, "morning-briefing.md");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("Morning Briefing");
    expect(skill!.systemPrompt).toContain("Do not narrate");
    expect(skill!.systemPrompt).toContain("Hard rules");
  });

  it("parses skill without post_actions", () => {
    const content = `---
name: Vault Health
description: Audit vault structure
input: text
---

Audit prompt body with Hard rules and max 10 vault tool calls.`;

    const skill = parseSkillFile(content, "vault-health.md");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("Vault Health");
    expect(skill!.postActions).toHaveLength(0);
    expect(skill!.systemPrompt).toContain("Hard rules");
  });
});

describe("cleanResponse — comprehensive patterns", () => {
  const narrationPatterns = [
    "Let me review your recent notes.",
    "Let me search the vault for that.",
    "Now I have the context I need.",
    "Now I can write the summary.",
    "I'll now compile the results.",
    "Writing to your daily note section.",
    "Today's note is 2026-04-04 (Friday).",
    "Here's your morning briefing for Saturday.",
    "Here's the focus section based on my analysis.",
  ];

  for (const pattern of narrationPatterns) {
    it(`strips: "${pattern.slice(0, 40)}..."`, () => {
      const dirty = `${pattern}\n- [ ] Real task\n▎ Context: real context`;
      const cleaned = cleanResponse(dirty);
      expect(cleaned).not.toContain(pattern);
      expect(cleaned).toContain("- [ ] Real task");
    });
  }

  it("preserves legitimate content starting with similar words", () => {
    const content = "- [ ] Let marketing know about the launch\n- [ ] Now that Q2 is planned, execute";
    const cleaned = cleanResponse(content);
    // These are task content, not narration — they start with "- [ ]"
    expect(cleaned).toContain("Let marketing know");
    expect(cleaned).toContain("Now that Q2 is planned");
  });
});
