import React, { useState, useRef, useEffect, useCallback } from "react";
import { transcribeAudioSegments } from "./claude";
import { Message, ChatMessage, ImageAttachment } from "./providers/types";
import { runChat, summarizeChat } from "./chatEngine";
import { useAudioRecorder, formatDuration } from "./useAudioRecorder";
import { OpenBrainSettings } from "./settings";
import { Skill, executePostActions } from "./skills";
import { RecordingStatus } from "./view";
import { App, Component, Notice, Platform } from "obsidian";
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
import { getEmbeddingSearch } from "./toolEngine";
import { PersonProfile, loadPeople, getPersonMeetingFolder } from "./people";
import { createFromTemplate } from "./templates";
import { ChatHeader } from "./components/ChatHeader";
import { PersonPicker } from "./components/PersonPicker";
import { InputArea } from "./components/InputArea";
import { MessageThread } from "./components/MessageThread";
import { AudioControls } from "./components/AudioControls";
import { TaskTray } from "./components/TaskTray";
import { AttachmentManager } from "./attachmentManager";

interface PanelProps {
  settings: OpenBrainSettings;
  app: App;
  initialPrompt?: string;
  initialAttachedFile?: string;
  floatingRecorderStatus?: string | null;
  pendingSkillSend?: string | null;
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

/** Obsidian's internal settings API — not publicly typed. */
interface ObsidianSettingsApi {
  open: () => void;
  openTabById: (id: string) => void;
  pluginTabs?: { id: string; plugin?: { settings: Record<string, unknown>; saveSettings: () => Promise<void> } }[];
}

interface SetupStatus {
  hasProvider: boolean;
  obsidianCli: boolean;
}

function AttachmentPreview({ attachment, attachmentManager, onRemove }: {
  attachment: ImageAttachment;
  attachmentManager: AttachmentManager;
  onRemove: () => void;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const url = await attachmentManager.readAsDataUrl(attachment);
      setDataUrl(url);
    })();
  }, [attachment, attachmentManager]);

  const filename = attachment.vaultPath?.split("/").pop()
    || attachment.assetPath?.split("/").pop()
    || "image";
  const sizeKb = (attachment.sizeBytes / 1024).toFixed(0);

  return (
    <span className="ca-attached-file ca-image-preview">
      {dataUrl ? <img src={dataUrl} alt={filename} className="ca-image-thumb" /> : null}
      <span className="ca-attached-file-info">{filename} ({sizeKb}KB)</span>
      <button className="ca-attached-remove" onClick={onRemove}>&#x2715;</button>
    </span>
  );
}

export function OpenBrainPanel({ settings, app, initialPrompt, initialAttachedFile, floatingRecorderStatus, pendingSkillSend, component, skills, registerToggleRecording, onStatusChange, loadChatRequest, onChatPathChange, vaultIndex }: PanelProps) {
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
  const [pendingAttachments, setPendingAttachments] = useState<ImageAttachment[]>([]);
  const attachmentManager = useRef(new AttachmentManager(app)).current;
  const [showTaskTray, setShowTaskTray] = useState(false);

  // Onboarding state
  const [onboardingStep, setOnboardingStep] = useState<1 | 2 | 3>(1);
  const [onboardingDone, setOnboardingDone] = useState(settings.onboardingComplete);

  // Person picker state (for skills with requiresPerson)
  const [showPersonPicker, setShowPersonPicker] = useState(false);
  const [people, setPeople] = useState<PersonProfile[]>([]);
  const [selectedPerson, setSelectedPerson] = useState<PersonProfile | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => { return () => { mountedRef.current = false; }; }, []);

  const debouncedSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const justLoadedRef = useRef(false);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const activeSkillIdRef = useRef(activeSkillId);
  activeSkillIdRef.current = activeSkillId;

  const vaultPath = (app.vault.adapter as unknown as { basePath?: string }).basePath;

  const threadRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<boolean>(false);
  const responseRef = useRef<string>("");

  const recorder = useAudioRecorder();

  const availableSkills = Platform.isMobile ? skills.filter(s => !s.tools.cli) : skills;
  const activeSkill = availableSkills.find((s) => s.id === activeSkillId) || null;

  const effectiveWrite = activeSkill?.tools.write ?? allowWrite;
  const effectiveCli = activeSkill?.tools.cli ?? allowCli;
  const baseSystemPrompt = activeSkill?.systemPrompt || settings.systemPrompt;
  const folderContext = [
    `\nConfigured vault folders:`,
    `- Meetings: ${settings.meetingsFolder}`,
    `- 1:1s: ${settings.oneOnOneFolder}`,
    `- Reviews: ${settings.reviewsFolder}`,
    `- Projects: ${settings.projectsFolder}`,
    `- People: ${settings.peopleFolder}`,
  ].join("\n");
  const effectiveSystemPrompt = selectedPerson
    ? `${baseSystemPrompt}\n\n--- Person Context ---\n${selectedPerson.fullContent}${folderContext}`
    : `${baseSystemPrompt}${folderContext}`;

  // Check setup status on mount
  const [setupDismissed, setSetupDismissed] = useState(false);
  useEffect(() => {
    const check = () => {
      // Check if any provider is configured
      let hasProvider = false;
      if (settings.chatProvider === "anthropic" && settings.apiKey) hasProvider = true;
      if (settings.chatProvider === "openrouter" && settings.openrouterApiKey) hasProvider = true;
      if (settings.chatProvider === "ollama") hasProvider = true; // Ollama just needs to be running

      let obsidianCli = false;
      if (Platform.isDesktop) {
        try {
          const { execSync } = require("child_process") as typeof import("child_process");
          const home = process.env.HOME || "";
          const extraPaths = ["/usr/local/bin", "/opt/homebrew/bin", `${home}/.local/bin`, "/Applications/Obsidian.app/Contents/MacOS"];
          const env = { ...process.env, PATH: [...extraPaths, process.env.PATH].filter(Boolean).join(":") };
          execSync("obsidian version", { timeout: 5000, encoding: "utf-8", env });
          obsidianCli = true;
        } catch { /* expected — CLI may not be installed */ }
      }

      setSetupStatus({ hasProvider, obsidianCli });
    };
    check();
  }, [settings.chatProvider, settings.apiKey, settings.openrouterApiKey]);

  // Apply tool overrides when skill changes
  useEffect(() => {
    if (activeSkill) {
      if (activeSkill.tools.write !== undefined) setAllowWrite(activeSkill.tools.write);
      if (activeSkill.tools.cli !== undefined) setAllowCli(activeSkill.tools.cli);
    }
  }, [activeSkillId]);

  // Auto-send auto_prompt when skill changes
  useEffect(() => {
    if (activeSkill?.autoPrompt) {
      void sendMessage(activeSkill.autoPrompt);
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
    void loadNote();

    const ref = app.workspace.on("active-leaf-change", () => void loadNote());
    return () => app.workspace.offref(ref);
  }, [app, settings.includeActiveNote]);

  // Set initial prompt from outside
  useEffect(() => {
    if (initialPrompt) setInput(initialPrompt);
  }, [initialPrompt]);

  // Pre-attach a file (e.g., from floating recorder)
  useEffect(() => {
    if (initialAttachedFile) {
      setAttachedFiles((prev) =>
        prev.includes(initialAttachedFile) ? prev : [...prev, initialAttachedFile]
      );
    }
  }, [initialAttachedFile]);

  // Auto-activate skill and send when triggered by floating recorder
  const pendingSkillSendRef = useRef<string | null>(null);
  useEffect(() => {
    if (pendingSkillSend && pendingSkillSend !== pendingSkillSendRef.current) {
      pendingSkillSendRef.current = pendingSkillSend;

      // Activate the skill
      setActiveSkillId(pendingSkillSend);

      // Wait a tick for the skill to set the auto_prompt, then send
      setTimeout(() => {
        const skill = skills.find((s) => s.id === pendingSkillSend);
        const prompt = skill?.autoPrompt || `Process this recording with the ${skill?.name || "selected"} skill.`;
        void sendMessage(prompt);
      }, 200);
    }
  }, [pendingSkillSend, skills]);

  // Handle image paste (Cmd+V)
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (!blob) continue;

          const chatId = chatFilePathRef.current
            ?.split("/").pop()?.replace(".md", "") || generateId();

          void (async () => {
            const attachment = await attachmentManager.addFromClipboard(blob, chatId);
            if (attachment) {
              setPendingAttachments((prev) => [...prev, attachment]);
            }
          })();
        }
      }
    };

    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [attachmentManager]);

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

    debouncedSaveRef.current = setTimeout(() => { void (async () => {
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
        void linkInDailyNote(app, path, section, meta.title, settings).catch(() => { /* expected — best-effort daily note update */ });
      }
    })(); }, 500);

    return () => {
      if (debouncedSaveRef.current) clearTimeout(debouncedSaveRef.current);
    };
  }, [messages, isStreaming]);

  // Load chat on mount from loadChatRequest
  useEffect(() => {
    if (!loadChatRequest) return;

    void (async () => {
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
  const extractActionItems = (msgs: Message[], s: OpenBrainSettings) => {
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

    void appendToDailySection(app, taskBlock, "Capture", s).catch(() => { /* expected — best-effort daily note update */ });
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

  const postActionsRanRef = useRef(false);

  // Reset post_actions flag when skill or conversation changes
  useEffect(() => {
    postActionsRanRef.current = false;
  }, [activeSkillId, chatFilePath]);

  const runPostActions = useCallback(async () => {
    if (!activeSkill || activeSkill.postActions.length === 0) return;
    if (postActionsRanRef.current) return; // Only fire once per skill session

    const response = responseRef.current;
    if (!response.trim()) return;

    postActionsRanRef.current = true;
    const results = await executePostActions(app, activeSkill.postActions, response, settings);

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
        images: pendingAttachments.length > 0 ? [...pendingAttachments] : undefined,
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

      const onError = (err: string) => {
        setIsStreaming(false);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: `Error: ${err}` }
              : m
          )
        );
      };

      const audioDone = async () => {
        setIsStreaming(false);
        recorder.clearAudio();
        setAudioPrompt("");
        setShowAudioPrompt(false);
        await runPostActions();
      };

      if (hasAudioInput && settings.useLocalStt && Platform.isDesktop) {
        // --- Audio path: local STT (desktop only) ---
        try {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: "Transcribing locally..." }
                : m
            )
          );

          const { transcribeBlob, transcribeSegments } = await import("./stt");
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
            // Send transcription for analysis via chatEngine
            const analysisId = generateId();
            const analysisMsg: Message = {
              id: analysisId,
              role: "assistant",
              content: "",
              timestamp: new Date(),
            };
            setMessages((prev) => [...prev, analysisMsg]);
            responseRef.current = "";

            const prompt = activeSkill?.autoPrompt || audioPrompt || "Process this transcription";
            const analysisPrompt = `${prompt}\n\nTranscription:\n${transcription}`;

            const apiMessages: ChatMessage[] = messages.map(m => ({
              role: m.role,
              content: m.content
            }));
            apiMessages.push({ role: "user", content: analysisPrompt });

            await runChat(app, settings, {
              messages: apiMessages,
              systemPrompt: effectiveSystemPrompt,
              allowWrite: effectiveWrite,
              attachmentManager,
              useTools: chatMode === "agent",
              onText: (text) => {
                if (!abortRef.current) appendAssistantChunk(analysisId, text);
              },
              onToolStart: (name) => {
                if (!abortRef.current) appendAssistantChunk(analysisId, `\n*Using ${name}...*\n`);
              },
              onToolEnd: () => { /* Tool completed */ },
              onDone: () => { void (async () => {
                setIsStreaming(false);
                recorder.clearAudio();
                setAudioPrompt("");
                setShowAudioPrompt(false);
                await runPostActions();
              })(); },
              onError,
            });
          } else {
            // Transcription only — run postActions with raw transcription
            await runPostActions();
            setIsStreaming(false);
            recorder.clearAudio();
            setAudioPrompt("");
            setShowAudioPrompt(false);
          }
        } catch (err: unknown) {
          const errMessage = err instanceof Error ? err.message : String(err);
          onError(
            `Local transcription failed: ${errMessage}\n` +
              "Check that sherpa-onnx is installed via Settings > OpenBrain."
          );
          recorder.clearAudio();
          setAudioPrompt("");
          setShowAudioPrompt(false);
        }
      } else if (hasAudioInput && settings.apiKey && audioSegments.length > 1) {
        // --- Multi-segment API transcription (requires Anthropic key) ---
        await transcribeAudioSegments(settings, {
          onChunk: (chunk: string) => {
            if (!abortRef.current) appendAssistantChunk(assistantId, chunk);
          },
          onError,
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
          onDone: () => void audioDone(),
        });
      } else if (hasAudioInput && settings.apiKey) {
        // --- Single-segment API transcription (requires Anthropic key) ---
        await transcribeAudioSegments(settings, {
          onChunk: (chunk: string) => {
            if (!abortRef.current) appendAssistantChunk(assistantId, chunk);
          },
          onError,
          segments: audioSegments,
          systemPrompt: effectiveSystemPrompt,
          noteContext,
          audioPrompt: audioPrompt || "Transcribe this audio. If there are action items or key points, note them after the transcription.",
          onProgress: () => { /* single segment, no progress needed */ },
          onDone: () => void audioDone(),
        });
      } else if (hasAudioInput) {
        // --- Audio with no transcription available ---
        onError("Voice transcription requires either local STT (Settings → Local speech-to-text) or an API key from your configured provider.");
        setIsStreaming(false);
        return;
      } else {
        // --- Text message path (both Chat and Vault modes) ---
        let recentContext = "";
        if (chatMode === "agent" && !chatFilePath && messages.length === 0) {
          recentContext = await getRecentChatContext();
        }

        const smartCtx = await buildSmartContext(app, userText, attachedFiles, getEmbeddingSearch(), attachmentManager, settings);
        const contextImages = smartCtx.images;
        const allContext = [noteContext, recentContext, smartCtx.text].filter(Boolean).join("");
        const allImages = [...pendingAttachments, ...contextImages];

        let fullPrompt = userText;

        // Attach @ referenced files
        if (attachedFiles.length > 0) {
          fullPrompt += "\n\nReferenced files (read these before responding):\n" +
            attachedFiles.map((p) => `- ${p}`).join("\n");
          setAttachedFiles([]);
        }

        // Enrich system prompt with note context
        const enrichedSystemPrompt = allContext
          ? `${effectiveSystemPrompt}\n\n---\nActive note content:\n${allContext}`
          : effectiveSystemPrompt;

        // Build messages for the API
        const apiMessages: ChatMessage[] = messages.map(m => ({
          role: m.role,
          content: m.content
        }));
        apiMessages.push({ role: "user", content: fullPrompt });

        await runChat(app, settings, {
          messages: apiMessages,
          systemPrompt: enrichedSystemPrompt,
          allowWrite: effectiveWrite,
          images: allImages.length > 0 ? allImages : undefined,
          attachmentManager,
          useTools: chatMode === "agent",
          onText: (text) => {
            if (!abortRef.current) appendAssistantChunk(assistantId, text);
          },
          onToolStart: (name) => {
            if (!abortRef.current) appendAssistantChunk(assistantId, `\n*Using ${name}...*\n`);
          },
          onToolEnd: () => { /* Tool completed — model will continue with the result */ },
          onDone: () => { void (async () => {
            setIsStreaming(false);
            recorder.clearAudio();
            setAudioPrompt("");
            setShowAudioPrompt(false);
            await runPostActions();
          })(); },
          onError,
        });
        if (pendingAttachments.length > 0) setPendingAttachments([]);
      }
    },
    [isStreaming, messages, settings, noteContext, audioPrompt, appendAssistantChunk, recorder, effectiveWrite, effectiveSystemPrompt, runPostActions, chatMode, chatFilePath, pendingAttachments, attachedFiles, activeSkill, app, attachmentManager]
  );

  const handleSend = useCallback(() => {
    void sendMessage(input);
  }, [input, sendMessage]);

  // Handle skill activation from InputArea slash command
  const handleSkillActivate = async (skill: Skill) => {
    setActiveSkillId(skill.id);

    // If skill requires a person, show the person picker
    if (skill.requiresPerson) {
      const loaded = await loadPeople(app, settings.peopleFolder);
      setPeople(loaded);
      setShowPersonPicker(true);
    } else {
      setSelectedPerson(null);
    }
  };

  // Handle person selection — create 1:1 note, load context, send opening message
  const selectPerson = async (person: PersonProfile) => {
    setSelectedPerson(person);
    setShowPersonPicker(false);

    // Create the 1:1 note from template
    const folder = getPersonMeetingFolder(person.name, settings.oneOnOneFolder);
    const dateStr = new Date().toISOString().slice(0, 10);
    const notePath = `${folder}/${dateStr}.md`;
    const created = await createFromTemplate(app, "One on One.md", notePath, {
      title: person.name,
    }, settings.templatesFolder);
    if (!mountedRef.current) return;
    if (created) {
      // Link the 1:1 note in today's daily note under Meetings
      void linkInDailyNote(app, created, "Meetings", `1:1 — ${person.name}`, settings).catch(() => { /* expected — daily note may not exist */ });
    }

    // Build file references: person profile + recent 1:1 notes
    const filesToReference = [person.filePath];
    if (!mountedRef.current) return;

    // Also reference the recent 1:1 note files directly
    const recentFolder = getPersonMeetingFolder(person.name, settings.oneOnOneFolder);
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
    void sendMessage(openingPrompt);
  };

  const handleMicClick = useCallback(async () => {
    if (recorder.state === "recording") {
      const segs = await recorder.stopRecording();
      if (segs.length > 0 && settings.transcribeOnStop) {
        void sendMessage(audioPrompt || "Voice message", segs);
      }
    } else {
      const deviceId = settings.audioDeviceId || undefined;
      await recorder.startRecording(deviceId);
    }
  }, [recorder, settings.transcribeOnStop, settings.audioDeviceId, audioPrompt, sendMessage]);

  // Keep a ref to handleMicClick so the toggle registration can use it
  const handleMicClickRef = useRef<(() => void) | null>(null);
  handleMicClickRef.current = () => void handleMicClick();

  const handleSendAudio = () => {
    if (recorder.audioSegments.length > 0) {
      void sendMessage(audioPrompt || "Voice message", recorder.audioSegments);
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
        const tldr = await summarizeChat(settings, messages);
        if (tldr) meta.title = tldr;
      }

      await saveChat(app, chatFilePath, messages, meta);

      // Update daily note link with the better title
      const currentSkillId = activeSkillIdRef.current;
      const skill = currentSkillId ? skills.find((s) => s.id === currentSkillId) : null;
      const section = skill?.dailyNoteSection || "Capture";
      void linkInDailyNote(app, chatFilePath, section, meta.title, settings).catch(() => { /* expected — best-effort daily note update */ });

      // Extract action items and add to daily note
      extractActionItems(messages, settings);
    }
    setMessages([]);
    setChatFilePath(null);
    setSessionId(undefined);
    abortRef.current = true;
    setIsStreaming(false);
    setSelectedPerson(null);
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
    <div className={`claude-agent-panel${isRecording ? " is-recording" : ""}${isStreaming ? " is-streaming" : ""}${showTaskTray ? " tray-open" : ""}`}>
      {/* Header */}
      <ChatHeader
        activeSkill={activeSkill}
        activeSkillId={activeSkillId}
        skills={availableSkills}
        showSkillMenu={showSkillMenu}
        effectiveWrite={effectiveWrite}
        effectiveCli={effectiveCli}
        showCliToggle={Platform.isDesktop}
        noteContext={noteContext}
        sessionId={sessionId}
        useLocalStt={settings.useLocalStt}
        showTooltips={settings.showTooltips}
        chatMode={chatMode}
        onboardingComplete={onboardingDone}
        taskTrayOpen={showTaskTray}
        onChatModeToggle={() => setChatMode((m) => m === "agent" ? "chat" : "agent")}
        onSkillMenuToggle={() => setShowSkillMenu((v) => !v)}
        onSkillSelect={(id) => void selectSkill(id)}
        onToggleWrite={() => setAllowWrite((v) => !v)}
        onToggleCli={() => setAllowCli((v) => !v)}
        onNewChat={() => void clearConversation()}
        onOpenSettings={() => {
          const setting = (app as unknown as { setting?: ObsidianSettingsApi }).setting;
          if (setting) {
            setting.open();
            setting.openTabById("open-brain");
          }
        }}
        onToggleTaskTray={() => setShowTaskTray((v) => !v)}
      />

      {/* Floating recorder status banner */}
      {floatingRecorderStatus && (
        <div className="ca-floating-status">
          <div className="ca-floating-status-chrome">
            <span className="ca-floating-status-label">OpenBrain Recorder</span>
          </div>
          <div className="ca-floating-status-body">
            <span className="ca-floating-status-dot" />
            <span className="ca-floating-status-text">{floatingRecorderStatus}</span>
          </div>
        </div>
      )}

      {/* Person picker overlay */}
      {showPersonPicker && (
        <PersonPicker
          people={people}
          onSelect={(person) => void selectPerson(person)}
          onCancel={() => { setShowPersonPicker(false); setActiveSkillId(null); }}
        />
      )}

      {/* Setup banner — only when no provider is configured and not dismissed */}
      {setupStatus && !setupStatus.hasProvider && !setupDismissed && messages.length === 0 && (
        <div className="ca-setup-banner">
          <div className="ca-setup-title">
            No API provider configured
            <button
              className="ca-setup-dismiss"
              onClick={() => setSetupDismissed(true)}
              aria-label="Dismiss"
            >&#x2715;</button>
          </div>
          <div className="ca-setup-text">
            Configure an API key in{" "}
            <a
              href="#"
              className="ca-setup-link"
              onClick={(e) => {
                e.preventDefault();
                const setting = (app as unknown as { setting?: ObsidianSettingsApi }).setting;
                if (setting) { setting.open(); setting.openTabById("open-brain"); }
              }}
            >settings</a>{" "}
            to start chatting. Supports Anthropic, OpenRouter, or Ollama (local).
          </div>
        </div>
      )}

      {/* Message thread */}
      <div className="ca-thread" ref={threadRef}>
        {/* Welcome flow for first-run onboarding */}
        {!onboardingDone && messages.length === 0 && !showPersonPicker && (
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
                  <div className={`ca-welcome-check ${setupStatus.hasProvider ? "ready" : "missing"}`}>
                    <span className="ca-welcome-check-icon">{setupStatus.hasProvider ? "\u2713" : "\u2715"}</span>
                    <span>API provider {setupStatus.hasProvider ? `(${settings.chatProvider})` : "(configure in settings)"}</span>
                  </div>
                  <div className={`ca-welcome-check ${setupStatus.obsidianCli ? "ready" : "optional"}`}>
                    <span className="ca-welcome-check-icon">{setupStatus.obsidianCli ? "\u2713" : "\u25CB"}</span>
                    <span>Obsidian CLI {setupStatus.obsidianCli ? "" : "(optional, for vault search)"}</span>
                  </div>
                </div>
                <button
                  className="ca-welcome-btn"
                  onClick={() => setOnboardingStep(3)}
                  disabled={!setupStatus.hasProvider}
                >
                  Continue &#x2192;
                </button>
                {!setupStatus.hasProvider && (
                  <div className="ca-welcome-text" style={{ marginTop: 8, fontSize: 12 }}>
                    Configure an API provider in{" "}
                    <a
                      href="#"
                      className="ca-setup-link"
                      onClick={(e) => {
                        e.preventDefault();
                        const setting = (app as unknown as { setting?: ObsidianSettingsApi }).setting;
                        if (setting) { setting.open(); setting.openTabById("open-brain"); }
                      }}
                    >settings</a>{" "}
                    (Anthropic, OpenRouter, or Ollama).
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
                    setOnboardingDone(true);
                    settings.onboardingComplete = true;
                    // Persist via plugin settings
                    const setting = (app as unknown as { setting?: ObsidianSettingsApi }).setting;
                    const plugin = setting?.pluginTabs?.find((t) => t.id === "open-brain")?.plugin;
                    if (plugin) {
                      plugin.settings.onboardingComplete = true;
                      void plugin.saveSettings();
                    }
                  }}
                >
                  Start chatting →
                </button>
              </>
            )}
          </div>
        )}

        <MessageThread
          messages={messages}
          isStreaming={isStreaming}
          activeSkill={activeSkill}
          selectedPerson={selectedPerson}
          onboardingDone={onboardingDone}
          showPersonPicker={showPersonPicker}
          app={app}
          component={component}
          showTooltips={settings.showTooltips}
          attachmentManager={attachmentManager}
        />
      </div>

      <AudioControls
        isRecording={isRecording}
        hasAudio={hasAudio}
        isStreaming={isStreaming}
        recorder={recorder}
        audioPrompt={audioPrompt}
        showAudioPrompt={showAudioPrompt}
        showTooltips={settings.showTooltips}
        onAudioPromptChange={setAudioPrompt}
        onToggleAudioPrompt={() => setShowAudioPrompt((v) => !v)}
        onSendAudio={handleSendAudio}
        formatDuration={formatDuration}
      />

      {/* Pending image previews */}
      {pendingAttachments.length > 0 && (
        <div className="ca-attached-files">
          {pendingAttachments.map((att) => (
            <AttachmentPreview
              key={att.id}
              attachment={att}
              attachmentManager={attachmentManager}
              onRemove={() => setPendingAttachments((prev) => prev.filter((a) => a.id !== att.id))}
            />
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
        skills={availableSkills}
        vaultIndex={vaultIndex ?? null}
        onSkillActivate={(skill) => void handleSkillActivate(skill)}
        showTooltips={settings.showTooltips}
        placeholder={isRecording ? "Recording..." : activeSkill?.autoPrompt ? "Press enter to run..." : "Ask anything... (@ to reference a file)"}
        onMicClick={() => void handleMicClick()}
        micState={recorder.state === "processing" ? "processing" : isRecording ? "recording" : "idle"}
        isSendDisabled={isStreaming || isRecording || !input.trim()}
        onImageDrop={async (file) => {
          const chatId = chatFilePathRef.current?.split("/").pop()?.replace(".md", "") || generateId();
          const att = await attachmentManager.addFromDrop(file, chatId);
          if (att) setPendingAttachments((prev) => [...prev, att]);
        }}
        onImageAttach={async (vaultPath) => {
          const att = await attachmentManager.addFromVault(vaultPath);
          if (att) setPendingAttachments((prev) => [...prev, att]);
        }}
      />

      {/* Task tray — slides from right */}
      <TaskTray
        app={app}
        settings={settings}
        isOpen={showTaskTray}
        onClose={() => setShowTaskTray(false)}
        onFocusTask={(task) => {
          // Set the task as chat context — prefill input and attach source file
          setInput(`Help me work on this task: "${task.text}"`);
          setAttachedFiles((prev) => prev.includes(task.file) ? prev : [...prev, task.file]);
          setShowTaskTray(false);
        }}
      />
    </div>
  );
}
