import { App } from "obsidian";
import { OpenBrainSettings } from "../settings";
import { Skill } from "../skills";
import { ChatStateManager } from "../chatStateManager";
import { VaultIndex } from "../vaultIndex";
import { CenterView } from "./DetachedPanel";
import { SkillsBrowser } from "./SkillsBrowser";
import { GraphDashboard } from "./GraphDashboard";
import { TaskTray } from "./TaskTray";

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
  app,
  settings,
  skills,
  chatState,
  vaultIndex,
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
          <SkillsBrowser
            skills={skills}
            chatState={chatState}
            onSkillRun={(id) => { chatState.setActiveSkillId(id); }}
          />
        )}
        {centerView === "graph" && (
          <GraphDashboard vaultIndex={vaultIndex} />
        )}
        {centerView === "tasks" && (
          <TaskTray
            app={app}
            settings={settings}
            isOpen={true}
            fullPane={true}
            onClose={() => {}}
            onFocusTask={() => {}}
          />
        )}
      </div>
    </div>
  );
}
