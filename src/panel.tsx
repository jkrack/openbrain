import React, { useState, useRef, useEffect, useCallback } from "react";
import { Message, streamClaudeCode, streamClaudeAPI, transcribeAudioSegments } from "./claude";
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
} from "./chatHistory";
import { VaultIndex } from "./vaultIndex";
import { PersonProfile, loadPeople, getRecentOneOnOnes, getPersonMeetingFolder } from "./people";
import { createFromTemplate } from "./templates";

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
      title={copied ? "Copied!" : "Copy as markdown"}  // CopyButton has own props
    >
      {copied ? "✓" : "⧉"}
    </button>
  );
}

export function OpenBrainPanel({ settings, app, initialPrompt, component, skills, registerToggleRecording, onStatusChange, loadChatRequest, onChatPathChange, vaultIndex }: PanelProps) {
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
  const [chatFilePath, setChatFilePathState] = useState<string | null>(null);
  const chatFilePathRef = useRef<string | null>(null);
  const setChatFilePath = (p: string | null) => {
    chatFilePathRef.current = p;
    setChatFilePathState(p);
  };
  const [showSaveConfirm, setShowSaveConfirm] = useState(false);

  // @ mention state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionResults, setMentionResults] = useState<{ path: string; basename: string }[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);

  // / slash command state
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashResults, setSlashResults] = useState<Skill[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);

  // Person picker state (for skills with requiresPerson)
  const [showPersonPicker, setShowPersonPicker] = useState(false);
  const [people, setPeople] = useState<PersonProfile[]>([]);
  const [selectedPerson, setSelectedPerson] = useState<PersonProfile | null>(null);
  const [personNotePath, setPersonNotePath] = useState<string | null>(null);
  const debouncedSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const justLoadedRef = useRef(false);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const activeSkillIdRef = useRef(activeSkillId);
  activeSkillIdRef.current = activeSkillId;

  const vaultPath = (app.vault.adapter as any).basePath as string | undefined;

  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
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
      if (!currentPath) {
        setChatFilePath(path);
        onChatPathChange?.(path);

        // Link new chat in today's daily note
        const currentSkillId = activeSkillIdRef.current;
        const skill = currentSkillId ? skills.find((s) => s.id === currentSkillId) : null;
        const section = skill?.dailyNoteSection || "Capture";
        linkInDailyNote(app, path, section, meta.title).catch(() => {});
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
  const handleManualSave = async () => {
    if (messages.length === 0) return;
    if (debouncedSaveRef.current) {
      clearTimeout(debouncedSaveRef.current);
      debouncedSaveRef.current = null;
    }
    const meta = buildMeta();
    const folder = settings.chatFolder || "OpenBrain/chats";
    const currentPath = chatFilePathRef.current;
    const path = currentPath ?? `${folder}/${generateChatFilename()}`;
    await saveChat(app, path, messages, meta);
    if (!currentPath) {
      setChatFilePath(path);
      onChatPathChange?.(path);
    }
    setShowSaveConfirm(true);
    setTimeout(() => setShowSaveConfirm(false), 1500);
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
      } else {
        // Inject recent chat context for new conversations
        let recentContext = "";
        if (!chatFilePath && messages.length === 0) {
          recentContext = await getRecentChatContext();
        }

        const allContext = [noteContext, recentContext].filter(Boolean).join("");
        const enrichedNoteContext = allContext || undefined;

        // Append referenced file paths to the prompt
        let fullPrompt = userText;
        if (attachedFiles.length > 0) {
          fullPrompt += "\n\nReferenced files (read these before responding):\n" +
            attachedFiles.map((p) => `- ${p}`).join("\n");
          setAttachedFiles([]);
        }

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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
      handleSend();
    }
  };

  // Detect @ mentions and / commands from input
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);

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
  };

  // Insert selected file as attached reference (path only)
  const insertMention = (entry: { path: string; basename: string }) => {
    setAttachedFiles((prev) => {
      if (prev.includes(entry.path)) return prev;
      return [...prev, entry.path];
    });

    // Replace @query with @basename in input
    const pos = inputRef.current?.selectionStart ?? input.length;
    const textBefore = input.slice(0, pos);
    const textAfter = input.slice(pos);
    const replaced = textBefore.replace(/@[^\s@]*$/, `@${entry.basename} `);
    setInput(replaced + textAfter);
    setMentionQuery(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  // Remove an attached file
  const removeAttachedFile = (path: string) => {
    setAttachedFiles((prev) => prev.filter((p) => p !== path));
  };

  // Insert slash command — activate the selected skill
  const insertSlashCommand = async (skill: Skill) => {
    // Remove /query from input
    const pos = inputRef.current?.selectionStart ?? input.length;
    const textBefore = input.slice(0, pos);
    const textAfter = input.slice(pos);
    const replaced = textBefore.replace(/(?:^|\s)\/[^\s]*$/, "").trimEnd();
    setInput(replaced + (replaced ? " " : "") + textAfter);
    setSlashQuery(null);

    // Activate the skill
    setActiveSkillId(skill.id);

    // If skill requires a person, show the person picker
    if (skill.requiresPerson) {
      const loaded = await loadPeople(app);
      setPeople(loaded);
      setShowPersonPicker(true);
    } else {
      setSelectedPerson(null);
      setPersonNotePath(null);
      setTimeout(() => inputRef.current?.focus(), 0);
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
    if (created) {
      setPersonNotePath(created);
      // Link the 1:1 note in today's daily note under Meetings
      linkInDailyNote(app, created, "Meetings", `1:1 — ${person.name}`).catch(() => {});
    }

    // Build file references: person profile + recent 1:1 notes
    const filesToReference = [person.filePath];
    const recentNotes = await getRecentOneOnOnes(app, person.name);

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
    // Save before clearing if there's content
    if (messages.length > 0 && chatFilePath) {
      await saveChat(app, chatFilePath, messages, buildMeta());
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
      <div className="ca-header">
        <div className="ca-header-left">
          <span className="ca-title">OpenBrain</span>
          {noteContext && (
            <span className="ca-note-badge" title={tip("Active note loaded")}>
              note
            </span>
          )}
          {sessionId && (
            <span className="ca-note-badge" title={tip("Session active")}>
              session
            </span>
          )}
          {settings.useLocalStt && (
            <span className="ca-note-badge" title={tip("Local transcription active")}>
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
                title={tip(activeSkill?.description || "Select skill")}
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
                      title={tip(skill.description)}
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
            title={tip("Allow file read/write")}
          >
            write
          </button>
          <button
            className={`ca-tool-btn ${effectiveCli ? "active" : ""}`}
            onClick={() => setAllowCli((v) => !v)}
            title={tip("Allow shell commands")}
          >
            cli
          </button>
          <button
            className="ca-icon-btn ca-save-btn"
            onClick={handleManualSave}
            title={tip("Save chat")}
            disabled={messages.length === 0}
          >
            {showSaveConfirm ? "✓" : "💾"}
          </button>
          <button className="ca-icon-btn" onClick={clearConversation} title={tip("New chat")}>
            +
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
            title={tip("OpenBrain settings")}
          >
            ⚙
          </button>
        </div>
      </div>

      {/* Person picker overlay */}
      {showPersonPicker && (
        <div className="ca-person-picker">
          <div className="ca-person-picker-title">Who is this 1:1 with?</div>
          {people.length === 0 && (
            <div className="ca-person-picker-empty">
              No profiles found. Create profiles in OpenBrain/people/
            </div>
          )}
          {people.map((person) => (
            <button
              key={person.filePath}
              className="ca-person-option"
              onClick={() => selectPerson(person)}
            >
              <span className="ca-person-name">{person.name}</span>
              <span className="ca-person-role">{person.role} — {person.domain}</span>
            </button>
          ))}
          <button
            className="ca-person-cancel"
            onClick={() => { setShowPersonPicker(false); setActiveSkillId(null); }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Message thread */}
      <div className="ca-thread" ref={threadRef}>
        {messages.length === 0 && !showPersonPicker && (
          <div className="ca-empty">
            <div className="ca-empty-icon">◈</div>
            <div className="ca-empty-text">
              {selectedPerson
                ? `1:1 with ${selectedPerson.name}`
                : activeSkill ? activeSkill.description || activeSkill.name : "Ask anything about your vault"}
            </div>
            <div className="ca-empty-sub">
              {selectedPerson
                ? `${selectedPerson.role} — ${selectedPerson.domain}`
                : "Powered by Claude Code"}
            </div>
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
              title={tip("Add instructions")}
            >
              ✎
            </button>
            <button className="ca-icon-btn" onClick={recorder.clearAudio} title={tip("Discard")}>
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
            title={tip("Dismiss")}
          >
            ✕
          </button>
        </div>
      )}

      {/* Input row */}
      {/* Attached files from @ mentions */}
      {attachedFiles.length > 0 && (
        <div className="ca-attached-files">
          {attachedFiles.map((p) => (
            <span key={p} className="ca-attached-file">
              {p.split("/").pop()?.replace(".md", "") ?? p}
              <button className="ca-attached-remove" onClick={() => removeAttachedFile(p)}>✕</button>
            </span>
          ))}
        </div>
      )}

      {/* Input row */}
      <div className="ca-input-row">
        <div className="ca-input-wrapper">
          <textarea
            ref={inputRef}
            className="ca-input"
            placeholder={isRecording ? "Recording..." : activeSkill?.autoPrompt ? "Press enter to run..." : "Ask anything... (@ to reference a file)"}
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
                  onMouseDown={(e) => { e.preventDefault(); insertMention(entry); }}
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
                  onMouseDown={(e) => { e.preventDefault(); insertSlashCommand(skill); }}
                >
                  {skill.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          className={`ca-mic-btn ${isRecording ? "recording" : ""} ${recorder.state === "processing" ? "processing" : ""}`}
          onClick={handleMicClick}
          disabled={isStreaming || recorder.state === "processing"}
          title={tip(isRecording ? "Stop recording" : "Start recording")}
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
