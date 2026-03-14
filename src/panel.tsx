import React, { useState, useRef, useEffect, useCallback } from "react";
import { Message, streamClaudeCode, streamClaudeAPI, transcribeAudioSegments } from "./claude";
import { useAudioRecorder, formatDuration } from "./useAudioRecorder";
import { OpenBrainSettings } from "./settings";
import { Skill, executePostActions } from "./skills";
import { transcribeBlob, transcribeSegments } from "./stt";
import { RecordingStatus } from "./view";
import { App, Component, MarkdownRenderer } from "obsidian";
import { ChildProcess } from "child_process";

interface PanelProps {
  settings: OpenBrainSettings;
  app: App;
  initialPrompt?: string;
  component: Component;
  skills: Skill[];
  registerToggleRecording?: (fn: () => void) => void;
  onStatusChange?: (status: RecordingStatus) => void;
}

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

function MarkdownBlock({
  markdown,
  app,
  component,
}: {
  markdown: string;
  app: App;
  component: Component;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const timeout = setTimeout(() => {
      el.empty();
      MarkdownRenderer.render(app, markdown, el, "", component);
    }, 50);

    return () => clearTimeout(timeout);
  }, [markdown, app, component]);

  return <div ref={containerRef} className="ca-markdown" />;
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
      {copied ? "✓" : "⧉"}
    </button>
  );
}

export function OpenBrainPanel({ settings, app, initialPrompt, component, skills, registerToggleRecording, onStatusChange }: PanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState(initialPrompt || "");
  const [isStreaming, setIsStreaming] = useState(false);
  const [noteContext, setNoteContext] = useState<string | undefined>();
  const [noteFilePath, setNoteFilePath] = useState<string | undefined>();
  const [allowWrite, setAllowWrite] = useState(settings.allowVaultWrite);
  const [allowCli, setAllowCli] = useState(settings.allowCliExec);
  const [audioPrompt, setAudioPrompt] = useState("");
  const [showAudioPrompt, setShowAudioPrompt] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null);
  const [showSkillMenu, setShowSkillMenu] = useState(false);

  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<boolean>(false);
  const procRef = useRef<ChildProcess | null>(null);
  const responseRef = useRef<string>("");

  const recorder = useAudioRecorder();

  const activeSkill = skills.find((s) => s.id === activeSkillId) || null;

  const effectiveWrite = activeSkill?.tools.write ?? allowWrite;
  const effectiveCli = activeSkill?.tools.cli ?? allowCli;
  const effectiveSystemPrompt = activeSkill?.systemPrompt || settings.systemPrompt;

  // Apply tool overrides when skill changes
  useEffect(() => {
    if (activeSkill) {
      if (activeSkill.tools.write !== undefined) setAllowWrite(activeSkill.tools.write);
      if (activeSkill.tools.cli !== undefined) setAllowCli(activeSkill.tools.cli);
    }
  }, [activeSkillId]);

  // Pre-fill auto_prompt when skill changes
  useEffect(() => {
    if (activeSkill?.autoPrompt) {
      setInput(activeSkill.autoPrompt);
    }
  }, [activeSkillId]);

  // Load active note context
  useEffect(() => {
    const loadNote = async () => {
      if (!settings.includeActiveNote) return;
      const file = app.workspace.getActiveFile();
      if (!file) return;
      const content = await app.vault.read(file);
      setNoteContext(content);
      setNoteFilePath(file.path);
    };
    loadNote();

    const ref = app.workspace.on("active-leaf-change", loadNote);
    return () => app.workspace.offref(ref);
  }, [app, settings.includeActiveNote]);

  // Set initial prompt from outside
  useEffect(() => {
    if (initialPrompt) setInput(initialPrompt);
  }, [initialPrompt]);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [messages]);

  // Register toggle recording function for hotkey command
  useEffect(() => {
    if (registerToggleRecording) {
      registerToggleRecording(() => {
        handleMicClickRef.current?.();
      });
    }
  }, [registerToggleRecording]);

  // Report recording status changes to parent (for status bar)
  useEffect(() => {
    onStatusChange?.({
      recording: recorder.state === "recording",
      transcribing: isStreaming && recorder.state !== "recording",
      duration: recorder.duration,
    });
  }, [recorder.state, recorder.duration, isStreaming, onStatusChange]);

  const appendAssistantChunk = useCallback((id: string, chunk: string) => {
    responseRef.current += chunk;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id ? { ...m, content: m.content + chunk } : m
      )
    );
  }, []);

  const runPostActions = useCallback(async () => {
    if (!activeSkill || activeSkill.postActions.length === 0) return;

    const response = responseRef.current;
    if (!response.trim()) return;

    const results = await executePostActions(app, activeSkill.postActions, response);

    const feedback = results
      .map((r) => (r.success ? `${r.message}` : `Failed: ${r.message}`))
      .join("\n");

    if (feedback) {
      const feedbackMsg: Message = {
        id: generateId(),
        role: "assistant",
        content: `---\n${feedback}`,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, feedbackMsg]);
    }
  }, [activeSkill, app]);

  const sendMessage = useCallback(
    async (userText: string, audioSegments?: Blob[]) => {
      if (isStreaming) return;
      if (!userText.trim() && !audioSegments?.length) return;

      const hasAudioInput = audioSegments && audioSegments.length > 0;

      const userMsg: Message = {
        id: generateId(),
        role: "user",
        content: hasAudioInput ? `🎙 ${userText || "Voice message"}` : userText,
        isAudio: !!hasAudioInput,
        timestamp: new Date(),
      };

      const assistantId = generateId();
      const assistantMsg: Message = {
        id: assistantId,
        role: "assistant",
        content: "",
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setInput("");
      setIsStreaming(true);
      abortRef.current = false;
      responseRef.current = "";

      const callbacks = {
        onChunk: (chunk: string) => {
          if (!abortRef.current) appendAssistantChunk(assistantId, chunk);
        },
        onError: (err: string) => {
          setIsStreaming(false);
          procRef.current = null;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: `Error: ${err}` }
                : m
            )
          );
        },
      };

      const audioDone = async () => {
        setIsStreaming(false);
        recorder.clearAudio();
        setAudioPrompt("");
        setShowAudioPrompt(false);
        await runPostActions();
      };

      if (hasAudioInput && settings.useLocalStt) {
        // --- Local STT path ---
        try {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: "Transcribing locally..." }
                : m
            )
          );

          const result = audioSegments.length > 1
            ? await transcribeSegments(audioSegments, settings, (current, total) => {
                if (!abortRef.current) {
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantId
                        ? { ...m, content: `Transcribing segment ${current}/${total}...` }
                        : m
                    )
                  );
                }
              })
            : await transcribeBlob(audioSegments[0], settings);

          if (abortRef.current) return;

          const transcription = result.text;
          const durationSec = (result.durationMs / 1000).toFixed(1);

          if (!transcription.trim()) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      content:
                        "No speech detected in the recording.\n\n" +
                        `*Debug: processed in ${durationSec}s. Check Obsidian console (Cmd+Opt+I) for diagnostics. ` +
                        `WAV saved to ~/.openbrain/debug/last_recording.wav — try playing it with* \`afplay ~/.openbrain/debug/last_recording.wav\``,
                    }
                  : m
              )
            );
            setIsStreaming(false);
            recorder.clearAudio();
            setAudioPrompt("");
            setShowAudioPrompt(false);
            return;
          }

          // Show transcription
          responseRef.current = "";
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: `**Transcription** (${durationSec}s):\n\n${transcription}` }
                : m
            )
          );
          responseRef.current = transcription;

          // Determine audio mode: active skill overrides audioPrompt string check
          const shouldAnalyze = activeSkill
            ? activeSkill.audioMode === "transcribe_and_analyze"
            : audioPrompt && !audioPrompt.toLowerCase().includes("transcribe only");

          if (shouldAnalyze) {
            // Send transcription to Claude Code for analysis
            const analysisId = generateId();
            const analysisMsg: Message = {
              id: analysisId,
              role: "assistant",
              content: "",
              timestamp: new Date(),
            };
            setMessages((prev) => [...prev, analysisMsg]);
            responseRef.current = "";

            // Use skill's autoPrompt if active, otherwise user's audioPrompt
            const prompt = activeSkill?.autoPrompt || audioPrompt || "Process this transcription";
            const analysisPrompt = `${prompt}\n\nTranscription:\n${transcription}`;
            const proc = streamClaudeCode(settings, {
              prompt: analysisPrompt,
              noteContext,
              noteFilePath,
              systemPrompt: effectiveSystemPrompt,
              sessionId,
              allowWrite: effectiveWrite,
              allowCli: effectiveCli,
              onChunk: (chunk: string) => {
                if (!abortRef.current) appendAssistantChunk(analysisId, chunk);
              },
              onError: callbacks.onError,
              onDone: async (newSessionId?: string) => {
                setIsStreaming(false);
                procRef.current = null;
                if (newSessionId) setSessionId(newSessionId);
                recorder.clearAudio();
                setAudioPrompt("");
                setShowAudioPrompt(false);
                await runPostActions();
              },
            });
            procRef.current = proc;
          } else {
            // Transcription only — run postActions with raw transcription
            await runPostActions();
            setIsStreaming(false);
            recorder.clearAudio();
            setAudioPrompt("");
            setShowAudioPrompt(false);
          }
        } catch (err: any) {
          callbacks.onError(
            `Local transcription failed: ${err.message}\n` +
              "Check that sherpa-onnx is installed via Settings > OpenBrain."
          );
          recorder.clearAudio();
          setAudioPrompt("");
          setShowAudioPrompt(false);
        }
      } else if (hasAudioInput && audioSegments.length > 1) {
        // --- Existing multi-segment API path ---
        await transcribeAudioSegments(settings, {
          ...callbacks,
          segments: audioSegments,
          systemPrompt: effectiveSystemPrompt,
          noteContext,
          audioPrompt: audioPrompt || undefined,
          onProgress: (current, total) => {
            if (!abortRef.current) {
              appendAssistantChunk(assistantId, current === 1 ? `Transcribing segment ${current}/${total}...\n` : "");
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, content: `Transcribing segment ${current}/${total}...` }
                    : m
                )
              );
            }
          },
          onDone: audioDone,
        });
      } else if (hasAudioInput) {
        // --- Existing single-segment API path ---
        await streamClaudeAPI(settings, {
          ...callbacks,
          messages: [...messages, userMsg],
          systemPrompt: effectiveSystemPrompt,
          noteContext,
          audioBlob: audioSegments[0],
          audioPrompt: audioPrompt || "Transcribe this audio. If there are action items or key points, note them after the transcription.",
          onDone: audioDone,
        });
      } else {
        const proc = streamClaudeCode(settings, {
          ...callbacks,
          prompt: userText,
          noteContext,
          noteFilePath,
          systemPrompt: effectiveSystemPrompt,
          sessionId,
          allowWrite: effectiveWrite,
          allowCli: effectiveCli,
          onDone: async (newSessionId?: string) => {
            setIsStreaming(false);
            procRef.current = null;
            if (newSessionId) setSessionId(newSessionId);
            recorder.clearAudio();
            setAudioPrompt("");
            setShowAudioPrompt(false);
            await runPostActions();
          },
        });
        procRef.current = proc;
      }
    },
    [isStreaming, messages, settings, noteContext, noteFilePath, audioPrompt, appendAssistantChunk, recorder, sessionId, effectiveWrite, effectiveCli, effectiveSystemPrompt, runPostActions]
  );

  const handleSend = useCallback(() => {
    sendMessage(input);
  }, [input, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleMicClick = useCallback(async () => {
    if (recorder.state === "recording") {
      const segs = await recorder.stopRecording();
      if (segs.length > 0 && settings.transcribeOnStop) {
        sendMessage(audioPrompt || "Voice message", segs);
      }
    } else {
      const deviceId = settings.audioDeviceId || undefined;
      await recorder.startRecording(deviceId);
    }
  }, [recorder, settings.transcribeOnStop, settings.audioDeviceId, audioPrompt, sendMessage]);

  // Keep a ref to handleMicClick so the toggle registration can use it
  const handleMicClickRef = useRef<(() => void) | null>(null);
  handleMicClickRef.current = handleMicClick;

  const handleSendAudio = async () => {
    if (recorder.audioSegments.length > 0) {
      sendMessage(audioPrompt || "Voice message", recorder.audioSegments);
    }
  };

  const clearConversation = () => {
    setMessages([]);
    setSessionId(undefined);
    abortRef.current = true;
    if (procRef.current) {
      procRef.current.kill();
      procRef.current = null;
    }
    setIsStreaming(false);
  };

  const selectSkill = (skillId: string | null) => {
    setActiveSkillId(skillId);
    setShowSkillMenu(false);
    setSessionId(undefined);
    setMessages([]);
  };

  const isRecording = recorder.state === "recording";
  const hasAudio = recorder.audioSegments.length > 0 && recorder.state === "idle";

  return (
    <div className="claude-agent-panel">
      {/* Header */}
      <div className="ca-header">
        <div className="ca-header-left">
          <span className="ca-title">OpenBrain</span>
          {noteContext && (
            <span className="ca-note-badge" title="Active note loaded">
              note
            </span>
          )}
          {sessionId && (
            <span className="ca-note-badge" title="Session active">
              session
            </span>
          )}
          {settings.useLocalStt && (
            <span className="ca-note-badge" title="Local transcription active">
              local
            </span>
          )}
        </div>
        <div className="ca-header-right">
          {skills.length > 0 && (
            <div className="ca-skill-selector">
              <button
                className={`ca-tool-btn ${activeSkill ? "active" : ""}`}
                onClick={() => setShowSkillMenu((v) => !v)}
                title={activeSkill?.description || "Select skill"}
              >
                {activeSkill?.name || "General"}
              </button>
              {showSkillMenu && (
                <div className="ca-skill-menu">
                  <button
                    className={`ca-skill-option ${!activeSkill ? "active" : ""}`}
                    onClick={() => selectSkill(null)}
                  >
                    General
                  </button>
                  {skills.map((skill) => (
                    <button
                      key={skill.id}
                      className={`ca-skill-option ${activeSkillId === skill.id ? "active" : ""}`}
                      onClick={() => selectSkill(skill.id)}
                      title={skill.description}
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
            onClick={() => setAllowWrite((v) => !v)}
            title="Allow file read/write"
          >
            write
          </button>
          <button
            className={`ca-tool-btn ${effectiveCli ? "active" : ""}`}
            onClick={() => setAllowCli((v) => !v)}
            title="Allow shell commands"
          >
            cli
          </button>
          <button className="ca-icon-btn" onClick={clearConversation} title="Clear conversation">
            ↺
          </button>
          <button
            className="ca-icon-btn"
            onClick={() => {
              // Open Obsidian settings and navigate to OpenBrain tab
              const setting = (app as any).setting;
              if (setting) {
                setting.open();
                setting.openTabById("open-brain");
              }
            }}
            title="OpenBrain settings"
          >
            ⚙
          </button>
        </div>
      </div>

      {/* Message thread */}
      <div className="ca-thread" ref={threadRef}>
        {messages.length === 0 && (
          <div className="ca-empty">
            <div className="ca-empty-icon">◈</div>
            <div className="ca-empty-text">
              {activeSkill ? activeSkill.description || activeSkill.name : "Ask anything about your vault"}
            </div>
            <div className="ca-empty-sub">Powered by Claude Code</div>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`ca-msg ca-msg--${msg.role}`}>
            <div className="ca-msg-content">
              {msg.isAudio && <span className="ca-audio-tag">🎙 </span>}
              {msg.role === "assistant" ? (
                <>
                  <MarkdownBlock
                    markdown={msg.content}
                    app={app}
                    component={component}
                  />
                  {msg.content === "" && isStreaming && (
                    <span className="ca-cursor" />
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
      </div>

      {/* Waveform / recording state */}
      {isRecording && (
        <div className="ca-waveform">
          <span className="ca-rec-dot" />
          <div className="ca-bars">
            {recorder.waveformData.map((v, i) => (
              <div
                key={i}
                className="ca-bar"
                style={{ height: `${Math.max(3, v * 32)}px` }}
              />
            ))}
          </div>
          <span className="ca-rec-time">
            {formatDuration(recorder.duration)}
            {recorder.segmentCount > 0 && ` (${recorder.segmentCount + 1} segments)`}
          </span>
        </div>
      )}

      {/* Audio ready state */}
      {hasAudio && !isRecording && (
        <div className="ca-audio-ready">
          <span className="ca-audio-ready-label">
            Recording ready — {formatDuration(recorder.duration)}
            {recorder.audioSegments.length > 1 && ` (${recorder.audioSegments.length} segments)`}
          </span>
          <div className="ca-audio-actions">
            {showAudioPrompt && (
              <input
                className="ca-audio-prompt-input"
                placeholder="Instructions (optional)"
                value={audioPrompt}
                onChange={(e) => setAudioPrompt(e.target.value)}
                autoFocus
              />
            )}
            <button
              className="ca-icon-btn"
              onClick={() => setShowAudioPrompt((v) => !v)}
              title="Add instructions"
            >
              ✎
            </button>
            <button className="ca-icon-btn" onClick={recorder.clearAudio} title="Discard">
              ✕
            </button>
            <button className="ca-send-btn" onClick={handleSendAudio} disabled={isStreaming}>
              Send
            </button>
          </div>
        </div>
      )}

      {/* Mic error banner */}
      {recorder.error && (
        <div className="ca-mic-error">
          <span className="ca-mic-error-text">{recorder.error}</span>
          <button
            className="ca-icon-btn"
            onClick={() => recorder.clearError()}
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Input row */}
      <div className="ca-input-row">
        <textarea
          ref={inputRef}
          className="ca-input"
          placeholder={isRecording ? "Recording..." : activeSkill?.autoPrompt ? "Press enter to run..." : "Ask anything..."}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isRecording || isStreaming}
          rows={1}
        />
        <button
          className={`ca-mic-btn ${isRecording ? "recording" : ""} ${recorder.state === "processing" ? "processing" : ""}`}
          onClick={handleMicClick}
          disabled={isStreaming || recorder.state === "processing"}
          title={isRecording ? "Stop recording" : "Start recording"}
        >
          {recorder.state === "processing" ? "…" : isRecording ? "■" : "⏺"}
        </button>
        <button
          className="ca-send-btn"
          onClick={handleSend}
          disabled={isStreaming || isRecording || !input.trim()}
        >
          ↑
        </button>
      </div>
    </div>
  );
}
