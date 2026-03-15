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
          <span className="ca-note-badge" title={tip("Your active note is included as context")}>
            note
          </span>
        )}
        {sessionId && (
          <span className="ca-note-badge" title={tip("Multi-turn session — Claude remembers this conversation")}>
            session
          </span>
        )}
        {useLocalStt && (
          <span className="ca-note-badge" title={tip("Voice transcription runs locally on your device")}>
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
              title={tip(activeSkill?.description || "Choose a skill — specialized workflows for meetings, reviews, etc.")}
              aria-label={`Skill: ${activeSkill?.name || "General"}`}
            >
              {activeSkill?.name || "General"}
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
                    title={tip(skill.description)}
                    role="option"
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
          title={tip(effectiveWrite
            ? "File editing ON — Claude can create and modify notes"
            : "File editing OFF — Claude can only read"
          )}
          aria-label={`File editing ${effectiveWrite ? "enabled" : "disabled"}`}
        >
          write
        </button>
        <button
          className={`ca-tool-btn ${effectiveCli ? "active" : ""}`}
          onClick={onToggleCli}
          title={tip(effectiveCli
            ? "Shell access ON — Claude can run commands and search your vault"
            : "Shell access OFF — Claude cannot run commands"
          )}
          aria-label={`Shell access ${effectiveCli ? "enabled" : "disabled"}`}
        >
          cli
        </button>
        <button
          className="ca-icon-btn ca-save-btn"
          onClick={onSave}
          title={tip("Save chat now")}
          aria-label="Save chat"
          disabled={messageCount === 0}
        >
          {showSaveConfirm ? "\u2713" : "\uD83D\uDCBE"}
        </button>
        <button
          className="ca-icon-btn"
          onClick={onNewChat}
          title={tip("Start a new conversation (saves current chat first)")}
          aria-label="New chat"
        >
          +
        </button>
        <button
          className="ca-icon-btn"
          onClick={onOpenSettings}
          title={tip("OpenBrain settings")}
          aria-label="Settings"
        >
          {"\u2699"}
        </button>
      </div>
    </div>
  );
}
