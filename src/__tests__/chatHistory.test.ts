import { describe, it, expect, vi } from "vitest";

// Mock obsidian module (must be before imports that use it)
vi.mock("obsidian", () => ({
  App: class {},
  TFile: class {},
  TFolder: class {},
  Notice: class {},
  moment: () => ({ format: (f: string) => "2026-03-15" }),
}));

vi.mock("../templates", () => ({
  createFromTemplate: vi.fn(),
}));

vi.mock("../obsidianCli", () => ({
  isAvailable: () => false,
  dailyPath: () => null,
  dailyRead: () => null,
  dailyAppend: () => false,
}));

import {
  serializeChat,
  parseChat,
  generateChatTitle,
  generateChatFilename,
  ChatMeta,
} from "../chatHistory";
import type { Message } from "../providers/types";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeMeta(overrides: Partial<ChatMeta> = {}): ChatMeta {
  return {
    type: "openbrain-chat",
    formatVersion: 1,
    created: "2026-03-15 10:00",
    updated: "2026-03-15 10:05",
    skill: "general",
    sessionId: "abc-123",
    messageCount: 2,
    hasAudio: false,
    title: "Test chat",
    tags: ["test", "unit"],
    ...overrides,
  };
}

function makeMsg(overrides: Partial<Message> & { id: string; role: "user" | "assistant"; content: string }): Message {
  return {
    timestamp: new Date("2026-03-15T10:00:00Z"),
    isAudio: false,
    ...overrides,
  };
}

// ── serializeChat / parseChat round-trip ─────────────────────────────────

describe("serializeChat -> parseChat round-trip", () => {
  it("preserves message fields (id, role, content, isAudio, timestamp)", () => {
    const messages: Message[] = [
      makeMsg({ id: "m1", role: "user", content: "Hello there", isAudio: false }),
      makeMsg({ id: "m2", role: "assistant", content: "Hi! How can I help?", isAudio: false }),
    ];
    const meta = makeMeta();

    const serialized = serializeChat(messages, meta);
    const result = parseChat(serialized, "chats/test.md");

    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.messages).toHaveLength(2);

    const [m1, m2] = result.messages;
    expect(m1.id).toBe("m1");
    expect(m1.role).toBe("user");
    expect(m1.content).toBe("Hello there");
    expect(m1.isAudio).toBe(false);
    expect(m1.timestamp.getTime()).toBe(messages[0].timestamp.getTime());

    expect(m2.id).toBe("m2");
    expect(m2.role).toBe("assistant");
    expect(m2.content).toBe("Hi! How can I help?");
    expect(m2.isAudio).toBe(false);
  });

  it("preserves frontmatter fields", () => {
    const meta = makeMeta({
      skill: "coding",
      sessionId: "sess-456",
      hasAudio: true,
      tags: ["alpha", "beta"],
    });
    const messages: Message[] = [
      makeMsg({ id: "m1", role: "user", content: "test" }),
    ];

    const serialized = serializeChat(messages, meta);
    const result = parseChat(serialized, "chats/fm.md");

    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.frontmatter.type).toBe("openbrain-chat");
    expect(result.frontmatter.formatVersion).toBe(1);
    expect(result.frontmatter.created).toBe("2026-03-15 10:00");
    expect(result.frontmatter.updated).toBe("2026-03-15 10:05");
    expect(result.frontmatter.skill).toBe("coding");
    expect(result.frontmatter.sessionId).toBe("sess-456");
    expect(result.frontmatter.hasAudio).toBe(true);
    expect(result.frontmatter.title).toBe("Test chat");
    expect(result.frontmatter.tags).toEqual(["alpha", "beta"]);
  });

  it("handles unicode content", () => {
    const messages: Message[] = [
      makeMsg({ id: "u1", role: "user", content: "Caf\u00e9 \u2014 \u00fcber \u2603 \u2764\ufe0f \ud83d\ude80" }),
    ];
    const meta = makeMeta();

    const serialized = serializeChat(messages, meta);
    const result = parseChat(serialized, "chats/unicode.md");

    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.messages[0].content).toBe("Caf\u00e9 \u2014 \u00fcber \u2603 \u2764\ufe0f \ud83d\ude80");
  });

  it("handles title with quotes", () => {
    const meta = makeMeta({ title: 'She said "hello"' });
    const messages: Message[] = [
      makeMsg({ id: "q1", role: "user", content: "test" }),
    ];

    const serialized = serializeChat(messages, meta);
    const result = parseChat(serialized, "chats/quotes.md");

    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.frontmatter.title).toBe('She said \\"hello\\"');
  });
});

// ── parseChat error cases ───────────────────────────────────────────────

describe("parseChat error handling", () => {
  it("rejects missing frontmatter", () => {
    const result = parseChat("# Just a heading\nSome content", "bad.md");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe("Missing frontmatter");
    }
  });

  it("rejects format_version > 1", () => {
    const content = [
      "---",
      'type: "openbrain-chat"',
      "format_version: 2",
      'created: "2026-03-15"',
      'updated: "2026-03-15"',
      'skill: "general"',
      'session_id: "abc"',
      "message_count: 0",
      "has_audio: false",
      'title: "Test"',
      "tags: []",
      "---",
      "",
    ].join("\n");

    const result = parseChat(content, "v2.md");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Unsupported format_version");
    }
  });

  it("handles empty body (0 messages)", () => {
    const meta = makeMeta({ messageCount: 0 });
    const messages: Message[] = [];
    const serialized = serializeChat(messages, meta);
    const result = parseChat(serialized, "chats/empty.md");

    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.messages).toHaveLength(0);
    expect(result.frontmatter.messageCount).toBe(0);
  });
});

// ── generateChatTitle ───────────────────────────────────────────────────

describe("generateChatTitle", () => {
  it("returns first 60 chars of first user message", () => {
    const messages: Message[] = [
      makeMsg({ id: "t1", role: "user", content: "Hello world" }),
    ];
    expect(generateChatTitle(messages)).toBe("Hello world");
  });

  it("truncates long messages to 60 chars with ellipsis", () => {
    const longText = "A".repeat(80);
    const messages: Message[] = [
      makeMsg({ id: "t2", role: "user", content: longText }),
    ];
    const title = generateChatTitle(messages);
    expect(title.length).toBeLessThanOrEqual(61); // 60 chars + ellipsis character
    expect(title).toMatch(/\u2026$/); // ends with ellipsis
  });

  it('returns "Untitled chat" for no user messages', () => {
    const messages: Message[] = [
      makeMsg({ id: "t3", role: "assistant", content: "I am an assistant" }),
    ];
    expect(generateChatTitle(messages)).toBe("Untitled chat");
  });

  it('returns "Untitled chat" for empty array', () => {
    expect(generateChatTitle([])).toBe("Untitled chat");
  });

  it("returns voice fallback for microphone emoji", () => {
    const messages: Message[] = [
      makeMsg({ id: "t4", role: "user", content: "\uD83C\uDFA4 voice message" }),
    ];
    const title = generateChatTitle(messages);
    expect(title).toMatch(/^Voice chat/);
  });

  it("strips markdown formatting", () => {
    const messages: Message[] = [
      makeMsg({ id: "t5", role: "user", content: "**bold** and _italic_ and `code`" }),
    ];
    const title = generateChatTitle(messages);
    expect(title).not.toContain("**");
    expect(title).not.toContain("_");
    expect(title).not.toContain("`");
    expect(title).toBe("bold and italic and code");
  });
});

// ── generateChatFilename ────────────────────────────────────────────────

describe("generateChatFilename", () => {
  it("matches YYYY-MM-DD-HHmmss-xxx.md pattern", () => {
    const filename = generateChatFilename();
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9]{3}\.md$/);
  });

  it("generates unique names on consecutive calls", () => {
    const names = new Set<string>();
    for (let i = 0; i < 20; i++) {
      names.add(generateChatFilename());
    }
    // With random suffix, collisions are extremely unlikely
    // Allow for at most 1 collision in 20 calls
    expect(names.size).toBeGreaterThanOrEqual(19);
  });
});
