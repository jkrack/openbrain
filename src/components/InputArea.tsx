import React, { useState, useRef, useCallback } from "react";
import { Skill } from "../skills";
import { VaultIndex } from "../vaultIndex";
import { ObsidianIcon } from "./ObsidianIcon";

export interface InputAreaProps {
  input: string;
  onInputChange: (val: string) => void;
  onSend: () => void;
  isStreaming: boolean;
  isRecording: boolean;
  attachedFiles: string[];
  onRemoveFile: (path: string) => void;
  onFileAttach: (path: string) => void;
  skills: Skill[];
  vaultIndex: VaultIndex | null;
  onSkillActivate: (skill: Skill) => void;
  showTooltips: boolean;
  placeholder?: string;
  onMicClick: () => void;
  micState: "idle" | "recording" | "processing";
  isSendDisabled: boolean;
}

export function InputArea({
  input,
  onInputChange,
  onSend,
  isStreaming,
  isRecording,
  attachedFiles,
  onRemoveFile,
  onFileAttach,
  skills,
  vaultIndex,
  onSkillActivate,
  showTooltips,
  placeholder,
  onMicClick,
  micState,
  isSendDisabled,
}: InputAreaProps) {
  // @ mention state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionResults, setMentionResults] = useState<{ path: string; basename: string }[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);

  // / slash command state
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashResults, setSlashResults] = useState<Skill[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);

  const inputRef = useRef<HTMLTextAreaElement>(null);

  const tip = (text: string) => (showTooltips ? text : undefined);

  // Detect @ mentions and / commands from input
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      onInputChange(val);

      const pos = e.target.selectionStart;
      const textBefore = val.slice(0, pos);

      // Check for @ mention
      const atMatch = textBefore.match(/@([^\s@]*)$/);
      if (atMatch) {
        const query = atMatch[1];
        setMentionQuery(query);
        setMentionIndex(0);
        setSlashQuery(null);

        if (vaultIndex) {
          const results = vaultIndex.search(query);
          setMentionResults(results);
        }
        return;
      }
      setMentionQuery(null);

      // Check for / command (at start or after whitespace)
      const slashMatch = textBefore.match(/(?:^|\s)\/([^\s]*)$/);
      if (slashMatch && skills.length > 0) {
        const query = slashMatch[1].toLowerCase();
        setSlashQuery(query);
        setSlashIndex(0);

        const filtered = query
          ? skills.filter((s) => s.name.toLowerCase().includes(query))
          : skills;
        setSlashResults(filtered.slice(0, 8));
        return;
      }
      setSlashQuery(null);
    },
    [onInputChange, vaultIndex, skills]
  );

  // Insert selected file as attached reference (path only)
  const insertMention = useCallback(
    (entry: { path: string; basename: string }) => {
      onFileAttach(entry.path);

      // Replace @query with @basename in input
      const pos = inputRef.current?.selectionStart ?? input.length;
      const textBefore = input.slice(0, pos);
      const textAfter = input.slice(pos);
      const replaced = textBefore.replace(/@[^\s@]*$/, `@${entry.basename} `);
      onInputChange(replaced + textAfter);
      setMentionQuery(null);
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    [input, onInputChange, onFileAttach]
  );

  // Insert slash command — activate the selected skill
  const insertSlashCommand = useCallback(
    (skill: Skill) => {
      // Remove /query from input
      const pos = inputRef.current?.selectionStart ?? input.length;
      const textBefore = input.slice(0, pos);
      const textAfter = input.slice(pos);
      const replaced = textBefore.replace(/(?:^|\s)\/[^\s]*$/, "").trimEnd();
      onInputChange(replaced + (replaced ? " " : "") + textAfter);
      setSlashQuery(null);

      // Activate the skill
      onSkillActivate(skill);
    },
    [input, onInputChange, onSkillActivate]
  );

  // Remove an attached file
  const removeAttachedFile = useCallback(
    (path: string) => {
      onRemoveFile(path);
    },
    [onRemoveFile]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Dropdown navigation (@ mentions or / commands)
      const isDropdownOpen = mentionQuery !== null || slashQuery !== null;
      if (isDropdownOpen) {
        const results = mentionQuery !== null ? mentionResults : slashResults;
        const setIndex = mentionQuery !== null ? setMentionIndex : setSlashIndex;
        const currentIndex = mentionQuery !== null ? mentionIndex : slashIndex;

        if (e.key === "ArrowDown") {
          e.preventDefault();
          setIndex(Math.min(currentIndex + 1, results.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setIndex(Math.max(currentIndex - 1, 0));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          if (results.length > 0) {
            e.preventDefault();
            if (mentionQuery !== null) {
              insertMention(mentionResults[mentionIndex]);
            } else {
              insertSlashCommand(slashResults[slashIndex]);
            }
            return;
          }
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setMentionQuery(null);
          setSlashQuery(null);
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onSend();
      }
    },
    [
      mentionQuery,
      slashQuery,
      mentionResults,
      slashResults,
      mentionIndex,
      slashIndex,
      insertMention,
      insertSlashCommand,
      onSend,
    ]
  );

  // Mic icon based on state
  const micIconName = micState === "processing" ? "loader" : micState === "recording" ? "square" : "mic";
  const micLabel = micState === "recording" ? "Stop recording" : "Record voice message";

  return (
    <>
      {/* Attached files from @ mentions */}
      {attachedFiles.length > 0 && (
        <div className="ca-attached-files">
          {attachedFiles.map((p) => (
            <span key={p} className="ca-attached-file">
              {p.split("/").pop()?.replace(".md", "") ?? p}
              <button className="ca-attached-remove" onClick={() => removeAttachedFile(p)}>
                <ObsidianIcon name="x" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Unified input card */}
      <div className="ca-input-card">
        <div className="ca-input-wrapper">
          <textarea
            ref={inputRef}
            className="ca-input"
            placeholder={placeholder}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            disabled={isRecording || isStreaming}
            rows={1}
          />
          {/* @ mention dropdown */}
          {mentionQuery !== null && mentionResults.length > 0 && (
            <div className="ca-mention-menu">
              {mentionResults.map((entry, i) => (
                <button
                  key={entry.path}
                  className={`ca-mention-option ${i === mentionIndex ? "active" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertMention(entry);
                  }}
                >
                  {entry.basename}
                </button>
              ))}
            </div>
          )}
          {/* / slash command dropdown */}
          {slashQuery !== null && slashResults.length > 0 && (
            <div className="ca-mention-menu">
              {slashResults.map((skill, i) => (
                <button
                  key={skill.id}
                  className={`ca-mention-option ${i === slashIndex ? "active" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertSlashCommand(skill);
                  }}
                >
                  {skill.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Toolbar row */}
        <div className="ca-input-toolbar">
          <div className="ca-toolbar-left">
            <button
              className={`ca-mic-btn ${micState === "recording" ? "recording" : ""} ${micState === "processing" ? "processing" : ""}`}
              onClick={onMicClick}
              disabled={isStreaming || micState === "processing"}
              aria-label={tip(micLabel)}
            >
              <ObsidianIcon name={micIconName} />
            </button>
          </div>
          <div className="ca-toolbar-right">
            <button
              className="ca-send-btn"
              onClick={onSend}
              disabled={isSendDisabled}
              aria-label={tip("Send message")}
            >
              <ObsidianIcon name="arrow-up" />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
