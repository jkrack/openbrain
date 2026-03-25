import { App } from "obsidian";
import { useState, useEffect, useCallback } from "react";
import { OpenBrainSettings } from "../settings";
import { Skill } from "../skills";
import { ChatStateManager } from "../chatStateManager";
import { VaultIndex } from "../vaultIndex";
import { ChatListSidebar } from "./ChatListSidebar";
import { ContextPanel } from "./ContextPanel";
import { CenterPane } from "./CenterPane";

interface DetachedPanelProps {
  app: App;
  settings: OpenBrainSettings;
  skills: Skill[];
  chatState: ChatStateManager;
  vaultIndex: VaultIndex | null;
  component: any;
  onAttach: () => void;
}

export type CenterView = "chat" | "skills" | "graph" | "tasks";

export function DetachedPanel({
  app, settings, skills, chatState, vaultIndex, component, onAttach,
}: DetachedPanelProps) {
  const [centerView, setCenterView] = useState<CenterView>("chat");
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const handler = () => forceUpdate((n) => n + 1);
    chatState.on("change", handler);
    return () => { chatState.off("change", handler); };
  }, [chatState]);

  const handleNavClick = useCallback((view: CenterView | "settings") => {
    if (view === "settings") {
      // Open Obsidian's built-in settings
      (app as any).setting?.open();
      return;
    }
    setCenterView(view);
  }, [app]);

  const handleChatSelect = useCallback((_path: string) => {
    setCenterView("chat");
    // Chat loading will be wired in a later task
  }, []);

  return (
    <div className="ob-detached-layout">
      <ChatListSidebar
        app={app}
        settings={settings}
        activeChatPath={chatState.getState().chatFilePath}
        activeView={centerView}
        onChatSelect={handleChatSelect}
        onNavClick={handleNavClick}
      />
      <CenterPane
        app={app}
        settings={settings}
        skills={skills}
        chatState={chatState}
        vaultIndex={vaultIndex}
        component={component}
        centerView={centerView}
        onAttach={onAttach}
      />
      <ContextPanel
        settings={settings}
        chatState={chatState}
        vaultIndex={vaultIndex}
      />
    </div>
  );
}
