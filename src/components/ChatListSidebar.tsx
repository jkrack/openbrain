import { App, TFile } from "obsidian";
import { useState, useEffect } from "react";
import { OpenBrainSettings } from "../settings";
import { CenterView } from "./DetachedPanel";

interface ChatListSidebarProps {
  app: App;
  settings: OpenBrainSettings;
  activeChatPath: string | null;
  activeView: string;
  onChatSelect: (path: string) => void;
  onNavClick: (view: CenterView | "settings") => void;
}

interface ChatEntry {
  path: string;
  title: string;
  updated: string;
}

export function ChatListSidebar({
  app, settings, activeChatPath, activeView, onChatSelect, onNavClick,
}: ChatListSidebarProps) {
  const [chats, setChats] = useState<ChatEntry[]>([]);

  useEffect(() => {
    const folder = settings.chatFolder || "OpenBrain/chats";
    const files = app.vault.getMarkdownFiles()
      .filter((f: TFile) => f.path.startsWith(folder + "/"))
      .sort((a: TFile, b: TFile) => b.stat.mtime - a.stat.mtime)
      .slice(0, 30);
    const entries: ChatEntry[] = [];
    for (const file of files) {
      const cache = app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (fm?.type !== "openbrain-chat") continue;
      entries.push({
        path: file.path,
        title: fm.title || file.basename,
        updated: fm.updated || new Date(file.stat.mtime).toISOString(),
      });
    }
    setChats(entries);
  }, [app, settings.chatFolder]);

  // Group by date
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const groups: { label: string; items: ChatEntry[] }[] = [];
  const todayItems = chats.filter((c) => c.updated.startsWith(today));
  const yesterdayItems = chats.filter((c) => c.updated.startsWith(yesterday));
  const olderItems = chats.filter(
    (c) => !c.updated.startsWith(today) && !c.updated.startsWith(yesterday)
  );

  if (todayItems.length) groups.push({ label: "Today", items: todayItems });
  if (yesterdayItems.length) groups.push({ label: "Yesterday", items: yesterdayItems });
  if (olderItems.length) groups.push({ label: "Earlier", items: olderItems });

  return (
    <div className="ob-detached-sidebar">
      <div className="ob-detached-sidebar-header">
        <span className="ob-detached-logo">OpenBrain</span>
      </div>
      <button className="ob-detached-new-chat" onClick={() => onNavClick("chat")}>
        + New Chat
      </button>
      <div className="ob-detached-chat-list">
        {groups.map((group) => (
          <div key={group.label}>
            <div className="ob-detached-group-label">{group.label}</div>
            {group.items.map((chat) => (
              <div
                key={chat.path}
                className={`ob-detached-chat-item ${chat.path === activeChatPath ? "active" : ""}`}
                onClick={() => onChatSelect(chat.path)}
              >
                {chat.title}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="ob-detached-bottom-nav">
        <div className={`ob-detached-nav-item ${activeView === "skills" ? "active" : ""}`} onClick={() => onNavClick("skills")}>Skills</div>
        <div className={`ob-detached-nav-item ${activeView === "graph" ? "active" : ""}`} onClick={() => onNavClick("graph")}>Graph</div>
        <div className={`ob-detached-nav-item ${activeView === "tasks" ? "active" : ""}`} onClick={() => onNavClick("tasks")}>Tasks</div>
        <div className="ob-detached-nav-item" onClick={() => onNavClick("settings")}>Settings</div>
      </div>
    </div>
  );
}
