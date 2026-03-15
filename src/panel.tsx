import React, { useState, useRef, useEffect, useCallback } from "react";
import { Message, streamClaudeCode, streamClaudeAPI, streamClaudeAPIChat, summarizeChat, transcribeAudioSegments } from "./claude";
import { useAudioRecorder, formatDuration } from "./useAudioRecorder";
import { OpenBrainSettings } from "./settings";
import { Skill, executePostActions } from "./skills";
import { transcribeBlob, transcribeSegments } from "./stt";
import { RecordingStatus } from "./view";
import { App, Component, MarkdownRenderer, Notice } from "obsidian";
import { ChildProcess } from "child_process";
import {
  ChatMeta,
  saveChat,
  loadChat,
  generateChatTitle,
  generateChatFilename,
  listRecentChats,
  linkInDailyNote,
  appendToDailySection,
} from "./chatHistory";
import { VaultIndex } from "./vaultIndex";
import { buildSmartContext } from "./smartContext";
import { PersonProfile, loadPeople, getRecentOneOnOnes, getPersonMeetingFolder } from "./people";
import { createFromTemplate } from "./templates";
import { ChatHeader } from "./components/ChatHeader";
import { PersonPicker } from "./components/PersonPicker";
import { InputArea } from "./components/InputArea";

interface PanelProps {
  settings: OpenBrainSettings;
  app: App;
  initialPrompt?: string;
  component: Component;
  skills: Skill[];
  registerToggleRecording?: (fn: () => void) => void;
  onStatusChange?: (status: RecordingStatus) => void;
  loadChatRequest?: { path: string; nonce: number };
  onChatPathChange?: (path: string | null) => void;
  vaultIndex?: VaultIndex | null;
}

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

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
      title={copied ? "Copied!" : "Copy as markdown"}  // CopyButton has own props
    >
      {copied ? "✓" : "⧉"}
    </button>
  );
}

interface SetupStatus {
  claudeCli: boolean;
  obsidianCli: boolean;
  apiKey: boolean;
}

export function OpenBrainPanel({ settings, app, initialPrompt, component, skills, registerToggleRecording, onStatusChange, loadChatRequest, onChatPathChange, vaultIndex }: PanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState(initialPrompt || "");
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
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
  const [chatFilePath, setChatFilePathState] = useState<string | null>(null);
  const chatFilePathRef = useRef<string | null>(null);
  const setChatFilePath = (p: string | null) => {
    chatFilePathRef.current = p;
    setChatFilePathState(p);
  };
  // showSaveConfirm removed — chats auto-save

  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [chatMode, setChatMode] = useState<"agent" | "chat">("agent");
  const [pendingImages, setPendingImages] = useState<{ base64: string; mediaType: string; preview: string }[]>([]);

  // Onboarding state
  const [onboardingStep, setOnboardingStep] = useState<1 | 2 | 3>(1);

  // Person picker state (for skills with requiresPerson)
  const [showPersonPicker, setShowPersonPicker] = useState(false);
  const [people, setPeople] = useState<PersonProfile[]>([]);
  const [selectedPerson, setSelectedPerson] = useState<PersonProfile | null>(null);
  const [personNotePath, setPersonNotePath] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => { return () => { mountedRef.current = false; }; }, []);

  const debouncedSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const justLoadedRef = useRef(false);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const activeSkillIdRef = useRef(activeSkillId);
  activeSkillIdRef.current = activeSkillId;

  const vaultPath = (app.vault.adapter as any).basePath as string | undefined;

  const threadRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<boolean>(false);
  const procRef = useRef<ChildProcess | null>(null);
  const responseRef = useRef<string>("");

  const recorder = useAudioRecorder();

  // Tooltip helper — returns title prop only if tooltips enabled
  const tip = (text: string) => settings.showTooltips ? text : undefined;

  const activeSkill = skills.find((s) => s.id === activeSkillId) || null;

  const effectiveWrite = activeSkill?.tools.write ?? allowWrite;
  const effectiveCli = activeSkill?.tools.cli ?? allowCli;
  const baseSystemPrompt = activeSkill?.systemPrompt || settings.systemPrompt;
  const effectiveSystemPrompt = selectedPerson
    ? `${baseSystemPrompt}\n\n--- Person Context ---\n${selectedPerson.fullContent}`
    : baseSystemPrompt;

  // Check setup status on mount
  const [setupDismissed, setSetupDismissed] = useState(false);
  useEffect(() => {
    const check = () => {
      const { execSync } = require("child_process");
      const home = process.env.HOME || "";
      const extraPaths = [
        "/usr/local/bin",
        "/opt/homebrew/bin",
        `${home}/.local/bin`,
        "/Applications/Obsidian.app/Contents/MacOS",
      ];
      const env = {
        ...process.env,
        PATH: [...extraPaths, process.env.PATH].filter(Boolean).join(":"),
      };

      let claudeCli = false;
      try {
        const claudePath = settings.claudePath || "claude";
        execSync(`${claudePath} --version`, { timeout: 5000, encoding: "utf-8", env });
        claudeCli = true;
      } catch {}

      let obsidianCli = false;
      try {
        execSync("obsidian version", { timeout: 5000, encoding: "utf-8", env });
        obsidianCli = true;
      } catch {}

      setSetupStatus({ claudeCli, obsidianCli, apiKey: !!settings.apiKey });
    };
    check();
  }, [settings.claudePath, settings.apiKey]);

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

  // Handle image paste (Cmd+V)
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (!blob) continue;

          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            const base64 = dataUrl.split(",")[1];
            setPendingImages((prev) => [...prev, {
              base64,
              mediaType: item.type,
              preview: dataUrl,
            }]);

            // Switch to chat mode if not already (images need API)
            if (chatMode === "agent") setChatMode("chat");
          };
          reader.readAsDataURL(blob);
        }
      }
    };

    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [chatMode]);

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
      transcribing: recorder.state === "processing",
      duration: recorder.duration,
    });
  }, [recorder.state, recorder.duration, isStreaming, onStatusChange]);

  // --- Chat history helpers ---

  function buildMeta(): ChatMeta {
    const now = new Date().toISOString();
    const firstMsg = messages[0];
    const currentSkillId = activeSkillIdRef.current;
    return {
      type: "openbrain-chat",
      formatVersion: 1,
      created: firstMsg ? firstMsg.timestamp.toISOString() : now,
      updated: now,
      skill: currentSkillId
        ? skills.find((s) => s.id === currentSkillId)?.name ?? "General"
        : "General",
      sessionId: sessionIdRef.current ?? "",
      messageCount: messages.length,
      hasAudio: messages.some((m) => m.isAudio),
      title: generateChatTitle(messages),
      tags: ["openbrain/chat"],
    };
  }

  // Debounced auto-save
  useEffect(() => {
    if (messages.length === 0 || isStreaming) return;
    if (justLoadedRef.current) {
      justLoadedRef.current = false;
      return;
    }

    if (debouncedSaveRef.current) clearTimeout(debouncedSaveRef.current);

    debouncedSaveRef.current = setTimeout(async () => {
      const meta = buildMeta();
      const folder = settings.chatFolder || "OpenBrain/chats";
      const currentPath = chatFilePathRef.current;
      const path = currentPath ?? `${folder}/${generateChatFilename()}`;
      await saveChat(app, path, messages, meta);
      if (!mountedRef.current) return;
      if (!currentPath) {
        setChatFilePath(path);
        onChatPathChange?.(path);

        // Link new chat in today's daily note
        const currentSkillId = activeSkillIdRef.current;
        const skill = currentSkillId ? skills.find((s) => s.id === currentSkillId) : null;
        const section = skill?.dailyNoteSection || "Capture";
        linkInDailyNote(app, path, section, meta.title, settings).catch(() => {});
      }
    }, 500);

    return () => {
      if (debouncedSaveRef.current) clearTimeout(debouncedSaveRef.current);
    };
  }, [messages, isStreaming]);

  // Load chat on mount from loadChatRequest
  useEffect(() => {
    if (!loadChatRequest) return;

    (async () => {
      const chatFile = await loadChat(app, loadChatRequest.path);
      if (chatFile) {
        justLoadedRef.current = true;
        setMessages(chatFile.messages);
        setChatFilePath(chatFile.path);
        setSessionId(chatFile.frontmatter.sessionId || undefined);
        const matchSkill = skills.find(
          (s) => s.name === chatFile.frontmatter.skill
        );
        setActiveSkillId(matchSkill?.id ?? null);
        onChatPathChange?.(chatFile.path);
      } else {
        new Notice("Could not load chat file.");
      }
    })();
  }, [loadChatRequest?.nonce]);

  // Manual save handler
  // Extract action items from conversation and add to daily note
  const extractActionItems = async (msgs: Message[], s: OpenBrainSettings) => {
    if (msgs.length < 2) return;

    // Look for action items in assistant messages
    const actionPattern = /- \[ \] .+/g;
    const items: string[] = [];

    for (const msg of msgs) {
      if (msg.role !== "assistant") continue;
      const matches = msg.content.match(actionPattern);
      if (matches) items.push(...matches);
    }

    if (items.length === 0) return;

    // Deduplicate
    const unique = [...new Set(items)];
    const taskBlock = unique.join("\n");

    appendToDailySection(app, taskBlock, "Capture", s).catch(() => {});
  };

  // Recent chat context injection helper
  async function getRecentChatContext(): Promise<string> {
    if (!settings.includeRecentChats) return "";

    const folder = settings.chatFolder || "OpenBrain/chats";
    const recentMetas = listRecentChats(app, folder, 3);
    if (recentMetas.length === 0) return "";

    const summaries: string[] = [];
    const files = app.vault.getMarkdownFiles().filter(
      (f) => f.path.startsWith(folder + "/") && f.path.endsWith(".md")
    );

    for (const meta of recentMetas) {
      for (const file of files) {
        const cache = app.metadataCache.getFileCache(file);
        if (cache?.frontmatter?.session_id === meta.sessionId && meta.sessionId) {
          const chatFile = await loadChat(app, file.path);
          if (chatFile) {
            const lastMsgs = chatFile.messages.slice(-4);
            const preview = lastMsgs
              .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
              .join("\n");
            summaries.push(`**${meta.title}** (${meta.skill}, ${meta.updated}):\n${preview}`);
          }
          break;
        }
      }
    }

    if (summaries.length === 0) return "";
    return "\n\n--- Recent conversation context ---\n" + summaries.join("\n\n");
  }

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
              vaultPath,
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
      } else if (chatMode === "chat") {
        // --- Direct API chat mode (supports images) ---
        const images = pendingImages.length > 0
          ? pendingImages.map((img) => ({ base64: img.base64, mediaType: img.mediaType }))
          : undefined;
        if (pendingImages.length > 0) setPendingImages([]);

        // Smart context for chat mode too
        const smartCtx = buildSmartContext(app, userText, attachedFiles);
        const allContext = [noteContext, smartCtx].filter(Boolean).join("");

        await streamClaudeAPIChat(settings, {
          ...callbacks,
          messages: [...messages, userMsg],
          systemPrompt: effectiveSystemPrompt,
          noteContext: allContext || undefined,
          images,
          onDone: () => {
            setIsStreaming(false);
            recorder.clearAudio();
            setAudioPrompt("");
            setShowAudioPrompt(false);
          },
        });
      } else {
        // --- Agent mode (Claude Code CLI) ---
        let recentContext = "";
        if (!chatFilePath && messages.length === 0) {
          recentContext = await getRecentChatContext();
        }

        const allContext = [noteContext, recentContext].filter(Boolean).join("");
        const enrichedNoteContext = allContext || undefined;

        let fullPrompt = userText;

        // Attach @ referenced files
        if (attachedFiles.length > 0) {
          fullPrompt += "\n\nReferenced files (read these before responding):\n" +
            attachedFiles.map((p) => `- ${p}`).join("\n");
          setAttachedFiles([]);
        }

        // Smart context: auto-find relevant vault notes
        const smartCtx = buildSmartContext(app, userText, attachedFiles);
        if (smartCtx) fullPrompt += smartCtx;

        const proc = streamClaudeCode(settings, {
          ...callbacks,
          prompt: fullPrompt,
          noteContext: enrichedNoteContext,
          noteFilePath,
          systemPrompt: effectiveSystemPrompt,
          sessionId,
          allowWrite: effectiveWrite,
          allowCli: effectiveCli,
          vaultPath,
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

  // Handle skill activation from InputArea slash command
  const handleSkillActivate = async (skill: Skill) => {
    setActiveSkillId(skill.id);

    // If skill requires a person, show the person picker
    if (skill.requiresPerson) {
      const loaded = await loadPeople(app);
      setPeople(loaded);
      setShowPersonPicker(true);
    } else {
      setSelectedPerson(null);
      setPersonNotePath(null);
    }
  };

  // Handle person selection — create 1:1 note, load context, send opening message
  const selectPerson = async (person: PersonProfile) => {
    setSelectedPerson(person);
    setShowPersonPicker(false);

    // Create the 1:1 note from template
    const folder = getPersonMeetingFolder(person.name);
    const dateStr = new Date().toISOString().slice(0, 10);
    const notePath = `${folder}/${dateStr}.md`;
    const created = await createFromTemplate(app, "One on One.md", notePath, {
      title: person.name,
    });
    if (!mountedRef.current) return;
    if (created) {
      setPersonNotePath(created);
      // Link the 1:1 note in today's daily note under Meetings
      linkInDailyNote(app, created, "Meetings", `1:1 — ${person.name}`, settings).catch(() => {});
    }

    // Build file references: person profile + recent 1:1 notes
    const filesToReference = [person.filePath];
    const recentNotes = await getRecentOneOnOnes(app, person.name);
    if (!mountedRef.current) return;

    // Also reference the recent 1:1 note files directly
    const recentFolder = getPersonMeetingFolder(person.name);
    const recentFiles = app.vault.getMarkdownFiles()
      .filter((f) => f.path.startsWith(recentFolder + "/"))
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, 3);
    for (const f of recentFiles) {
      if (!filesToReference.includes(f.path)) filesToReference.push(f.path);
    }

    // Auto-send opening message with context
    const openingPrompt = `Starting 1:1 with ${person.name}.` +
      `\n\nReferenced files (read these before responding):\n` +
      filesToReference.map((p) => `- ${p}`).join("\n") +
      `\n\nPlease review ${person.name}'s profile and our recent 1:1 notes. ` +
      `Summarize any open action items from past sessions, note their current projects and focus areas, ` +
      `and suggest topics for today's conversation.`;

    // Send the opening message through sendMessage
    sendMessage(openingPrompt);
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

  const clearConversation = async () => {
    // Cancel pending debounced save
    if (debouncedSaveRef.current) {
      clearTimeout(debouncedSaveRef.current);
      debouncedSaveRef.current = null;
    }
    // Generate TLDR and save before clearing
    if (messages.length > 0 && chatFilePath) {
      const meta = buildMeta();

      // Try to generate a summary for better title
      if (messages.length >= 2) {
        const tldr = await summarizeChat(
          settings, messages, sessionIdRef.current, vaultPath
        );
        if (tldr) meta.title = tldr;
      }

      await saveChat(app, chatFilePath, messages, meta);

      // Update daily note link with the better title
      const currentSkillId = activeSkillIdRef.current;
      const skill = currentSkillId ? skills.find((s) => s.id === currentSkillId) : null;
      const section = skill?.dailyNoteSection || "Capture";
      linkInDailyNote(app, chatFilePath, section, meta.title, settings).catch(() => {});

      // Extract action items and add to daily note
      extractActionItems(messages, settings);
    }
    setMessages([]);
    setChatFilePath(null);
    setSessionId(undefined);
    abortRef.current = true;
    if (procRef.current) {
      procRef.current.kill();
      procRef.current = null;
    }
    setIsStreaming(false);
    setSelectedPerson(null);
    setPersonNotePath(null);
    setShowPersonPicker(false);
    onChatPathChange?.(null);
  };

  const selectSkill = async (skillId: string | null) => {
    // Save current chat before switching skills
    if (messages.length > 0 && chatFilePath) {
      if (debouncedSaveRef.current) {
        clearTimeout(debouncedSaveRef.current);
        debouncedSaveRef.current = null;
      }
      await saveChat(app, chatFilePath, messages, buildMeta());
    }
    setActiveSkillId(skillId);
    setShowSkillMenu(false);
    setSessionId(undefined);
    setMessages([]);
    setChatFilePath(null);
    onChatPathChange?.(null);
  };

  const isRecording = recorder.state === "recording";
  const hasAudio = recorder.audioSegments.length > 0 && recorder.state === "idle";

  return (
    <div className="claude-agent-panel">
      {/* Header */}
      <ChatHeader
        activeSkill={activeSkill}
        activeSkillId={activeSkillId}
        skills={skills}
        showSkillMenu={showSkillMenu}
        effectiveWrite={effectiveWrite}
        effectiveCli={effectiveCli}
        noteContext={noteContext}
        sessionId={sessionId}
        useLocalStt={settings.useLocalStt}
        showTooltips={settings.showTooltips}
        chatMode={chatMode}
        onboardingComplete={settings.onboardingComplete}
        onChatModeToggle={() => setChatMode((m) => m === "agent" ? "chat" : "agent")}
        onSkillMenuToggle={() => setShowSkillMenu((v) => !v)}
        onSkillSelect={selectSkill}
        onToggleWrite={() => setAllowWrite((v) => !v)}
        onToggleCli={() => setAllowCli((v) => !v)}
        onNewChat={clearConversation}
        onOpenSettings={() => {
          const setting = (app as any).setting;
          if (setting) {
            setting.open();
            setting.openTabById("open-brain");
          }
        }}
      />

      {/* Person picker overlay */}
      {showPersonPicker && (
        <PersonPicker
          people={people}
          onSelect={selectPerson}
          onCancel={() => { setShowPersonPicker(false); setActiveSkillId(null); }}
        />
      )}

      {/* Setup banner — only when Claude CLI is missing and not dismissed */}
      {setupStatus && !setupStatus.claudeCli && !setupDismissed && messages.length === 0 && (
        <div className="ca-setup-banner">
          <div className="ca-setup-title">
            Claude Code CLI not found
            <button
              className="ca-setup-dismiss"
              onClick={() => setSetupDismissed(true)}
              aria-label="Dismiss"
            >✕</button>
          </div>
          <div className="ca-setup-text">
            Text chat requires the Claude Code CLI.{" "}
            <a href="https://docs.anthropic.com/en/docs/claude-code" className="ca-setup-link">Install it</a>
            {" "}or check the path in{" "}
            <a
              href="#"
              className="ca-setup-link"
              onClick={(e) => {
                e.preventDefault();
                const setting = (app as any).setting;
                if (setting) { setting.open(); setting.openTabById("open-brain"); }
              }}
            >settings</a>.
          </div>
          {!setupStatus.obsidianCli && (
            <div className="ca-setup-text ca-setup-optional">
              Tip: Enable the Obsidian CLI (Settings → General → Command line interface) for vault search and task tracking.
            </div>
          )}
        </div>
      )}

      {/* Message thread */}
      <div className="ca-thread" ref={threadRef}>
        {/* Welcome flow for first-run onboarding */}
        {!settings.onboardingComplete && messages.length === 0 && !showPersonPicker && (
          <div className="ca-welcome">
            {onboardingStep === 1 && (
              <>
                <div className="ca-welcome-title">Welcome to OpenBrain</div>
                <div className="ca-welcome-text">
                  Your AI assistant for Obsidian — chat, voice, meeting notes, and vault management.
                </div>
                <button
                  className="ca-welcome-btn"
                  onClick={() => setOnboardingStep(2)}
                >
                  Get Started →
                </button>
              </>
            )}
            {onboardingStep === 2 && setupStatus && (
              <>
                <div className="ca-welcome-title">Setup Check</div>
                <div className="ca-welcome-checks">
                  <div className={`ca-welcome-check ${setupStatus.claudeCli ? "ready" : "missing"}`}>
                    <span className="ca-welcome-check-icon">{setupStatus.claudeCli ? "\u2713" : "\u2715"}</span>
                    <span>Claude Code CLI {setupStatus.claudeCli ? "" : "(required for text chat)"}</span>
                  </div>
                  <div className={`ca-welcome-check ${setupStatus.apiKey ? "ready" : "optional"}`}>
                    <span className="ca-welcome-check-icon">{setupStatus.apiKey ? "\u2713" : "\u25CB"}</span>
                    <span>Anthropic API key {setupStatus.apiKey ? "" : "(optional, for voice + chat mode)"}</span>
                  </div>
                  <div className={`ca-welcome-check ${setupStatus.obsidianCli ? "ready" : "optional"}`}>
                    <span className="ca-welcome-check-icon">{setupStatus.obsidianCli ? "\u2713" : "\u25CB"}</span>
                    <span>Obsidian CLI {setupStatus.obsidianCli ? "" : "(optional, for vault search)"}</span>
                  </div>
                </div>
                <button
                  className="ca-welcome-btn"
                  onClick={() => setOnboardingStep(3)}
                  disabled={!setupStatus.claudeCli}
                >
                  Continue →
                </button>
                {!setupStatus.claudeCli && (
                  <div className="ca-welcome-text" style={{ marginTop: 8, fontSize: 12 }}>
                    Install the <a href="https://docs.anthropic.com/en/docs/claude-code" className="ca-setup-link">Claude Code CLI</a> to continue, or check the path in{" "}
                    <a
                      href="#"
                      className="ca-setup-link"
                      onClick={(e) => {
                        e.preventDefault();
                        const setting = (app as any).setting;
                        if (setting) { setting.open(); setting.openTabById("open-brain"); }
                      }}
                    >settings</a>.
                  </div>
                )}
              </>
            )}
            {onboardingStep === 3 && (
              <>
                <div className="ca-welcome-title">Quick Tips</div>
                <div className="ca-welcome-tips">
                  <div className="ca-welcome-tip">
                    <b>Chat</b> — Type a message to talk with Claude about your vault
                  </div>
                  <div className="ca-welcome-tip">
                    <b>@files</b> — Type @ to reference any file in your vault as context
                  </div>
                  <div className="ca-welcome-tip">
                    <b>/skills</b> — Type / to activate skills (meeting notes, vault health, reviews)
                  </div>
                  <div className="ca-welcome-tip">
                    <b>Voice</b> — Use the mic button to record and transcribe audio
                  </div>
                </div>
                <button
                  className="ca-welcome-btn"
                  onClick={() => {
                    settings.onboardingComplete = true;
                    // Persist via plugin settings
                    const setting = (app as any).setting;
                    const plugin = setting?.pluginTabs?.find((t: any) => t.id === "open-brain")?.plugin;
                    if (plugin) {
                      plugin.settings.onboardingComplete = true;
                      plugin.saveSettings();
                    }
                  }}
                >
                  Start chatting →
                </button>
              </>
            )}
          </div>
        )}

        {/* Normal empty state (post-onboarding) */}
        {settings.onboardingComplete && messages.length === 0 && !showPersonPicker && (
          <div className="ca-empty">
            <div className="ca-empty-icon">◈</div>
            {selectedPerson ? (
              <>
                <div className="ca-empty-text">1:1 with {selectedPerson.name}</div>
                <div className="ca-empty-sub">{selectedPerson.role} — {selectedPerson.domain}</div>
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
              {msg.isAudio && <span className="ca-audio-tag">🎙 </span>}
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
              aria-label={tip("Add instructions")}
            >
              ✎
            </button>
            <button className="ca-icon-btn" onClick={recorder.clearAudio} aria-label={tip("Discard")}>
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
            aria-label={tip("Dismiss")}
          >
            ✕
          </button>
        </div>
      )}

      {/* Pending image previews */}
      {pendingImages.length > 0 && (
        <div className="ca-attached-files">
          {pendingImages.map((img, i) => (
            <span key={i} className="ca-attached-file ca-image-preview">
              <img src={img.preview} alt="Attached" className="ca-image-thumb" />
              <button
                className="ca-attached-remove"
                onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
              >✕</button>
            </span>
          ))}
        </div>
      )}

      {/* Input area with @ mentions, / commands, mic, and send */}
      <InputArea
        input={input}
        onInputChange={setInput}
        onSend={handleSend}
        isStreaming={isStreaming}
        isRecording={isRecording}
        attachedFiles={attachedFiles}
        onRemoveFile={(path) => setAttachedFiles((prev) => prev.filter((p) => p !== path))}
        onFileAttach={(path) => setAttachedFiles((prev) => prev.includes(path) ? prev : [...prev, path])}
        skills={skills}
        vaultIndex={vaultIndex ?? null}
        onSkillActivate={handleSkillActivate}
        showTooltips={settings.showTooltips}
        placeholder={isRecording ? "Recording..." : activeSkill?.autoPrompt ? "Press enter to run..." : "Ask anything... (@ to reference a file)"}
      >
        <button
          className={`ca-mic-btn ${isRecording ? "recording" : ""} ${recorder.state === "processing" ? "processing" : ""}`}
          onClick={handleMicClick}
          disabled={isStreaming || recorder.state === "processing"}
          aria-label={tip(isRecording ? "Stop recording" : "Record voice message")}
        >
          {recorder.state === "processing" ? "…" : isRecording ? "■" : "⏺"}
        </button>
        <button
          className="ca-send-btn"
          onClick={handleSend}
          disabled={isStreaming || isRecording || !input.trim()}
          aria-label={tip("Send message")}
        >
          ↑
        </button>
      </InputArea>
    </div>
  );
}
