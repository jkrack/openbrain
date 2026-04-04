import { describe, it, expect, vi } from "vitest";

vi.mock("obsidian", () => ({
  App: class {},
  TFile: class {},
  TFolder: class {},
  Notice: class {},
  moment: () => ({ format: () => "2026-04-04" }),
  parseYaml: (s: string) => JSON.parse(s),
}));

import type { ChatEvent } from "../chatEngine";
import { cleanResponse } from "../skills";

// ── ChatEvent type discrimination ──────────────────────────────────────

describe("ChatEvent types", () => {
  it("content event carries text", () => {
    const event: ChatEvent = { type: "content", text: "Hello world" };
    expect(event.type).toBe("content");
    if (event.type === "content") {
      expect(event.text).toBe("Hello world");
    }
  });

  it("tool_start event carries toolName", () => {
    const event: ChatEvent = { type: "tool_start", toolName: "vault_search" };
    expect(event.type).toBe("tool_start");
    if (event.type === "tool_start") {
      expect(event.toolName).toBe("vault_search");
    }
  });

  it("tool_end event carries toolName and result", () => {
    const event: ChatEvent = { type: "tool_end", toolName: "vault_read", result: "file content..." };
    if (event.type === "tool_end") {
      expect(event.toolName).toBe("vault_read");
      expect(event.result).toBe("file content...");
    }
  });

  it("error event carries message", () => {
    const event: ChatEvent = { type: "error", message: "API key missing" };
    if (event.type === "error") {
      expect(event.message).toBe("API key missing");
    }
  });

  it("done event has no payload", () => {
    const event: ChatEvent = { type: "done" };
    expect(event.type).toBe("done");
  });
});

// ── Content vs status separation ───────────────────────────────────────

describe("content/status separation", () => {
  it("accumulates only content events, ignoring tool_start", () => {
    const events: ChatEvent[] = [
      { type: "content", text: "- [ ] First task\n" },
      { type: "tool_start", toolName: "vault_read" },
      { type: "tool_end", toolName: "vault_read", result: "..." },
      { type: "content", text: "- [ ] Second task\n" },
      { type: "done" },
    ];

    let content = "";
    let display = "";
    for (const event of events) {
      switch (event.type) {
        case "content":
          content += event.text;
          display += event.text;
          break;
        case "tool_start":
          display += `\n*Using ${event.toolName}...*\n`;
          break;
      }
    }

    expect(content).toBe("- [ ] First task\n- [ ] Second task\n");
    expect(display).toContain("*Using vault_read...*");
    expect(content).not.toContain("vault_read");
  });

  it("display includes tool narration, content does not", () => {
    const events: ChatEvent[] = [
      { type: "tool_start", toolName: "vault_search" },
      { type: "tool_end", toolName: "vault_search", result: "3 results" },
      { type: "tool_start", toolName: "vault_read" },
      { type: "tool_end", toolName: "vault_read", result: "note content" },
      { type: "content", text: "Here are your results." },
      { type: "done" },
    ];

    let content = "";
    let display = "";
    for (const event of events) {
      switch (event.type) {
        case "content":
          content += event.text;
          display += event.text;
          break;
        case "tool_start":
          display += `\n*Using ${event.toolName}...*\n`;
          break;
      }
    }

    expect(content).toBe("Here are your results.");
    expect(display).toContain("*Using vault_search...*");
    expect(display).toContain("*Using vault_read...*");
    expect(display).toContain("Here are your results.");
  });
});

// ── cleanResponse (safety net for model self-narration) ────────────────

describe("cleanResponse", () => {
  it("strips UI-injected tool narration", () => {
    const dirty = [
      "*Using vault_read...*",
      "",
      "*Using vault_read...*",
      "",
      "- [ ] Do the thing",
      "",
      "▎ Context: important stuff",
    ].join("\n");

    const cleaned = cleanResponse(dirty);
    expect(cleaned).not.toContain("*Using vault_read...*");
    expect(cleaned).toContain("- [ ] Do the thing");
    expect(cleaned).toContain("▎ Context: important stuff");
  });

  it("strips model self-narration", () => {
    const dirty = [
      "Let me review your recent notes.",
      "Now I have everything I need.",
      "- [ ] First priority",
      "- [ ] Second priority",
      "▎ Context: carry forward from yesterday",
    ].join("\n");

    const cleaned = cleanResponse(dirty);
    expect(cleaned).not.toContain("Let me review");
    expect(cleaned).not.toContain("Now I have");
    expect(cleaned).toContain("- [ ] First priority");
    expect(cleaned).toContain("- [ ] Second priority");
  });

  it("strips writing-to-daily narration", () => {
    const dirty = [
      "Writing to your daily note now.",
      "Today's note is 2026-04-04.",
      "Here's your morning briefing:",
      "- [ ] Important task",
    ].join("\n");

    const cleaned = cleanResponse(dirty);
    expect(cleaned).not.toContain("Writing to");
    expect(cleaned).not.toContain("Today's note is");
    expect(cleaned).not.toContain("Here's your morning");
    expect(cleaned).toContain("- [ ] Important task");
  });

  it("preserves blank lines but collapses excessive ones", () => {
    const dirty = [
      "*Using vault_read...*",
      "",
      "",
      "",
      "- [ ] Task",
      "",
      "▎ Context: stuff",
    ].join("\n");

    const cleaned = cleanResponse(dirty);
    // Should not have more than 2 consecutive newlines
    expect(cleaned).not.toMatch(/\n{3,}/);
    expect(cleaned).toContain("- [ ] Task");
  });

  it("returns clean content unchanged", () => {
    const clean = [
      "- [ ] First priority",
      "- [ ] Second priority",
      "",
      "▎ Context: everything is fine",
    ].join("\n");

    expect(cleanResponse(clean)).toBe(clean);
  });

  it("handles the exact morning briefing failure case", () => {
    const dirty = [
      "*Using vault_read...*",
      "",
      "*Using vault_read...*",
      "",
      "*Using vault_read...*",
      "",
      "*Using vault_read...*",
      "",
      "*Using vault_read...*",
      "",
      "*Using vault_read...*",
      "Now I have everything I need. Writing to today's Focus section:",
      "*Using vault_edit...*",
      "",
      "*Using vault_list...*",
      "Today's note is **2026-04-03** (Friday). Writing directly to it now.",
      "*Using vault_edit...*",
      "- [ ] Loop in Amy to flag RGB",
      "- [ ] Push Faith's team on Invite Only",
      "- [ ] Force the component decision",
      "",
      "▎ Context: Friday call produced 5 open loops",
    ].join("\n");

    const cleaned = cleanResponse(dirty);
    expect(cleaned).not.toContain("*Using");
    expect(cleaned).not.toContain("Now I have");
    expect(cleaned).not.toContain("Today's note is");
    expect(cleaned).toContain("- [ ] Loop in Amy to flag RGB");
    expect(cleaned).toContain("- [ ] Push Faith's team on Invite Only");
    expect(cleaned).toContain("▎ Context: Friday call produced 5 open loops");
  });
});
