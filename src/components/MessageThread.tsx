import React, { useState, useRef, useEffect, useCallback } from "react";
import { Message } from "../providers/types";
import { Skill } from "../skills";
import { PersonProfile } from "../people";
import { App, Component, MarkdownRenderer } from "obsidian";
import { ObsidianIcon } from "./ObsidianIcon";
import { getLastResponseTiming } from "../perf";
import { getWelcomeForToday } from "../welcomeMessages";

const MESSAGES_PER_PAGE = 50;

/** Parse tool-use lines from assistant content to render as pills. */
function parseToolUse(content: string): { text: string; tools: { name: string; detail: string }[] } {
  const toolPattern = /\n?\*Using ([^.…*]+?)(?:\.\.\.)?\*\n?/g;
  const tools: { name: string; detail: string }[] = [];
  const text = content.replace(toolPattern, (_match, name) => {
    tools.push({ name: name.trim(), detail: "" });
    return "\n";
  });
  return { text: text.trim(), tools };
}

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

function ToolPill({ name }: { name: string }) {
  return (
    <span className="ca-tool-pill">
      <span className="ca-tool-pill-icon">{"\u26A1"}</span>
      {name}
    </span>
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
            (() => {
              const welcome = getWelcomeForToday();
              return (
                <>
                  <div className="ca-empty-text">{welcome.headline}</div>
                  <div className="ca-empty-sub">{welcome.sub}</div>
                  <div className="ca-empty-hints">
                    {welcome.tips.map((tip, i) => (
                      <span className="ca-hint" key={i}>{tip}</span>
                    ))}
                  </div>
                </>
              );
            })()
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

        if (msg.role === "assistant") {
          // Parse tool-use lines into pills
          const { text: cleanText, tools } = parseToolUse(msg.content);
          const showThinking = isLastAssistant && isStreaming;

          return (
            <div key={msg.id} className="ca-msg ca-msg--assistant">
              {/* Tool pills rendered compactly above the content */}
              {tools.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginBottom: "6px" }}>
                  {tools.map((tool, ti) => (
                    <ToolPill key={ti} name={tool.name} />
                  ))}
                </div>
              )}
              <div className="ca-msg-content">
                {msg.isAudio && <span className="ca-audio-tag">{"\uD83C\uDF99"} </span>}
                {cleanText && (
                  <MarkdownBlock
                    markdown={cleanText}
                    app={app}
                    component={component}
                  />
                )}
                {showThinking && (
                  <div className="ca-thinking-line" />
                )}
                {cleanText && !isStreaming && (
                  <CopyButton content={msg.content} />
                )}
                {isLastAssistant && !isStreaming && cleanText && (
                  <TimingBadge />
                )}
              </div>
            </div>
          );
        }

        // User messages — right-aligned with accent border
        return (
          <div key={msg.id} className="ca-msg ca-msg--user">
            <div className="ca-msg-content">
              {msg.isAudio && <span className="ca-audio-tag">{"\uD83C\uDF99"} </span>}
              <span className="ca-msg-text">{msg.content}</span>
            </div>
          </div>
        );
      })}
    </>
  );
}
