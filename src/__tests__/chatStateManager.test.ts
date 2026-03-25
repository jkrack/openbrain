import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock obsidian — Events class needs on/off/trigger
vi.mock("obsidian", () => {
  class Events {
    private _listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

    on(name: string, callback: (...args: unknown[]) => void): { name: string; fn: (...args: unknown[]) => void } {
      if (!this._listeners[name]) this._listeners[name] = [];
      this._listeners[name].push(callback);
      return { name, fn: callback };
    }

    off(name: string, callback: (...args: unknown[]) => void): void {
      if (!this._listeners[name]) return;
      this._listeners[name] = this._listeners[name].filter((fn) => fn !== callback);
    }

    trigger(name: string, ...data: unknown[]): void {
      if (!this._listeners[name]) return;
      for (const fn of this._listeners[name]) fn(...data);
    }
  }

  return { Events };
});

import { ChatStateManager } from "../chatStateManager";
import type { Message } from "../providers/types";

// ── Helpers ───────────────────────────────────────────────────────────────

function makeMsg(overrides: Partial<Message> & { id: string; role: "user" | "assistant"; content: string }): Message {
  return {
    timestamp: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

// ── Initial state ─────────────────────────────────────────────────────────

describe("ChatStateManager — initial state", () => {
  let mgr: ChatStateManager;

  beforeEach(() => {
    mgr = new ChatStateManager();
  });

  it("starts with empty messages", () => {
    expect(mgr.getState().messages).toEqual([]);
  });

  it("starts with isStreaming false", () => {
    expect(mgr.getState().isStreaming).toBe(false);
  });

  it("starts with null chatFilePath", () => {
    expect(mgr.getState().chatFilePath).toBeNull();
  });

  it("starts with null activeSkillId", () => {
    expect(mgr.getState().activeSkillId).toBeNull();
  });

  it("starts with chatMode agent", () => {
    expect(mgr.getState().chatMode).toBe("agent");
  });

  it("starts with allowWrite false", () => {
    expect(mgr.getState().allowWrite).toBe(false);
  });

  it("starts with allowCli false", () => {
    expect(mgr.getState().allowCli).toBe(false);
  });

  it("starts with empty toolActivity", () => {
    expect(mgr.getState().toolActivity).toEqual([]);
  });

  it("starts with null activeContext", () => {
    expect(mgr.getState().activeContext).toBeNull();
  });

  it("starts with null graphContext", () => {
    expect(mgr.getState().graphContext).toBeNull();
  });

  it("starts with null meta", () => {
    expect(mgr.getState().meta).toBeNull();
  });
});

// ── addMessage ────────────────────────────────────────────────────────────

describe("ChatStateManager — addMessage", () => {
  let mgr: ChatStateManager;

  beforeEach(() => {
    mgr = new ChatStateManager();
  });

  it("appends a message to the messages array", () => {
    const msg = makeMsg({ id: "m1", role: "user", content: "hello" });
    mgr.addMessage(msg);
    expect(mgr.getState().messages).toHaveLength(1);
    expect(mgr.getState().messages[0]).toEqual(msg);
  });

  it("emits change event on addMessage", () => {
    const listener = vi.fn();
    mgr.on("change", listener);
    mgr.addMessage(makeMsg({ id: "m1", role: "user", content: "hi" }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not mutate the original message object", () => {
    const msg = makeMsg({ id: "m1", role: "user", content: "hi" });
    mgr.addMessage(msg);
    expect(mgr.getState().messages[0]).toBe(msg);
  });
});

// ── setStreaming ──────────────────────────────────────────────────────────

describe("ChatStateManager — setStreaming", () => {
  let mgr: ChatStateManager;

  beforeEach(() => {
    mgr = new ChatStateManager();
  });

  it("updates isStreaming to true", () => {
    mgr.setStreaming(true);
    expect(mgr.getState().isStreaming).toBe(true);
  });

  it("updates isStreaming to false", () => {
    mgr.setStreaming(true);
    mgr.setStreaming(false);
    expect(mgr.getState().isStreaming).toBe(false);
  });

  it("emits change event on setStreaming", () => {
    const listener = vi.fn();
    mgr.on("change", listener);
    mgr.setStreaming(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does NOT clear toolActivity when streaming ends", () => {
    mgr.addToolActivity({ id: "t1", name: "vault_search", status: "running", input: {} });
    mgr.setStreaming(false);
    expect(mgr.getState().toolActivity).toHaveLength(1);
  });
});

// ── appendToLastAssistant ─────────────────────────────────────────────────

describe("ChatStateManager — appendToLastAssistant", () => {
  let mgr: ChatStateManager;

  beforeEach(() => {
    mgr = new ChatStateManager();
  });

  it("appends text to the last assistant message", () => {
    const msg = makeMsg({ id: "a1", role: "assistant", content: "Hello" });
    mgr.addMessage(msg);
    mgr.appendToLastAssistant(" world");
    expect(mgr.getState().messages[0].content).toBe("Hello world");
  });

  it("is a no-op when there are no messages", () => {
    const listener = vi.fn();
    mgr.on("change", listener);
    expect(() => mgr.appendToLastAssistant("text")).not.toThrow();
    expect(mgr.getState().messages).toHaveLength(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it("is a no-op when last message is not assistant", () => {
    mgr.addMessage(makeMsg({ id: "u1", role: "user", content: "hi" }));
    const listener = vi.fn();
    mgr.on("change", listener);
    mgr.appendToLastAssistant("text");
    expect(mgr.getState().messages[0].content).toBe("hi");
    expect(listener).not.toHaveBeenCalled();
  });

  it("appends to the last message when there are multiple", () => {
    mgr.addMessage(makeMsg({ id: "u1", role: "user", content: "hi" }));
    mgr.addMessage(makeMsg({ id: "a1", role: "assistant", content: "hello" }));
    mgr.addMessage(makeMsg({ id: "a2", role: "assistant", content: "there" }));
    mgr.appendToLastAssistant("!");
    const msgs = mgr.getState().messages;
    expect(msgs[2].content).toBe("there!");
    expect(msgs[1].content).toBe("hello");
  });

  it("emits change event on appendToLastAssistant", () => {
    mgr.addMessage(makeMsg({ id: "a1", role: "assistant", content: "hi" }));
    const listener = vi.fn();
    mgr.on("change", listener);
    mgr.appendToLastAssistant(" there");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ── addToolActivity / updateToolActivity ──────────────────────────────────

describe("ChatStateManager — toolActivity", () => {
  let mgr: ChatStateManager;

  beforeEach(() => {
    mgr = new ChatStateManager();
  });

  it("adds a tool activity entry", () => {
    mgr.addToolActivity({ id: "t1", name: "vault_search", status: "running", input: { query: "foo" } });
    expect(mgr.getState().toolActivity).toHaveLength(1);
    expect(mgr.getState().toolActivity[0]).toMatchObject({ id: "t1", name: "vault_search", status: "running" });
  });

  it("emits change on addToolActivity", () => {
    const listener = vi.fn();
    mgr.on("change", listener);
    mgr.addToolActivity({ id: "t1", name: "vault_search", status: "running", input: {} });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("allows multiple entries for the same tool name with different IDs", () => {
    mgr.addToolActivity({ id: "t1", name: "vault_search", status: "running", input: {} });
    mgr.addToolActivity({ id: "t2", name: "vault_search", status: "running", input: {} });
    expect(mgr.getState().toolActivity).toHaveLength(2);
  });

  it("updates a tool activity by unique ID", () => {
    mgr.addToolActivity({ id: "t1", name: "vault_search", status: "running", input: {} });
    mgr.addToolActivity({ id: "t2", name: "vault_search", status: "running", input: {} });
    mgr.updateToolActivity("t1", { status: "done", result: "found 3 results" });
    const activities = mgr.getState().toolActivity;
    expect(activities.find((a) => a.id === "t1")?.status).toBe("done");
    expect(activities.find((a) => a.id === "t1")?.result).toBe("found 3 results");
    expect(activities.find((a) => a.id === "t2")?.status).toBe("running");
  });

  it("emits change on updateToolActivity", () => {
    mgr.addToolActivity({ id: "t1", name: "vault_search", status: "running", input: {} });
    const listener = vi.fn();
    mgr.on("change", listener);
    mgr.updateToolActivity("t1", { status: "done" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("is a no-op update when ID not found", () => {
    mgr.addToolActivity({ id: "t1", name: "vault_search", status: "running", input: {} });
    const listener = vi.fn();
    mgr.on("change", listener);
    mgr.updateToolActivity("nonexistent", { status: "done" });
    expect(mgr.getState().toolActivity[0].status).toBe("running");
    expect(listener).not.toHaveBeenCalled();
  });
});

// ── setters for simple fields ─────────────────────────────────────────────

describe("ChatStateManager — simple field setters", () => {
  let mgr: ChatStateManager;

  beforeEach(() => {
    mgr = new ChatStateManager();
  });

  it("setChatFilePath updates chatFilePath and emits change", () => {
    const listener = vi.fn();
    mgr.on("change", listener);
    mgr.setChatFilePath("OpenBrain/chats/chat1.md");
    expect(mgr.getState().chatFilePath).toBe("OpenBrain/chats/chat1.md");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("setActiveSkillId updates activeSkillId and emits change", () => {
    const listener = vi.fn();
    mgr.on("change", listener);
    mgr.setActiveSkillId("meeting-notes");
    expect(mgr.getState().activeSkillId).toBe("meeting-notes");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("setChatMode updates chatMode and emits change", () => {
    const listener = vi.fn();
    mgr.on("change", listener);
    mgr.setChatMode("chat");
    expect(mgr.getState().chatMode).toBe("chat");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("setAllowWrite updates allowWrite and emits change", () => {
    const listener = vi.fn();
    mgr.on("change", listener);
    mgr.setAllowWrite(true);
    expect(mgr.getState().allowWrite).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("setAllowCli updates allowCli and emits change", () => {
    const listener = vi.fn();
    mgr.on("change", listener);
    mgr.setAllowCli(true);
    expect(mgr.getState().allowCli).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("setActiveContext updates activeContext and emits change", () => {
    const listener = vi.fn();
    mgr.on("change", listener);
    mgr.setActiveContext("some context text");
    expect(mgr.getState().activeContext).toBe("some context text");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("setGraphContext updates graphContext and emits change", () => {
    const listener = vi.fn();
    mgr.on("change", listener);
    mgr.setGraphContext("graph data");
    expect(mgr.getState().graphContext).toBe("graph data");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("setMeta updates meta and emits change", () => {
    const listener = vi.fn();
    mgr.on("change", listener);
    const meta = { title: "My Chat", sessionId: "abc", created: "2026-01-01" };
    mgr.setMeta(meta);
    expect(mgr.getState().meta).toEqual(meta);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ── reset ─────────────────────────────────────────────────────────────────

describe("ChatStateManager — reset", () => {
  let mgr: ChatStateManager;

  beforeEach(() => {
    mgr = new ChatStateManager();
  });

  it("clears all state back to defaults", () => {
    mgr.addMessage(makeMsg({ id: "m1", role: "user", content: "hi" }));
    mgr.setStreaming(true);
    mgr.setChatFilePath("some/path.md");
    mgr.setActiveSkillId("skill1");
    mgr.setChatMode("chat");
    mgr.setAllowWrite(true);
    mgr.setAllowCli(true);
    mgr.addToolActivity({ id: "t1", name: "vault_search", status: "running", input: {} });
    mgr.setActiveContext("context");
    mgr.setGraphContext("graph");
    mgr.setMeta({ title: "Test" });

    mgr.reset();

    const state = mgr.getState();
    expect(state.messages).toEqual([]);
    expect(state.isStreaming).toBe(false);
    expect(state.chatFilePath).toBeNull();
    expect(state.activeSkillId).toBeNull();
    expect(state.chatMode).toBe("agent");
    expect(state.allowWrite).toBe(false);
    expect(state.allowCli).toBe(false);
    expect(state.toolActivity).toEqual([]);
    expect(state.activeContext).toBeNull();
    expect(state.graphContext).toBeNull();
    expect(state.meta).toBeNull();
  });

  it("emits change event on reset", () => {
    const listener = vi.fn();
    mgr.on("change", listener);
    mgr.reset();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ── unsubscribe (off) ─────────────────────────────────────────────────────

describe("ChatStateManager — unsubscribe", () => {
  let mgr: ChatStateManager;

  beforeEach(() => {
    mgr = new ChatStateManager();
  });

  it("off removes a listener so it no longer receives events", () => {
    const listener = vi.fn();
    mgr.on("change", listener);
    mgr.setStreaming(true);
    expect(listener).toHaveBeenCalledTimes(1);

    mgr.off("change", listener);
    mgr.setStreaming(false);
    expect(listener).toHaveBeenCalledTimes(1); // still 1, not called again
  });

  it("other listeners still receive events after one is removed", () => {
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    mgr.on("change", listener1);
    mgr.on("change", listener2);

    mgr.off("change", listener1);
    mgr.setStreaming(true);

    expect(listener1).not.toHaveBeenCalled();
    expect(listener2).toHaveBeenCalledTimes(1);
  });
});
