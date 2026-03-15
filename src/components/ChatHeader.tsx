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
  // Use aria-label for both accessibility and Obsidian's tooltip system.
  // Only set when tooltips are enabled; always set aria-label for screen readers.
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
        {skills.length > 0 && (
          <div className="ca-skill-selector">
            <button
              className={`ca-tool-btn ${activeSkill ? "active" : ""}`}
              onClick={onSkillMenuToggle}
              aria-label={tip(activeSkill?.description || "Choose a skill — specialized workflows for meetings, reviews, etc.")}
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
        <button
          className={`ca-tool-btn ${effectiveWrite ? "active" : ""}`}
          onClick={onToggleWrite}
          aria-label={tip(effectiveWrite
            ? "File editing ON — Claude can create and modify notes"
            : "File editing OFF — Claude can only read"
          )}
        >
          write
        </button>
        <button
          className={`ca-tool-btn ${effectiveCli ? "active" : ""}`}
          onClick={onToggleCli}
          aria-label={tip(effectiveCli
            ? "Shell access ON — Claude can run commands and search your vault"
            : "Shell access OFF — Claude cannot run commands"
          )}
        >
          cli
        </button>
        <button
          className="ca-icon-btn ca-save-btn"
          onClick={onSave}
          aria-label={tip("Save chat now")}
          disabled={messageCount === 0}
        >
          {showSaveConfirm ? "\u2713" : "\uD83D\uDCBE"}
        </button>
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
