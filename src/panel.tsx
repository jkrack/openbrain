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
import { ChatStateManager } from "./chatStateManager";

interface PanelProps {
  settings: OpenBrainSettings;
  app: App;
  chatState: ChatStateManager;
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

export function OpenBrainPanel({ settings, app, chatState, initialPrompt, initialAttachedFile, floatingRecorderStatus, pendingSkillSend, component, skills, registerToggleRecording, onStatusChange, loadChatRequest, onChatPathChange, vaultIndex }: PanelProps) {
  // ── Subscribe to ChatStateManager for shared state ─────────────────────
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const handler = () => forceUpdate((n) => n + 1);
    chatState.on("change", handler);
    return () => { chatState.off("change", handler); };
  }, [chatState]);

  // Read shared state from ChatStateManager
  const state = chatState.getState();
  const messages = state.messages;
  const isStreaming = state.isStreaming;
  const chatFilePath = state.chatFilePath;
  const activeSkillId = state.activeSkillId;
  const allowWrite = state.allowWrite;
  const allowCli = state.allowCli;
  const chatMode = state.chatMode;

  // ── Local UI-only state (not shared) ───────────────────────────────────
  const [input, setInput] = useState(initialPrompt || "");
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [noteContext, setNoteContext] = useState<string | undefined>();
  const [noteFilePath, setNoteFilePath] = useState<string | undefined>();
  const [audioPrompt, setAudioPrompt] = useState("");
  const [showAudioPrompt, setShowAudioPrompt] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [showSkillMenu, setShowSkillMenu] = useState(false);

  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<ImageAttachment[]>([]);
  const attachmentManager = useRef(new AttachmentManager(app)).current;
  const [showTaskTray, setShowTaskTray] = useState(false);

  // Onboarding state
  const [onboardingStep, setOnboardingStep] = useState<1 | 2 | 3 | 4>(1);
  const [onboardingDone, setOnboardingDone] = useState(settings.onboardingComplete);

  // Person picker state (for skills with requiresPerson)
  const [showPersonPicker, setShowPersonPicker] = useState(false);
  const [people, setPeople] = useState<PersonProfile[]>([]);
  const [selectedPerson, setSelectedPerson] = useState<PersonProfile | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => { return () => { mountedRef.current = false; }; }, []);

  // Initialize shared state from settings on first mount
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      chatState.setAllowWrite(settings.allowVaultWrite);
      chatState.setAllowCli(settings.allowCliExec);
    }
  }, [chatState, settings.allowVaultWrite, settings.allowCliExec]);

  const debouncedSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const justLoadedRef = useRef(false);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const vaultPath = (app.vault.adapter as unknown as { basePath?: string }).basePath;

  const threadRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<boolean>(false);
  const responseRef = useRef<string>("");   // Full display text (includes tool status)
  const contentRef = useRef<string>("");    // Clean content only (for post-actions)

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

      setSetupStatus({ hasProvider });
    };
    check();
  }, [settings.chatProvider, settings.apiKey, settings.openrouterApiKey]);

  // Apply tool overrides when skill changes
  useEffect(() => {
    if (activeSkill) {
      if (activeSkill.tools.write !== undefined) chatState.setAllowWrite(activeSkill.tools.write);
      if (activeSkill.tools.cli !== undefined) chatState.setAllowCli(activeSkill.tools.cli);
    }
  }, [activeSkillId, chatState]);

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
      chatState.setActiveSkillId(pendingSkillSend);

      // Wait a tick for the skill to set the auto_prompt, then send
      setTimeout(() => {
        const skill = skills.find((s) => s.id === pendingSkillSend);
        const prompt = skill?.autoPrompt || `Process this recording with the ${skill?.name || "selected"} skill.`;
        void sendMessage(prompt);
      }, 200);
    }
  }, [pendingSkillSend, skills, chatState]);

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

          const chatId = chatState.getState().chatFilePath
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

    const doc = (component as any)?.containerEl?.ownerDocument ?? document;
    doc.addEventListener("paste", handlePaste);
    return () => doc.removeEventListener("paste", handlePaste);
  }, [attachmentManager, chatState, component]);

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
    const currentMessages = chatState.getState().messages;
    const firstMsg = currentMessages[0];
    const currentSkillId = chatState.getState().activeSkillId;
    return {
      type: "openbrain-chat",
      formatVersion: 1,
      created: firstMsg ? firstMsg.timestamp.toISOString() : now,
      updated: now,
      skill: currentSkillId
        ? skills.find((s) => s.id === currentSkillId)?.name ?? "General"
        : "General",
      sessionId: sessionIdRef.current ?? "",
      messageCount: currentMessages.length,
      hasAudio: currentMessages.some((m) => m.isAudio),
      title: generateChatTitle(currentMessages),
      tags: ["openbrain/chat"],
    };
  }

  // Debounced auto-save
  const doSave = useCallback(async () => {
    const { messages: currentMessages, chatFilePath: currentPath, activeSkillId: currentSkillId } = chatState.getState();
    if (currentMessages.length === 0) return;
    const meta = buildMeta();
    const folder = settings.chatFolder || "OpenBrain/chats";
    const path = currentPath ?? `${folder}/${generateChatFilename()}`;
    await saveChat(app, path, currentMessages, meta);
    if (!mountedRef.current) return;
    if (!currentPath) {
      chatState.setChatFilePath(path);
      onChatPathChange?.(path);

      // Link new chat in today's daily note
      const skill = currentSkillId ? skills.find((s) => s.id === currentSkillId) : null;
      const section = skill?.dailyNoteSection || "Capture";
      void linkInDailyNote(app, path, section, meta.title, settings).catch(() => { /* expected — best-effort daily note update */ });
    }
  }, [chatState, app, settings, skills, onChatPathChange]);

  useEffect(() => {
    if (messages.length === 0 || isStreaming) return;
    if (justLoadedRef.current) {
      justLoadedRef.current = false;
      return;
    }

    if (debouncedSaveRef.current) clearTimeout(debouncedSaveRef.current);

    debouncedSaveRef.current = setTimeout(() => { void doSave(); }, 500);

    return () => {
      if (debouncedSaveRef.current) clearTimeout(debouncedSaveRef.current);
    };
  }, [messages, isStreaming, doSave]);

  // Force-save listener — used by detach command to immediately flush pending saves
  useEffect(() => {
    const handler = () => {
      if (debouncedSaveRef.current) {
        clearTimeout(debouncedSaveRef.current);
        debouncedSaveRef.current = null;
      }
      void doSave();
    };
    chatState.on("force-save", handler);
    return () => { chatState.off("force-save", handler); };
  }, [chatState, doSave]);

  // Load chat on mount from loadChatRequest
  useEffect(() => {
    if (!loadChatRequest) return;

    void (async () => {
      const chatFile = await loadChat(app, loadChatRequest.path);
      if (chatFile) {
        justLoadedRef.current = true;
        chatState.setMessages(chatFile.messages);
        chatState.setChatFilePath(chatFile.path);
        setSessionId(chatFile.frontmatter.sessionId || undefined);
        const matchSkill = skills.find(
          (s) => s.name === chatFile.frontmatter.skill
        );
        chatState.setActiveSkillId(matchSkill?.id ?? null);
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
    chatState.updateMessages((prev) =>
      prev.map((m) =>
        m.id === id ? { ...m, content: m.content + chunk } : m
      )
    );
  }, [chatState]);

  const pendingFinishingSkillRef = useRef<Skill | null>(null);
  const postActionsRanRef = useRef(false);

  // Reset post_actions flag when skill or conversation changes
  useEffect(() => {
    postActionsRanRef.current = false;
  }, [activeSkillId, chatFilePath]);

  const runPostActions = useCallback(async () => {
    if (!activeSkill || activeSkill.postActions.length === 0) return;
    if (postActionsRanRef.current) return; // Only fire once per skill session

    const response = contentRef.current;
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
      chatState.addMessage(feedbackMsg);
    }
  }, [activeSkill, app, chatState]);

  const applyFinishingSkill = useCallback(async (skill: Skill, personArg?: string) => {
    const msgCount = chatState.getState().messages.length;
    console.log(`[OpenBrain] /finishing: ${skill.name}, args=${personArg}, messages=${msgCount}, streaming=${chatState.getState().isStreaming}`);

    if (chatState.getState().isStreaming) {
      new Notice("Still processing — wait for the current response to finish.");
      return;
    }

    // Resolve person if needed
    let person: { name: string; context?: string } | null = null;
    if (skill.requiresPerson) {
      if (personArg) {
        const loaded = await loadPeople(app, settings.peopleFolder);
        person = loaded.find(p =>
          p.name.toLowerCase().includes(personArg.toLowerCase())
        ) || null;
        if (!person) {
          setPeople(loaded);
          setShowPersonPicker(true);
          pendingFinishingSkillRef.current = skill;
          return;
        }
      } else {
        const loaded = await loadPeople(app, settings.peopleFolder);
        setPeople(loaded);
        setShowPersonPicker(true);
        pendingFinishingSkillRef.current = skill;
        return;
      }
    }

    const allMessages = chatState.getState().messages;
    if (allMessages.length === 0) {
      new Notice("Record or type a conversation first, then use the slash command to package it.");
      return;
    }

    chatState.setActiveSkillId(skill.id);
    chatState.setStreaming(true);
    postActionsRanRef.current = false;

    // Show visible feedback that the finishing skill is running
    const statusId = generateId();
    chatState.addMessage({
      id: statusId,
      role: "assistant",
      content: `Packaging ${allMessages.length} messages as **${skill.name}**...`,
      timestamp: new Date(),
    });

    const conversationText = allMessages
      .filter(m => m.id !== statusId)  // Don't include the status message itself
      .map(m => `### ${m.role === "user" ? "User" : "Assistant"}\n${m.content}`)
      .join("\n\n");

    const personName = person?.name || "";
    let systemPrompt = skill.systemPrompt;
    if (personName) {
      systemPrompt = systemPrompt.replace(/\{\{person\}\}/g, personName);
    }
    if (person?.context) {
      systemPrompt += `\n\nPerson context:\n${person.context}`;
    }

    const chatPath = chatState.getState().chatFilePath || "";
    const chatLink = chatPath
      ? `\n\nInclude this in the note's YAML frontmatter as \`chat: "[[${chatPath.replace(/\.md$/, "")}]]"\``
      : "";

    const userPrompt = `Here is the full conversation to package:\n\n${conversationText}${chatLink}`;

    // Replace status message with streaming response
    const assistantId = statusId;
    chatState.updateMessages(prev =>
      prev.map(m => m.id === statusId ? { ...m, content: "" } : m)
    );
    responseRef.current = "";
    contentRef.current = "";

    const apiMessages: ChatMessage[] = [
      { role: "user", content: userPrompt },
    ];

    await runChat(app, settings, {
      messages: apiMessages,
      systemPrompt,
      allowWrite: skill.tools?.write || false,
      attachmentManager,
      useTools: false,
      onEvent: (event) => {
        if (abortRef.current) return;
        switch (event.type) {
          case "content":
            contentRef.current += event.text;
            appendAssistantChunk(assistantId, event.text);
            break;
          case "tool_start":
          case "tool_end":
            break;
          case "done":
            void (async () => {
              chatState.setStreaming(false);

              const response = contentRef.current;
              if (skill.postActions.length > 0 && response.trim()) {
                const extraVars: Record<string, string> = {};
                if (personName) extraVars.person = personName;

                const results = await executePostActions(app, skill.postActions, response, settings, extraVars);

                // Handle backlink
                const backlinkResult = results.find(r => r.message.startsWith("backlink:"));
                if (backlinkResult) {
                  const notePath = backlinkResult.message.replace("backlink:", "");
                  if (notePath) {
                    const meta = buildMeta();
                    meta.meetingNote = notePath;
                    const cp = chatState.getState().chatFilePath;
                    if (cp) {
                      const msgs = chatState.getState().messages;
                      await saveChat(app, cp, msgs, meta);
                    }
                  }
                }

                const feedback = results
                  .filter(r => !r.message.startsWith("backlink:"))
                  .map(r => r.success ? r.message : `Failed: ${r.message}`)
                  .join("\n");
                if (feedback) {
                  chatState.addMessage({
                    id: generateId(),
                    role: "assistant",
                    content: `---\n${feedback}`,
                    timestamp: new Date(),
                  });
                }
              }
            })();
            break;
          case "error":
            console.error("[OpenBrain] finishing skill error:", event.message);
            chatState.setStreaming(false);
            chatState.updateMessages(prev =>
              prev.map(m => m.id === assistantId ? { ...m, content: `**Finishing skill failed:** ${event.message}\n\nCheck your API key and provider settings.` } : m)
            );
            break;
        }
      },
    });
  }, [app, settings, chatState, attachmentManager, appendAssistantChunk]);

  const sendMessage = useCallback(
    async (userText: string, audioSegments?: Blob[]) => {
      // Check for finishing skill slash command
      if (userText.startsWith("/")) {
        const parts = userText.slice(1).split(/\s+/);
        const command = parts[0].toLowerCase();
        const args = parts.slice(1).join(" ") || undefined;
        const finishingSkill = availableSkills.find(
          s => s.finishing && s.slashCommand === command
        );
        if (finishingSkill) {
          void applyFinishingSkill(finishingSkill, args);
          return;
        }
      }

      if (chatState.getState().isStreaming) return;
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

      chatState.updateMessages((prev) => [...prev, userMsg, assistantMsg]);
      setInput("");
      chatState.setStreaming(true);
      abortRef.current = false;
      responseRef.current = "";
      contentRef.current = "";

      const onError = (err: string) => {
        chatState.setStreaming(false);
        chatState.updateMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: `Error: ${err}` }
              : m
          )
        );
      };

      const audioDone = async () => {
        chatState.setStreaming(false);
        recorder.clearAudio();
        setAudioPrompt("");
        setShowAudioPrompt(false);
        await runPostActions();
      };

      if (hasAudioInput && Platform.isDesktop) {
        // --- Audio path: daemon STT (desktop, auto-detected) ---
        try {
          chatState.updateMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: "\u{1F43A} Transcribing..." }
                : m
            )
          );

          const { transcribeBlob, transcribeSegments } = await import("./stt");
          const result = audioSegments.length > 1
            ? await transcribeSegments(audioSegments, settings, (current, total) => {
                if (!abortRef.current) {
                  chatState.updateMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantId
                        ? { ...m, content: `\u{1F43A} Transcribing segment ${current}/${total}...` }
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
            chatState.updateMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, content: "No speech detected in the recording." }
                  : m
              )
            );
            chatState.setStreaming(false);
            recorder.clearAudio();
            setAudioPrompt("");
            setShowAudioPrompt(false);
            return;
          }

          // Show transcription
          responseRef.current = "";
          contentRef.current = "";
          chatState.updateMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: `\u{1F43A} **Transcription** (${durationSec}s):\n\n${transcription}` }
                : m
            )
          );
          responseRef.current = transcription;

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
            chatState.addMessage(analysisMsg);
            responseRef.current = "";
            contentRef.current = "";

            const prompt = activeSkill?.autoPrompt || audioPrompt || "Process this transcription";
            const analysisPrompt = `${prompt}\n\nTranscription:\n${transcription}`;

            const currentMessages = chatState.getState().messages;
            const apiMessages: ChatMessage[] = currentMessages.map(m => ({
              role: m.role,
              content: m.content
            }));
            apiMessages.push({ role: "user", content: analysisPrompt });

            await runChat(app, settings, {
              messages: apiMessages,
              systemPrompt: effectiveSystemPrompt,
              allowWrite: effectiveWrite,
              attachmentManager,
              useTools: chatState.getState().chatMode === "agent",
              onEvent: (event) => {
                if (abortRef.current) return;
                switch (event.type) {
                  case "content":
                    contentRef.current += event.text;
                    appendAssistantChunk(analysisId, event.text);
                    break;
                  case "tool_start":
                    appendAssistantChunk(analysisId, `\n*Using ${event.toolName}...*\n`);
                    break;
                  case "tool_end":
                    break;
                  case "done":
                    void (async () => {
                      chatState.setStreaming(false);
                      recorder.clearAudio();
                      setAudioPrompt("");
                      setShowAudioPrompt(false);
                      await runPostActions();
                    })();
                    break;
                  case "error":
                    onError(event.message);
                    break;
                }
              },
            });
          } else {
            // Transcription only — run postActions with raw transcription
            await runPostActions();
            chatState.setStreaming(false);
            recorder.clearAudio();
            setAudioPrompt("");
            setShowAudioPrompt(false);
          }
          return; // Daemon handled it — skip API fallback
        } catch (err: unknown) {
          // Daemon not available — fall through to API transcription
          const errMessage = err instanceof Error ? err.message : String(err);
          console.warn(`[OpenBrain] Daemon STT failed (${errMessage}), trying API fallback`);
        }
      }

      if (hasAudioInput && settings.apiKey && audioSegments.length > 1) {
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
              appendAssistantChunk(assistantId, current === 1 ? `\u{1F411} Transcribing segment ${current}/${total}...\n` : "");
              chatState.updateMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, content: `\u{1F411} Transcribing segment ${current}/${total}...` }
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
        onError("Voice transcription requires an API key from your configured provider, or the STT daemon (Apple Silicon Mac).");
        chatState.setStreaming(false);
        return;
      } else {
        // --- Text message path (both Chat and Vault modes) ---
        const currentState = chatState.getState();
        let recentContext = "";
        if (currentState.chatMode === "agent" && !currentState.chatFilePath && currentState.messages.length === 2) {
          // messages.length === 2 because we just added user+assistant msgs above
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

        // Build messages for the API — read fresh from chatState
        const currentMessages = chatState.getState().messages;
        const apiMessages: ChatMessage[] = currentMessages.map(m => ({
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
          useTools: chatState.getState().chatMode === "agent",
          onEvent: (event) => {
            if (abortRef.current) return;
            switch (event.type) {
              case "content":
                contentRef.current += event.text;
                appendAssistantChunk(assistantId, event.text);
                break;
              case "tool_start":
                appendAssistantChunk(assistantId, `\n*Using ${event.toolName}...*\n`);
                break;
              case "tool_end":
                break;
              case "done":
                void (async () => {
                  chatState.setStreaming(false);
                  recorder.clearAudio();
                  setAudioPrompt("");
                  setShowAudioPrompt(false);
                  await runPostActions();
                })();
                break;
              case "error":
                onError(event.message);
                break;
            }
          },
        });
        if (pendingAttachments.length > 0) setPendingAttachments([]);
      }
    },
    [chatState, settings, noteContext, audioPrompt, appendAssistantChunk, recorder, effectiveWrite, effectiveSystemPrompt, runPostActions, pendingAttachments, attachedFiles, activeSkill, app, attachmentManager, availableSkills, applyFinishingSkill]
  );

  const handleSend = useCallback(() => {
    void sendMessage(input);
  }, [input, sendMessage]);

  // Handle skill activation from InputArea slash command
  const handleSkillActivate = async (skill: Skill) => {
    chatState.setActiveSkillId(skill.id);

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
    if (pendingFinishingSkillRef.current) {
      const skill = pendingFinishingSkillRef.current;
      pendingFinishingSkillRef.current = null;
      setShowPersonPicker(false);
      void applyFinishingSkill(skill, person.name);
      return;
    }

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
    const currentState = chatState.getState();
    // Generate TLDR and save before clearing
    if (currentState.messages.length > 0 && currentState.chatFilePath) {
      const meta = buildMeta();

      // Try to generate a summary for better title
      if (currentState.messages.length >= 2) {
        const tldr = await summarizeChat(settings, currentState.messages);
        if (tldr) meta.title = tldr;
      }

      await saveChat(app, currentState.chatFilePath, currentState.messages, meta);

      // Update daily note link with the better title
      const currentSkillId = currentState.activeSkillId;
      const skill = currentSkillId ? skills.find((s) => s.id === currentSkillId) : null;
      const section = skill?.dailyNoteSection || "Capture";
      void linkInDailyNote(app, currentState.chatFilePath, section, meta.title, settings).catch(() => { /* expected — best-effort daily note update */ });

      // Extract action items and add to daily note
      extractActionItems(currentState.messages, settings);
    }
    chatState.setMessages([]);
    chatState.setChatFilePath(null);
    setSessionId(undefined);
    abortRef.current = true;
    chatState.setStreaming(false);
    setSelectedPerson(null);
    setShowPersonPicker(false);
    onChatPathChange?.(null);
  };

  const selectSkill = async (skillId: string | null) => {
    // Save current chat before switching skills
    const currentState = chatState.getState();
    if (currentState.messages.length > 0 && currentState.chatFilePath) {
      if (debouncedSaveRef.current) {
        clearTimeout(debouncedSaveRef.current);
        debouncedSaveRef.current = null;
      }
      await saveChat(app, currentState.chatFilePath, currentState.messages, buildMeta());
    }
    chatState.setActiveSkillId(skillId);
    setShowSkillMenu(false);
    setSessionId(undefined);
    chatState.setMessages([]);
    chatState.setChatFilePath(null);
    onChatPathChange?.(null);
  };

  const isRecording = recorder.state === "recording";
  const hasAudio = recorder.audioSegments.length > 0 && recorder.state === "idle";
  const headerSkills = availableSkills.filter(s => !s.finishing);

  return (
    <div className={`claude-agent-panel${isRecording ? " is-recording" : ""}${Platform.isMobile && isRecording ? " is-mobile-recording" : ""}${isStreaming ? " is-streaming" : ""}${showTaskTray ? " tray-open" : ""}`}>
      {/* Header */}
      <ChatHeader
        activeSkill={activeSkill}
        activeSkillId={activeSkillId}
        skills={headerSkills}
        showSkillMenu={showSkillMenu}
        effectiveWrite={effectiveWrite}
        effectiveCli={effectiveCli}
        showCliToggle={Platform.isDesktop}
        noteContext={noteContext}
        sessionId={sessionId}
        showTooltips={settings.showTooltips}
        chatMode={chatMode}
        onboardingComplete={onboardingDone}
        taskTrayOpen={showTaskTray}
        onChatModeToggle={() => chatState.setChatMode(chatState.getState().chatMode === "agent" ? "chat" : "agent")}
        onSkillMenuToggle={() => setShowSkillMenu((v) => !v)}
        onSkillSelect={(id) => void selectSkill(id)}
        onToggleWrite={() => chatState.setAllowWrite(!chatState.getState().allowWrite)}
        onToggleCli={() => chatState.setAllowCli(!chatState.getState().allowCli)}
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
          onCancel={() => { setShowPersonPicker(false); chatState.setActiveSkillId(null); }}
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
                  onClick={() => setOnboardingStep(4)}
                >
                  Next →
                </button>
              </>
            )}
            {onboardingStep === 4 && (
              <>
                <div className="ca-welcome-title">Your Work Schedule</div>
                <div className="ca-welcome-tips">
                  <div className="ca-welcome-tip">
                    OpenBrain adjusts its tone and suggestions based on your schedule.
                    Select your work days below.
                  </div>
                </div>
                <div className="ca-day-toggles" style={{ justifyContent: "center", margin: "16px 0" }}>
                  {["S", "M", "T", "W", "T", "F", "S"].map((label, i) => (
                    <button
                      key={i}
                      className={`ca-day-toggle ${settings.workDays.includes(i) ? "active" : ""}`}
                      onClick={() => {
                        const days = [...settings.workDays];
                        const idx = days.indexOf(i);
                        if (idx >= 0) days.splice(idx, 1);
                        else { days.push(i); days.sort(); }
                        settings.workDays = days;
                        const pluginRef = (app as any).plugins?.plugins?.["open-brain"];
                        if (pluginRef) {
                          pluginRef.settings.workDays = days;
                          void pluginRef.saveSettings();
                        }
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <button
                  className="ca-welcome-btn"
                  onClick={() => {
                    setOnboardingDone(true);
                    settings.onboardingComplete = true;
                    const pluginRef = (app as any).plugins?.plugins?.["open-brain"];
                    if (pluginRef) {
                      pluginRef.settings.onboardingComplete = true;
                      void pluginRef.saveSettings();
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
        isMobile={Platform.isMobile}
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
        onFinishingSkill={(skill, args) => void applyFinishingSkill(skill, args)}
        showTooltips={settings.showTooltips}
        placeholder={isRecording ? "Recording..." : activeSkill?.autoPrompt ? "Press enter to run..." : "Ask anything... (@ to reference a file)"}
        onMicClick={() => void handleMicClick()}
        micState={recorder.state === "processing" ? "processing" : isRecording ? "recording" : "idle"}
        isSendDisabled={isStreaming || isRecording || !input.trim()}
        onImageDrop={async (file) => {
          const chatId = chatState.getState().chatFilePath?.split("/").pop()?.replace(".md", "") || generateId();
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
