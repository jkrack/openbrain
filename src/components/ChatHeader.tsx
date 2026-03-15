import React from "react";
import { Skill } from "../skills";

export interface ChatHeaderProps {
  activeSkill: Skill | null;
  activeSkillId: string | null;
  skills: Skill[];
  showSkillMenu: boolean;
  effectiveWrite: boolean;
  effectiveCli: boolean;
  messageCount: number;
  noteContext: string | undefined;
  sessionId: string | undefined;
  useLocalStt: boolean;
  showSaveConfirm: boolean;
  showTooltips: boolean;
  onSkillMenuToggle: () => void;
  onSkillSelect: (skillId: string | null) => void;
  onToggleWrite: () => void;
  onToggleCli: () => void;
  onSave: () => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
}

export function ChatHeader({
  activeSkill,
  activeSkillId,
  skills,
  showSkillMenu,
  effectiveWrite,
  effectiveCli,
  messageCount,
  noteContext,
  sessionId,
  useLocalStt,
  showSaveConfirm,
  showTooltips,
  onSkillMenuToggle,
  onSkillSelect,
  onToggleWrite,
  onToggleCli,
  onSave,
  onNewChat,
  onOpenSettings,
}: ChatHeaderProps) {
  const tip = (text: string) => (showTooltips ? text : undefined);

  return (
    <div className="ca-header">
      <div className="ca-header-left">
        <span className="ca-title">OpenBrain</span>
        {noteContext && (
          <span className="ca-note-badge" title={tip("Active note loaded")}>
            note
          </span>
        )}
        {sessionId && (
          <span className="ca-note-badge" title={tip("Session active")}>
            session
          </span>
        )}
        {useLocalStt && (
          <span className="ca-note-badge" title={tip("Local transcription active")}>
            local
          </span>
        )}
      </div>
      <div className="ca-header-right">
        {skills.length > 0 && (
          <div className="ca-skill-selector">
            <button
              className={`ca-tool-btn ${activeSkill ? "active" : ""}`}
              onClick={onSkillMenuToggle}
              title={tip(activeSkill?.description || "Select skill")}
            >
              {activeSkill?.name || "General"}
            </button>
            {showSkillMenu && (
              <div className="ca-skill-menu">
                <button
                  className={`ca-skill-option ${!activeSkill ? "active" : ""}`}
                  onClick={() => onSkillSelect(null)}
                >
                  General
                </button>
                {skills.map((skill) => (
                  <button
                    key={skill.id}
                    className={`ca-skill-option ${activeSkillId === skill.id ? "active" : ""}`}
                    onClick={() => onSkillSelect(skill.id)}
                    title={tip(skill.description)}
                  >
                    {skill.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button
          className={`ca-tool-btn ${effectiveWrite ? "active" : ""}`}
          onClick={onToggleWrite}
          title={tip("Allow file read/write")}
        >
          write
        </button>
        <button
          className={`ca-tool-btn ${effectiveCli ? "active" : ""}`}
          onClick={onToggleCli}
          title={tip("Allow shell commands")}
        >
          cli
        </button>
        <button
          className="ca-icon-btn ca-save-btn"
          onClick={onSave}
          title={tip("Save chat")}
          disabled={messageCount === 0}
        >
          {showSaveConfirm ? "\u2713" : "\uD83D\uDCBE"}
        </button>
        <button className="ca-icon-btn" onClick={onNewChat} title={tip("New chat")}>
          +
        </button>
        <button
          className="ca-icon-btn"
          onClick={onOpenSettings}
          title={tip("OpenBrain settings")}
        >
          \u2699
        </button>
      </div>
    </div>
  );
}
