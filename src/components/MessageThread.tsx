import React, { useState, useRef, useEffect, useCallback } from "react";
import { Message } from "../claude";
import { Skill } from "../skills";
import { PersonProfile } from "../people";
import { App, Component, MarkdownRenderer } from "obsidian";
import { ObsidianIcon } from "./ObsidianIcon";
import { getLastResponseTiming } from "../perf";

const MESSAGES_PER_PAGE = 50;

function MarkdownBlock({ markdown, app, component }: { markdown: string; app: App; component: Component }) {
  const elRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    el.empty();
    void MarkdownRenderer.render(app, markdown, el, "", component);
  }, [markdown]);

  return <div ref={elRef} className="ca-markdown" />;
}

function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [content]);

  return (
    <button
      className={`ca-copy-btn ${copied ? "copied" : ""}`}
      onClick={() => void handleCopy()}
      title={copied ? "Copied!" : "Copy as markdown"}
    >
      <ObsidianIcon name={copied ? "check" : "copy"} />
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

function TimingBadge() {
  const [expanded, setExpanded] = useState(false);
  const timing = getLastResponseTiming();
  if (!timing || timing.totalMs < 100) return null;

  const formatTime = (ms: number) => {
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
    return `${ms}ms`;
  };

  return (
    <div className="ca-timing">
      <button
        className="ca-timing-badge"
        onClick={() => setExpanded((v) => !v)}
      >
        {formatTime(timing.totalMs)}
      </button>
      {expanded && (
        <div className="ca-timing-detail">
          {Object.entries(timing.breakdown).map(([op, ms]) => (
            <div key={op} className="ca-timing-row">
              <span className="ca-timing-label">{op}</span>
              <span className="ca-timing-value">{formatTime(ms)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
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
  const [visibleCount, setVisibleCount] = useState(MESSAGES_PER_PAGE);

  // Reset visible count when messages are cleared (new chat)
  useEffect(() => {
    if (messages.length <= MESSAGES_PER_PAGE) {
      setVisibleCount(MESSAGES_PER_PAGE);
    }
  }, [messages.length]);

  const hiddenCount = Math.max(0, messages.length - visibleCount);
  const visibleMessages = hiddenCount > 0
    ? messages.slice(hiddenCount)
    : messages;

  const loadMore = () => {
    setVisibleCount((prev) => prev + MESSAGES_PER_PAGE);
  };

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

      {/* Load earlier messages button */}
      {hiddenCount > 0 && (
        <button className="ca-load-more" onClick={loadMore}>
          Load {Math.min(hiddenCount, MESSAGES_PER_PAGE)} earlier messages ({hiddenCount} hidden)
        </button>
      )}

      {visibleMessages.map((msg, idx) => {
        const globalIdx = hiddenCount + idx;
        const isLastAssistant = msg.role === "assistant" &&
          globalIdx === messages.length - 1;
        return (
          <div key={msg.id} className={`ca-msg ca-msg--${msg.role}`}>
            <div className="ca-msg-content">
              {msg.isAudio && <span className="ca-audio-tag">{"\uD83C\uDF99"} </span>}
              {msg.role === "assistant" ? (
                <>
                  {msg.content && (
                    <MarkdownBlock
                      markdown={msg.content}
                      app={app}
                      component={component}
                    />
                  )}
                  {isLastAssistant && isStreaming && (
                    <span className="ca-dots">
                      <span className="ca-dot" />
                      <span className="ca-dot" />
                      <span className="ca-dot" />
                    </span>
                  )}
                  {msg.content && !isStreaming && (
                    <CopyButton content={msg.content} />
                  )}
                  {isLastAssistant && !isStreaming && msg.content && (
                    <TimingBadge />
                  )}
                </>
              ) : (
                <span className="ca-msg-text">{msg.content}</span>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
