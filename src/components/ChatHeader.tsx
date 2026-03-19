import React from "react";
import { Skill } from "../skills";
import { ObsidianIcon } from "./ObsidianIcon";

export interface ChatHeaderProps {
  activeSkill: Skill | null;
  activeSkillId: string | null;
  skills: Skill[];
  showSkillMenu: boolean;
  effectiveWrite: boolean;
  effectiveCli: boolean;
  noteContext: string | undefined;
  sessionId: string | undefined;
  useLocalStt: boolean;
  showTooltips: boolean;
  chatMode: "agent" | "chat";
  onboardingComplete: boolean;
  taskTrayOpen: boolean;
  onChatModeToggle: () => void;
  onSkillMenuToggle: () => void;
  onSkillSelect: (skillId: string | null) => void;
  onToggleWrite: () => void;
  onToggleCli: () => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  onToggleTaskTray: () => void;
}

export function ChatHeader({
  activeSkill,
  activeSkillId,
  skills,
  showSkillMenu,
  effectiveWrite,
  effectiveCli,
  noteContext,
  sessionId,
  useLocalStt,
  showTooltips,
  chatMode,
  onboardingComplete,
  taskTrayOpen,
  onChatModeToggle,
  onSkillMenuToggle,
  onSkillSelect,
  onToggleWrite,
  onToggleCli,
  onNewChat,
  onOpenSettings,
  onToggleTaskTray,
}: ChatHeaderProps) {
  const tip = (text: string) => (showTooltips ? text : undefined);

  return (
    <div className="ca-header">
      <div className="ca-header-left">
        <span className="ca-title">OpenBrain</span>
        {noteContext && (
          <span className="ca-note-badge" aria-label={tip("Your active note is included as context")}>
            note
          </span>
        )}
        {sessionId && (
          <span className="ca-note-badge" aria-label={tip("Multi-turn session — Claude remembers this conversation")}>
            session
          </span>
        )}
        {useLocalStt && (
          <span className="ca-note-badge" aria-label={tip("Voice transcription runs locally on your device")}>
            local
          </span>
        )}
      </div>
      <div className="ca-header-right">
        {/* Segmented mode toggle: Vault | Chat */}
        {onboardingComplete && (
          <div className="ca-mode-toggle-group">
            <button
              className={`ca-mode-seg ${chatMode === "agent" ? "active" : ""}`}
              onClick={chatMode === "agent" ? undefined : onChatModeToggle}
              aria-label={tip("Vault mode — Claude can read/write vault, run skills, and search")}
            >
              Vault
            </button>
            <button
              className={`ca-mode-seg ${chatMode === "chat" ? "active" : ""}`}
              onClick={chatMode === "chat" ? undefined : onChatModeToggle}
              aria-label={tip("Chat mode — direct conversation, supports images, no vault access")}
            >
              Chat
            </button>
          </div>
        )}

        {/* Skill selector — minimal pill */}
        {onboardingComplete && skills.length > 0 && chatMode === "agent" && (
          <div className="ca-skill-selector">
            <button
              className={`ca-skill-pill ${activeSkill ? "has-skill" : ""}`}
              onClick={onSkillMenuToggle}
              aria-label={tip(activeSkill?.description || "Choose a skill — specialized workflows for meetings, reviews, etc.")}
            >
              {activeSkill?.name || "General"}
              <span className="ca-skill-pill-chevron">{"\u25BE"}</span>
            </button>
            {showSkillMenu && (
              <div className="ca-skill-menu" role="listbox">
                <button
                  className={`ca-skill-option ${!activeSkill ? "active" : ""}`}
                  onClick={() => onSkillSelect(null)}
                  role="option"
                >
                  General
                </button>
                {skills.map((skill) => (
                  <button
                    key={skill.id}
                    className={`ca-skill-option ${activeSkillId === skill.id ? "active" : ""}`}
                    onClick={() => onSkillSelect(skill.id)}
                    aria-label={tip(skill.description)}
                    role="option"
                  >
                    {skill.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Permission dots: write (green) and cli (accent) */}
        {onboardingComplete && chatMode === "agent" && (
          <div className="ca-perm-dots">
            <button
              className={`ca-perm-dot ${effectiveWrite ? "write-on" : "write-off"}`}
              onClick={onToggleWrite}
              aria-label={tip(effectiveWrite
                ? "File editing ON — Claude can create and modify notes"
                : "File editing OFF — Claude can only read"
              )}
            />
            <button
              className={`ca-perm-dot ${effectiveCli ? "cli-on" : "cli-off"}`}
              onClick={onToggleCli}
              aria-label={tip(effectiveCli
                ? "Shell access ON — Claude can run commands and search your vault"
                : "Shell access OFF — Claude cannot run commands"
              )}
            />
          </div>
        )}

        {onboardingComplete && (
          <button
            className={`ca-icon-btn ${taskTrayOpen ? "active" : ""}`}
            onClick={onToggleTaskTray}
            aria-label={tip("Toggle task tray")}
          >
            <ObsidianIcon name="check-square" />
          </button>
        )}
        <button
          className="ca-icon-btn"
          onClick={onNewChat}
          aria-label={tip("Start a new conversation (saves current chat first)")}
        >
          +
        </button>
        <button
          className="ca-icon-btn"
          onClick={onOpenSettings}
          aria-label={tip("OpenBrain settings")}
        >
          {"\u2699"}
        </button>
      </div>
    </div>
  );
}
