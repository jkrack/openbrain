import React, { useState, useRef, useEffect, useCallback } from "react";
import { Message } from "../claude";
import { Skill } from "../skills";
import { PersonProfile } from "../people";
import { App, Component, MarkdownRenderer } from "obsidian";

function MarkdownBlock({ markdown, app, component }: { markdown: string; app: App; component: Component }) {
  const elRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    el.empty();
    MarkdownRenderer.render(app, markdown, el, "", component);
  }, [markdown]);

  return <div ref={elRef} className="ca-markdown" />;
}

function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older Electron versions
      const textarea = document.createElement("textarea");
      textarea.value = content;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [content]);

  return (
    <button
      className={`ca-copy-btn ${copied ? "copied" : ""}`}
      onClick={handleCopy}
      title={copied ? "Copied!" : "Copy as markdown"}
    >
      {copied ? "\u2713" : "\u29C9"}
    </button>
  );
}

export interface MessageThreadProps {
  messages: Message[];
  isStreaming: boolean;
  activeSkill: Skill | null;
  selectedPerson: PersonProfile | null;
  onboardingDone: boolean;
  showPersonPicker: boolean;
  app: App;
  component: Component;
  showTooltips: boolean;
}

export function MessageThread({
  messages,
  isStreaming,
  activeSkill,
  selectedPerson,
  onboardingDone,
  showPersonPicker,
  app,
  component,
  showTooltips,
}: MessageThreadProps) {
  return (
    <>
      {/* Normal empty state (post-onboarding) */}
      {onboardingDone && messages.length === 0 && !showPersonPicker && (
        <div className="ca-empty">
          <div className="ca-empty-icon">{"\u25C8"}</div>
          {selectedPerson ? (
            <>
              <div className="ca-empty-text">1:1 with {selectedPerson.name}</div>
              <div className="ca-empty-sub">{selectedPerson.role} {"\u2014"} {selectedPerson.domain}</div>
            </>
          ) : activeSkill ? (
            <>
              <div className="ca-empty-text">{activeSkill.description || activeSkill.name}</div>
              <div className="ca-empty-sub">Type a message or record audio to begin</div>
            </>
          ) : (
            <>
              <div className="ca-empty-text">Ask anything about your vault</div>
              <div className="ca-empty-hints">
                <span className="ca-hint">Type a message to chat</span>
                <span className="ca-hint"><b>@</b> to reference a file</span>
                <span className="ca-hint"><b>/</b> to activate a skill</span>
                <span className="ca-hint">Mic button to record voice</span>
              </div>
            </>
          )}
        </div>
      )}
      {messages.map((msg) => (
        <div key={msg.id} className={`ca-msg ca-msg--${msg.role}`}>
          <div className="ca-msg-content">
            {msg.isAudio && <span className="ca-audio-tag">{"\uD83C\uDF99"} </span>}
            {msg.role === "assistant" ? (
              <>
                <MarkdownBlock
                  markdown={msg.content}
                  app={app}
                  component={component}
                />
                {msg.content === "" && isStreaming && (
                  <span className="ca-dots">
                    <span className="ca-dot" />
                    <span className="ca-dot" />
                    <span className="ca-dot" />
                  </span>
                )}
                {msg.content && (
                  <CopyButton content={msg.content} />
                )}
              </>
            ) : (
              <span className="ca-msg-text">{msg.content}</span>
            )}
          </div>
        </div>
      ))}
    </>
  );
}
