import { Events } from "obsidian";
import { Message } from "./providers/types";

// ── ToolActivity ───────────────────────────────────────────────────────────

export interface ToolActivity {
  /** Unique ID for this specific tool invocation (not just the tool name). */
  id: string;
  name: string;
  status: "running" | "complete" | "error";
  durationMs?: number;
}

// ── ChatState ──────────────────────────────────────────────────────────────

export interface ChatState {
  messages: Message[];
  isStreaming: boolean;
  chatFilePath: string | null;
  activeSkillId: string | null;
  chatMode: "agent" | "chat";
  allowWrite: boolean;
  allowCli: boolean;
  toolActivity: ToolActivity[];
  activeContext: string[];
  graphContext: { path: string; hop: number; relationship: string }[];
  meta: { title: string; sessionId: string; hasAudio: boolean; tags: string[] } | null;
}

function defaultState(): ChatState {
  return {
    messages: [],
    isStreaming: false,
    chatFilePath: null,
    activeSkillId: null,
    chatMode: "agent",
    allowWrite: false,
    allowCli: false,
    toolActivity: [],
    activeContext: [],
    graphContext: [],
    meta: null,
  };
}

// ── ChatStateManager ───────────────────────────────────────────────────────

/**
 * Shared state container for the OpenBrain chat session.
 *
 * Both the sidebar panel and the detached window subscribe to this via
 * Obsidian's Events pattern. Every mutation method triggers a "change"
 * event so subscribers can re-render.
 */
export class ChatStateManager extends Events {
  private state: ChatState = defaultState();

  // ── Read ────────────────────────────────────────────────────────────────

  getState(): Readonly<ChatState> {
    return this.state;
  }

  // ── Messages ─────────────────────────────────────────────────────────────

  addMessage(msg: Message): void {
    this.state = { ...this.state, messages: [...this.state.messages, msg] };
    this.trigger("change");
  }

  /**
   * Append text to the content of the last assistant message.
   * No-op when there are no messages or when the last message is not an
   * assistant message.
   */
  appendToLastAssistant(text: string): void {
    const messages = this.state.messages;
    if (messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (last.role !== "assistant") return;
    if (typeof last.content !== "string") return;

    const updated: Message = { ...last, content: last.content + text };
    this.state = {
      ...this.state,
      messages: [...messages.slice(0, -1), updated],
    };
    this.trigger("change");
  }

  // ── Streaming ────────────────────────────────────────────────────────────

  /**
   * Set the streaming flag.
   * Note: toolActivity is intentionally NOT cleared when streaming ends —
   * only reset() clears it.
   */
  setStreaming(value: boolean): void {
    this.state = { ...this.state, isStreaming: value };
    this.trigger("change");
  }

  // ── Tool activity ─────────────────────────────────────────────────────────

  addToolActivity(entry: ToolActivity): void {
    this.state = {
      ...this.state,
      toolActivity: [...this.state.toolActivity, entry],
    };
    this.trigger("change");
  }

  /**
   * Update an existing tool activity entry by its unique `id`.
   * No-op (and no "change" event) when the ID is not found.
   */
  updateToolActivity(id: string, update: Partial<Omit<ToolActivity, "id">>): void {
    const idx = this.state.toolActivity.findIndex((e) => e.id === id);
    if (idx === -1) return; // no-op, don't trigger
    this.state = {
      ...this.state,
      toolActivity: this.state.toolActivity.map((entry) =>
        entry.id === id ? { ...entry, ...update } : entry
      ),
    };
    this.trigger("change");
  }

  // ── Simple field setters ──────────────────────────────────────────────────

  setChatFilePath(path: string | null): void {
    this.state = { ...this.state, chatFilePath: path };
    this.trigger("change");
  }

  setActiveSkillId(id: string | null): void {
    this.state = { ...this.state, activeSkillId: id };
    this.trigger("change");
  }

  setChatMode(mode: "agent" | "chat"): void {
    this.state = { ...this.state, chatMode: mode };
    this.trigger("change");
  }

  setAllowWrite(value: boolean): void {
    this.state = { ...this.state, allowWrite: value };
    this.trigger("change");
  }

  setAllowCli(value: boolean): void {
    this.state = { ...this.state, allowCli: value };
    this.trigger("change");
  }

  setActiveContext(context: string[]): void {
    this.state = { ...this.state, activeContext: context };
    this.trigger("change");
  }

  setGraphContext(context: { path: string; hop: number; relationship: string }[]): void {
    this.state = { ...this.state, graphContext: context };
    this.trigger("change");
  }

  setMeta(meta: { title: string; sessionId: string; hasAudio: boolean; tags: string[] } | null): void {
    this.state = { ...this.state, meta };
    this.trigger("change");
  }

  // ── Reset ─────────────────────────────────────────────────────────────────

  /** Clear all state back to initial defaults and trigger a change event. */
  reset(): void {
    this.state = defaultState();
    this.trigger("change");
  }
}
