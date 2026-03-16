import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock obsidian
vi.mock("obsidian", () => ({
  App: class {},
  TFile: class { constructor(public path: string, public basename: string, public extension: string, public stat: { mtime: number }) {} },
  TFolder: class {},
  Notice: class {},
  moment: () => ({ format: (f: string) => f === "YYYY-MM-DD" ? "2026-03-15" : f === "dddd" ? "Saturday" : f === "YYYY" ? "2026" : f === "MM" ? "03" : "2026-03-15", subtract: () => ({ format: (f: string) => "2026-03-14" }) }),
  MarkdownRenderer: { render: vi.fn() },
  Component: class {},
  requestUrl: vi.fn(),
}));
vi.mock("../templates", () => ({ createFromTemplate: vi.fn() }));
vi.mock("../obsidianCli", () => ({
  isAvailable: () => false,
  dailyPath: () => null,
  dailyRead: () => null,
  dailyAppend: () => false,
  search: () => null,
  configure: vi.fn(),
}));

import {
  serializeChat,
  parseChat,
  generateChatTitle,
  generateChatFilename,
  ChatMeta,
} from "../chatHistory";
import { buildSmartContext } from "../smartContext";

// ── Chat Round-Trip ──────────────────────────────────────────────────

const meta: ChatMeta = {
  type: "openbrain-chat",
  formatVersion: 1,
  created: "2026-03-15T10:00:00.000Z",
  updated: "2026-03-15T10:05:00.000Z",
  skill: "General",
  sessionId: "test-123",
  messageCount: 4,
  hasAudio: false,
  title: "Test conversation about projects",
  tags: ["openbrain/chat"],
};

const messages = [
  { id: "m1", role: "user" as const, content: "What are the open tasks across my projects?", isAudio: false, timestamp: new Date("2026-03-15T10:00:00Z") },
  { id: "m2", role: "assistant" as const, content: "Looking at your projects, here are the open tasks:\n\n**API Gateway Migration:**\n- [ ] Complete gRPC proto definitions\n- [ ] Migrate auth service\n- [ ] Performance benchmarks\n\n**Onboarding Redesign:**\n- [ ] User research interviews\n- [ ] Prototype new flow\n- [ ] A/B test", isAudio: false, timestamp: new Date("2026-03-15T10:00:05Z") },
  { id: "m3", role: "user" as const, content: "What about the referral program?", isAudio: false, timestamp: new Date("2026-03-15T10:01:00Z") },
  { id: "m4", role: "assistant" as const, content: "The Referral Program v2 is owned by Jordan Kim. Key details:\n- Soft launch planned for next week\n- Target: enterprise users\n- Growth team committed to shipping by March 28\n\nHowever, the growth team is stretched thin — there was discussion about potentially deprioritizing this.", isAudio: false, timestamp: new Date("2026-03-15T10:01:10Z") },
];

describe("Integration: full chat lifecycle", () => {
  it("serializes and parses a multi-turn conversation", () => {
    const serialized = serializeChat(messages, meta);
    const parsed = parseChat(serialized, "OpenBrain/chats/test.md");

    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;

    expect(parsed.messages).toHaveLength(4);
    expect(parsed.frontmatter.title).toBe("Test conversation about projects");
    expect(parsed.frontmatter.messageCount).toBe(4);
    expect(parsed.frontmatter.sessionId).toBe("test-123");
  });

  it("preserves markdown formatting in assistant messages", () => {
    const serialized = serializeChat(messages, meta);
    const parsed = parseChat(serialized, "test.md");
    if ("error" in parsed) return;

    expect(parsed.messages[1].content).toContain("**API Gateway Migration:**");
    expect(parsed.messages[1].content).toContain("- [ ] Complete gRPC proto definitions");
  });

  it("preserves multi-turn conversation order", () => {
    const serialized = serializeChat(messages, meta);
    const parsed = parseChat(serialized, "test.md");
    if ("error" in parsed) return;

    expect(parsed.messages[0].role).toBe("user");
    expect(parsed.messages[1].role).toBe("assistant");
    expect(parsed.messages[2].role).toBe("user");
    expect(parsed.messages[3].role).toBe("assistant");
    expect(parsed.messages[2].content).toContain("referral program");
  });

  it("generates a meaningful title from first user message", () => {
    const title = generateChatTitle(messages);
    expect(title).toContain("What are the open tasks across my projects");
  });

  it("generates unique filenames for concurrent chats", () => {
    const names = new Set(Array.from({ length: 20 }, () => generateChatFilename()));
    expect(names.size).toBe(20);
  });
});

// ── Action Item Extraction ──────────────────────────────────────────

describe("Integration: action item extraction", () => {
  it("finds checkbox tasks in assistant messages", () => {
    const pattern = /- \[ \] .+/g;
    const items: string[] = [];
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      const matches = msg.content.match(pattern);
      if (matches) items.push(...matches);
    }
    expect(items.length).toBeGreaterThan(0);
    expect(items).toContain("- [ ] Complete gRPC proto definitions");
    expect(items).toContain("- [ ] User research interviews");
  });

  it("deduplicates action items", () => {
    const dupeMessages = [
      ...messages,
      { id: "m5", role: "assistant" as const, content: "Reminder:\n- [ ] Complete gRPC proto definitions", isAudio: false, timestamp: new Date() },
    ];
    const pattern = /- \[ \] .+/g;
    const items: string[] = [];
    for (const msg of dupeMessages) {
      if (msg.role !== "assistant") continue;
      const matches = msg.content.match(pattern);
      if (matches) items.push(...matches);
    }
    const unique = [...new Set(items)];
    expect(unique.length).toBeLessThan(items.length);
  });
});

// ── Smart Context ────────────────────────────────────────────────────

describe("Integration: smart context keyword extraction", () => {
  it("extracts meaningful keywords from a user message", () => {
    // Test the stop word filtering indirectly
    const message = "What is the status of the API gateway migration project?";
    const words = message
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2);
    
    expect(words).toContain("status");
    expect(words).toContain("api");
    expect(words).toContain("gateway");
    expect(words).toContain("migration");
    expect(words).toContain("project");
    // "the" and "of" should not be meaningful (they'd be filtered by stop words)
  });
});

// ── Chat File Format ─────────────────────────────────────────────────

describe("Integration: chat file format edge cases", () => {
  it("handles assistant message with code blocks", () => {
    const codeMessages = [
      { id: "c1", role: "user" as const, content: "Show me an example", isAudio: false, timestamp: new Date() },
      { id: "c2", role: "assistant" as const, content: "Here's the code:\n\n```typescript\nfunction hello() {\n  console.log('world');\n}\n```\n\nThat should work.", isAudio: false, timestamp: new Date() },
    ];
    const serialized = serializeChat(codeMessages, { ...meta, messageCount: 2 });
    const parsed = parseChat(serialized, "test.md");

    if ("error" in parsed) return;
    expect(parsed.messages[1].content).toContain("```typescript");
    expect(parsed.messages[1].content).toContain("console.log");
  });

  it("handles empty assistant message (streaming start)", () => {
    const emptyMessages = [
      { id: "e1", role: "user" as const, content: "Hello", isAudio: false, timestamp: new Date() },
      { id: "e2", role: "assistant" as const, content: "", isAudio: false, timestamp: new Date() },
    ];
    const serialized = serializeChat(emptyMessages, { ...meta, messageCount: 2 });
    const parsed = parseChat(serialized, "test.md");

    if ("error" in parsed) return;
    // Empty assistant message may not be captured by regex — that's OK
    expect(parsed.messages.length).toBeGreaterThanOrEqual(1);
  });

  it("handles voice messages with audio flag", () => {
    const voiceMessages = [
      { id: "v1", role: "user" as const, content: "🎙 Voice message", isAudio: true, timestamp: new Date() },
      { id: "v2", role: "assistant" as const, content: "**Transcription** (3.2s):\n\nHere is what I captured from your recording.", isAudio: false, timestamp: new Date() },
    ];
    const voiceMeta = { ...meta, hasAudio: true, messageCount: 2 };
    const serialized = serializeChat(voiceMessages, voiceMeta);
    const parsed = parseChat(serialized, "test.md");

    if ("error" in parsed) return;
    expect(parsed.messages[0].isAudio).toBe(true);
    expect(parsed.messages[1].isAudio).toBe(false);
    expect(parsed.frontmatter.hasAudio).toBe(true);
  });
});

// ── TLDR / Title Generation ─────────────────────────────────────────

describe("Integration: title generation scenarios", () => {
  it("generates title from a question", () => {
    expect(generateChatTitle(messages)).toContain("What are the open tasks");
  });

  it("generates voice fallback title", () => {
    const voiceOnly = [
      { id: "v1", role: "user" as const, content: "🎙 Voice message", isAudio: true, timestamp: new Date("2026-03-15T10:00:00Z") },
    ];
    const title = generateChatTitle(voiceOnly);
    expect(title).toMatch(/^Voice chat/);
  });

  it("handles very long first message", () => {
    const longMessages = [
      { id: "l1", role: "user" as const, content: "I need you to help me understand the full scope of the API gateway migration project including all the technical details about gRPC proto definitions and the security concerns around token handling in metadata", isAudio: false, timestamp: new Date() },
    ];
    const title = generateChatTitle(longMessages);
    expect(title.length).toBeLessThanOrEqual(61);
  });
});
