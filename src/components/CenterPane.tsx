import { useState, useRef, useCallback, useEffect } from "react";
import { App } from "obsidian";
import { OpenBrainSettings } from "../settings";
import { Skill } from "../skills";
import { ChatStateManager } from "../chatStateManager";
import { VaultIndex } from "../vaultIndex";
import { CenterView } from "./DetachedPanel";
import { SkillsBrowser } from "./SkillsBrowser";
import { GraphDashboard } from "./GraphDashboard";
import { TaskTray } from "./TaskTray";
import { MessageThread } from "./MessageThread";
import { InputArea } from "./InputArea";

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
  component,
  centerView,
  onAttach,
}: CenterPaneProps) {
  const state = chatState.getState();

  // Local input state for the detached chat input
  const [input, setInput] = useState("");

  // Auto-scroll to bottom of message thread
  const threadRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [state.messages.length, state.isStreaming]);

  // Send handler: add user message to shared chatState so the sidebar sees it
  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || state.isStreaming) return;
    chatState.addMessage({
      id: Math.random().toString(36).slice(2, 10),
      role: "user",
      content: trimmed,
      timestamp: new Date(),
    });
    setInput("");
  }, [input, state.isStreaming, chatState]);

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
          <div className="ob-detached-chat-view">
            <div className="ob-detached-chat-thread" ref={threadRef}>
              <MessageThread
                messages={state.messages}
                isStreaming={state.isStreaming}
                activeSkill={null}
                selectedPerson={null}
                onboardingDone={true}
                showPersonPicker={false}
                app={app}
                component={component}
                showTooltips={settings.showTooltips}
              />
            </div>
            <div className="ob-detached-chat-input">
              <InputArea
                input={input}
                onInputChange={setInput}
                onSend={handleSend}
                isStreaming={state.isStreaming}
                isRecording={false}
                attachedFiles={[]}
                onRemoveFile={() => {}}
                onFileAttach={() => {}}
                skills={skills}
                vaultIndex={vaultIndex}
                onSkillActivate={(skill) => { chatState.setActiveSkillId(skill.id); }}
                onFinishingSkill={() => {}}
                showTooltips={settings.showTooltips}
                placeholder="Ask anything... (@ to reference a file)"
                onMicClick={() => {}}
                micState="idle"
                isSendDisabled={state.isStreaming || !input.trim()}
              />
            </div>
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
