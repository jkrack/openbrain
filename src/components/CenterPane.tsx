import { App } from "obsidian";
import { OpenBrainSettings } from "../settings";
import { Skill } from "../skills";
import { ChatStateManager } from "../chatStateManager";
import { VaultIndex } from "../vaultIndex";
import { CenterView } from "./DetachedPanel";

interface CenterPaneProps {
  app: App;
  settings: OpenBrainSettings;
  skills: Skill[];
  chatState: ChatStateManager;
  vaultIndex: VaultIndex | null;
  component: any;
  centerView: CenterView;
  onAttach: () => void;
}

export function CenterPane({
  app: _app,
  settings: _settings,
  skills: _skills,
  chatState,
  vaultIndex: _vaultIndex,
  component: _component,
  centerView,
  onAttach,
}: CenterPaneProps) {
  const state = chatState.getState();

  return (
    <div className="ob-detached-center">
      <div className="ob-detached-center-header">
        <span className="ob-detached-center-title">
          {centerView === "chat" && ((state.meta?.title as string | undefined) || "New Chat")}
          {centerView === "skills" && "Skills"}
          {centerView === "graph" && "Knowledge Graph"}
          {centerView === "tasks" && "Tasks"}
        </span>
        <button className="ob-detached-attach-btn" onClick={onAttach}>
          Attach
        </button>
      </div>
      <div className="ob-detached-center-body">
        {centerView === "chat" && (
          <div className="ob-detached-chat-placeholder">
            Chat view — will be wired when panel.tsx is refactored to use ChatStateManager
          </div>
        )}
        {centerView === "skills" && (
          <div className="ob-detached-placeholder">Skills browser — Phase 3</div>
        )}
        {centerView === "graph" && (
          <div className="ob-detached-placeholder">Graph dashboard — Phase 3</div>
        )}
        {centerView === "tasks" && (
          <div className="ob-detached-placeholder">Task dashboard — Phase 3</div>
        )}
      </div>
    </div>
  );
}
