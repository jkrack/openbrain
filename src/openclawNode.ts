import { App, TFile } from "obsidian";
import { OpenBrainSettings } from "./settings";
import { appendToDailySection } from "./chatHistory";
import * as cli from "./obsidianCli";
import { loadPeople } from "./people";

/**
 * OpenClaw node — registers OpenBrain as a node on the OpenClaw gateway.
 * Exposes vault operations as invocable commands from any messaging channel.
 */

interface InvokeRequest {
  type: "req";
  id: string;
  method: "node.invoke";
  params: {
    command: string;
    params: Record<string, string>;
  };
}

const COMMANDS: Record<string, { description: string; params: Record<string, string> }> = {
  "vault.search": {
    description: "Full-text search across the vault",
    params: { query: "string" },
  },
  "vault.read": {
    description: "Read a note's content",
    params: { path: "string" },
  },
  "vault.create": {
    description: "Create a new note",
    params: { name: "string", content: "string (optional)", template: "string (optional)" },
  },
  "vault.daily.read": {
    description: "Read today's daily note",
    params: {},
  },
  "vault.daily.append": {
    description: "Append text to a section of today's daily note",
    params: { section: "string", content: "string" },
  },
  "vault.capture": {
    description: "Quick capture to today's daily note",
    params: { text: "string" },
  },
  "vault.tasks": {
    description: "Get tasks from a file or daily note",
    params: { file: "string (optional)", filter: "todo|done (optional)" },
  },
  "vault.skills.list": {
    description: "List available OpenBrain skills",
    params: {},
  },
  "vault.people.list": {
    description: "List person profiles",
    params: {},
  },
  "vault.chat.search": {
    description: "Search chat history by title or content",
    params: { query: "string" },
  },
};

export class OpenClawNode {
  private app: App;
  private settings: OpenBrainSettings;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private connected = false;
  private destroyed = false;

  constructor(app: App, settings: OpenBrainSettings) {
    this.app = app;
    this.settings = settings;
  }

  connect(): void {
    if (this.destroyed || !this.settings.openclawEnabled) return;

    const url = this.settings.openclawGatewayUrl || "ws://127.0.0.1:18789";

    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.connected = true;
        this.reconnectDelay = 1000;

        // Send connect request
        this.send({
          type: "req",
          id: crypto.randomUUID(),
          method: "connect",
          params: {
            minProtocol: 1,
            maxProtocol: 1,
            name: "OpenBrain",
            version: "1.0.0",
            platform: "obsidian",
            mode: "node",
            capabilities: ["vault"],
            commands: COMMANDS,
            permissions: {
              "vault.read": true,
              "vault.write": this.settings.allowVaultWrite,
              "vault.cli": this.settings.allowCliExec,
            },
          },
        });
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as Record<string, unknown>;
          if (msg.method === "node.invoke") {
            void this.handleInvoke(msg as unknown as InvokeRequest);
          }
          // Handle challenge if needed — no auth for localhost
        } catch { /* expected — ignore malformed messages */ }
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        /* expected — onclose will fire after this */
      };
    } catch { /* expected — WebSocket constructor may fail */
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      this.connect();
    }, this.reconnectDelay);
  }

  private send(data: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private async handleInvoke(msg: InvokeRequest): Promise<void> {
    const { command, params } = msg.params;
    let result: Record<string, unknown> | undefined;
    let error: string | null = null;

    try {
      result = await this.executeCommand(command, params);
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Command failed";
    }

    this.send({
      type: "res",
      id: msg.id,
      ok: !error,
      payload: error ? undefined : result,
      error: error ? { code: "COMMAND_ERROR", message: error } : undefined,
    });
  }

  private async executeCommand(command: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    switch (command) {
      case "vault.search": {
        if (!params.query) throw new Error("query required");
        const results = cli.search(params.query);
        return { results: results || "No results" };
      }

      case "vault.read": {
        if (!params.path) throw new Error("path required");
        const file = this.app.vault.getAbstractFileByPath(params.path);
        if (!(file instanceof TFile)) throw new Error("File not found");
        const content = await this.app.vault.read(file);
        return { path: params.path, content };
      }

      case "vault.create": {
        if (!this.settings.allowVaultWrite) throw new Error("Write permission disabled");
        if (!params.name) throw new Error("name required");
        const success = cli.createNote(params.name, {
          content: params.content,
          template: params.template,
        });
        return { ok: success, path: params.name };
      }

      case "vault.daily.read": {
        const content = cli.dailyRead();
        return { content: content || "No daily note found" };
      }

      case "vault.daily.append": {
        if (!this.settings.allowVaultWrite) throw new Error("Write permission disabled");
        if (!params.section || !params.content) throw new Error("section and content required");
        await appendToDailySection(this.app, params.content, params.section, this.settings);
        return { ok: true };
      }

      case "vault.capture": {
        if (!this.settings.allowVaultWrite) throw new Error("Write permission disabled");
        if (!params.text) throw new Error("text required");
        const formatted = params.text.startsWith("- ") ? params.text : `- ${params.text}`;
        await appendToDailySection(this.app, formatted, "Capture", this.settings);
        return { ok: true };
      }

      case "vault.tasks": {
        const taskFilter = (params.filter === "todo" || params.filter === "done") ? params.filter : undefined;
        if (params.file) {
          const result = cli.tasks(params.file, taskFilter);
          return { tasks: result || "No tasks found" };
        }
        const result = cli.dailyTasks(taskFilter);
        return { tasks: result || "No tasks found" };
      }

      case "vault.skills.list": {
        const skillsFolder = this.settings.skillsFolder || "OpenBrain/skills";
        const files = this.app.vault.getMarkdownFiles()
          .filter((f) => f.path.startsWith(skillsFolder + "/"));
        return {
          skills: files.map((f) => {
            const cache = this.app.metadataCache.getFileCache(f);
            return {
              name: cache?.frontmatter?.name || f.basename,
              description: cache?.frontmatter?.description || "",
            };
          }),
        };
      }

      case "vault.people.list": {
        const people = await loadPeople(this.app);
        return {
          people: people.map((p) => ({
            name: p.name,
            role: p.role,
            domain: p.domain,
            projects: p.projects,
          })),
        };
      }

      case "vault.chat.search": {
        if (!params.query) throw new Error("query required");
        const chatFolder = this.settings.chatFolder || "OpenBrain/chats";
        const q = params.query.toLowerCase();
        const matches: { path: string; title: string; skill: string }[] = [];

        const files = this.app.vault.getMarkdownFiles()
          .filter((f) => f.path.startsWith(chatFolder + "/"));

        for (const file of files) {
          const cache = this.app.metadataCache.getFileCache(file);
          const fm = cache?.frontmatter;
          if (fm?.type !== "openbrain-chat") continue;

          const title = (fm.title || "").toLowerCase();
          if (title.includes(q) || (fm.skill || "").toLowerCase().includes(q)) {
            matches.push({
              path: file.path,
              title: fm.title || file.basename,
              skill: fm.skill || "",
            });
          }
        }

        return { matches };
      }

      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }
}
