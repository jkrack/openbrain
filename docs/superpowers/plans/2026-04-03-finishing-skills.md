# Finishing Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "finishing skills" — slash commands (`/meeting`, `/1on1 Amy`) that package a full conversation into a clean, properly-filed note that opens in the editor.

**Architecture:** Extend the existing skill system with a `finishing: true` flag and `slash_command` field. Finishing skills are triggered after a conversation via slash command, receive the full chat history, produce a structured note via LLM, and execute post-actions (create note, open it, link in daily note, backlink chat).

**Tech Stack:** TypeScript, React, Obsidian API (`app.workspace.getLeaf`, `app.vault`)

**Spec:** `docs/superpowers/specs/2026-04-03-finishing-skills-design.md`

---

## File Structure

### Modified Files

| File | Responsibility |
|------|---------------|
| `src/skills.ts:5-27` | Add `finishing`, `slash_command` to `Skill` interface; add `open_note`, `backlink_chat` post-action types; add `one_on_one_folder` template var |
| `src/chatHistory.ts:11-22,83-111,115-183` | Add `meeting_note?` to `ChatMeta`; update `serializeChat()` and `parseChat()` |
| `src/components/InputArea.tsx:6-25,106-119,147-161` | Add `onFinishingSkill` callback; split slash dropdown behavior by `finishing` flag |
| `src/panel.tsx:494-517,519-796,803-814` | Add `applyFinishingSkill()` function; handle `/` prefix in `sendMessage()`; add finishing skill callback |

### Modified Skill Files

| File | Change |
|------|--------|
| `OpenBrain/skills/meeting-agent.md` | Add `finishing: true`, `slash_command: meeting`, update post-actions, rewrite system prompt |
| `OpenBrain/skills/one-on-one.md` | Add `finishing: true`, `slash_command: 1on1`, update post-actions, rewrite system prompt |

---

## Task 1: Extend Skill and PostAction Types

**Files:**
- Modify: `src/skills.ts:5-10,12-27`

- [ ] **Step 1: Add `finishing` and `slash_command` to Skill interface**

In `src/skills.ts`, add two fields to the `Skill` interface (before the closing `}` on line 27):

```typescript
  finishing?: boolean;
  slashCommand?: string;
```

- [ ] **Step 2: Add new post-action types to PostAction interface**

In `src/skills.ts`, change the `type` union at line 6 from:

```typescript
  type: "create_note" | "append_to_daily" | "replace_in_daily";
```

to:

```typescript
  type: "create_note" | "append_to_daily" | "replace_in_daily" | "open_note" | "backlink_chat";
```

- [ ] **Step 3: Update parseSkillFile() to read new fields**

In `parseSkillFile()` (around line 69-84 where the `Skill` object is constructed), add:

```typescript
    finishing: fm.finishing === true || fm.finishing === "true",
    slashCommand: typeof fm.slash_command === "string" ? fm.slash_command : undefined,
```

- [ ] **Step 4: Build to verify**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/skills.ts
git commit -m "feat(skills): add finishing skill and new post-action types to Skill interface"
```

---

## Task 2: Add `one_on_one_folder` Template Variable and `open_note` Post-Action

**Files:**
- Modify: `src/skills.ts:208-292`

- [ ] **Step 1: Add `one_on_one_folder` to vars dict**

In `executePostActions()` at lines 218-227, add to the `vars` object:

```typescript
  one_on_one_folder: settings?.oneOnOneFolder || "OpenBrain/meetings/1-on-1",
```

- [ ] **Step 2: Implement `open_note` post-action handler**

The function needs the `App` reference (already a parameter). The existing code uses standalone `if` blocks (not `else if` chains) for each action type. Add a new standalone `if` block after the existing handlers (around line 284), inside the `for` loop's `try` block:

```typescript
      if (action.type === "open_note") {
        if (vars.note_path) {
          try {
            const file = app.vault.getAbstractFileByPath(vars.note_path);
            if (file && file instanceof TFile) {
              const leaf = app.workspace.getLeaf("tab");
              await leaf.openFile(file);
              results.push({ success: true, message: `Opened ${vars.note_path}` });
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ success: false, message: `Failed to open note: ${msg}` });
          }
        }
      }
```

Add `import { TFile } from "obsidian";` at the top if not already imported.

- [ ] **Step 3: Build to verify**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/skills.ts
git commit -m "feat(skills): add open_note post-action and one_on_one_folder template var"
```

---

## Task 3: Add `backlink_chat` Post-Action and ChatMeta Changes

**Files:**
- Modify: `src/chatHistory.ts:11-22,83-111,115-183`
- Modify: `src/skills.ts:208-292`

- [ ] **Step 1: Add `meeting_note` to ChatMeta**

In `src/chatHistory.ts`, add to the `ChatMeta` interface (after line 21, before `}`):

```typescript
  meetingNote?: string;
```

- [ ] **Step 2: Update `serializeChat()` to write `meeting_note` field**

In `serializeChat()` at lines 85-98, add a line before the closing `"---"`:

```typescript
  ...(meta.meetingNote ? [`meeting_note: "${meta.meetingNote.replace(/"/g, '\\"')}"`] : []),
```

- [ ] **Step 3: Update `parseChat()` to read `meeting_note` field**

In `parseChat()` in the frontmatter parsing section (around line 139), add:

```typescript
  const meetingNote = frontmatter.match(/^meeting_note:\s*"?(.+?)"?\s*$/m)?.[1] || undefined;
```

And include it in the returned `ChatMeta` object:

```typescript
  meetingNote: meetingNote || undefined,
```

- [ ] **Step 4: Implement `backlink_chat` handler in executePostActions()**

In `src/skills.ts`, in `executePostActions()`, add another case after `open_note`:

Add another standalone `if` block (not `else if`):

```typescript
      if (action.type === "backlink_chat") {
        // backlink_chat is handled by the caller (panel.tsx) since it needs
        // access to the current chat's state and save function.
        if (vars.note_path) {
          results.push({ success: true, message: `backlink:${vars.note_path}` });
        } else {
          results.push({ success: false, message: "backlink_chat: no note created yet (run create_note first)" });
        }
      }
```

The actual backlink write happens in `panel.tsx` after `executePostActions()` returns — it reads the backlink result, updates `ChatMeta.meetingNote`, and calls `saveChat()`.

- [ ] **Step 5: Build to verify**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/chatHistory.ts src/skills.ts
git commit -m "feat(skills): add backlink_chat post-action and meetingNote to ChatMeta"
```

---

## Task 4: Extend InputArea for Finishing Skills

**Files:**
- Modify: `src/components/InputArea.tsx:6-25,106-119,147-161,282-297`

- [ ] **Step 1: Add `onFinishingSkill` callback to props**

In `InputAreaProps` (line 6-25), add:

```typescript
  onFinishingSkill: (skill: Skill, args?: string) => void;
```

- [ ] **Step 2: Split slash dropdown behavior by skill type**

In `insertSlashCommand()` (lines 147-161), replace the `onSkillActivate(skill)` call with:

```typescript
    if (skill.finishing) {
      // Capture any remaining text after /query as args (e.g., "/1on1 Amy" → args = "Amy")
      const remaining = (replaced + textAfter).trim();
      onFinishingSkill(skill, remaining || undefined);
    } else {
      onSkillActivate(skill);
    }
```

- [ ] **Step 3: Add visual indicator for finishing skills in dropdown**

In the dropdown rendering (lines 282-297), find line 293 which contains `{skill.name}` inside the `<button>`. Replace that single line with:

```tsx
        {skill.name}
        {skill.finishing && <span className="ca-skill-badge">finish</span>}
```

- [ ] **Step 4: Update component to receive the new prop**

In the component's destructured props, add `onFinishingSkill`. Make sure it's in the component signature.

- [ ] **Step 5: Build to verify**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: Errors in `panel.tsx` because we haven't passed the new prop yet (that's Task 6)

- [ ] **Step 6: Commit**

```bash
git add src/components/InputArea.tsx
git commit -m "feat(input): extend slash commands to support finishing skills"
```

---

## Task 5: Rewrite Meeting and 1:1 Skill Files

**Files:**
- Modify: skill files in the Obsidian vault at `/Users/jlane/GitHub/Obsidian/OpenBrain/skills/`

- [ ] **Step 1: Rewrite meeting-agent.md as a finishing skill**

Read the current file first, then replace with:

```yaml
---
name: Meeting Notes
description: Package a conversation into structured meeting notes
finishing: true
slash_command: meeting
input: auto
audio_mode: transcribe_and_analyze
daily_note_section: Meetings
tools:
  write: true
post_actions:
  - create_note:
      path: "{{meetings_folder}}/{{date}} {{title}}.md"
  - open_note
  - append_to_daily:
      section: "## Meetings"
      content: "- [[{{note_path}}|{{title}}]]"
  - backlink_chat
---

You are a meeting notes assistant. You will receive a full conversation that includes voice transcriptions and discussion about a meeting.

Your job is to produce a clean, structured meeting note. Output EXACTLY this format:

# [Meeting Title — be specific and descriptive]

## Summary
- [3-8 bullet points capturing the key discussion points]
- [Focus on decisions made, information shared, and concerns raised]

## Action Items
- [ ] [Specific action] — [owner if mentioned]
- [ ] [Specific action] — [owner if mentioned]

---

## Transcript

> [Include the full raw transcription text here, as a blockquote]
> [Preserve the original wording exactly — do not edit or summarize the transcript]

Rules:
- The title should describe the meeting topic, not "Meeting Notes" or a date
- Extract ALL action items, even implied ones ("I'll follow up with...")
- Include people's names when mentioned
- The transcript section must contain the complete original transcription, unedited
- Do not add sections beyond Summary, Action Items, and Transcript
```

- [ ] **Step 2: Rewrite one-on-one.md as a finishing skill**

Read the current file first, then replace with:

```yaml
---
name: "1:1"
description: Package a conversation into 1:1 meeting notes
finishing: true
slash_command: 1on1
input: auto
audio_mode: transcribe_and_analyze
requires_person: true
daily_note_section: Meetings
tools:
  write: true
post_actions:
  - create_note:
      path: "{{one_on_one_folder}}/{{person}}/{{date}} {{title}}.md"
  - open_note
  - append_to_daily:
      section: "## Meetings"
      content: "- [[{{note_path}}|1:1 {{person}} — {{title}}]]"
  - backlink_chat
---

You are a 1:1 meeting notes assistant. You will receive a full conversation that includes voice transcriptions and discussion from a one-on-one meeting.

Your job is to produce clean, structured 1:1 notes. Output EXACTLY this format:

# 1:1 with {{person}} — [Topic]

## Summary
- [3-8 bullet points capturing what was discussed]
- [Focus on decisions, feedback, blockers, and commitments]

## Action Items
- [ ] [Specific action] — [owner]
- [ ] [Specific action] — [owner]

## Follow-ups
- [Topics to revisit next time]

---

## Transcript

> [Include the full raw transcription text here, as a blockquote]

Rules:
- The title should describe the discussion topic, not just "1:1"
- Capture personal context and relationship nuance where relevant
- Note any commitments either party made
- The transcript must be the complete original transcription, unedited
```

- [ ] **Step 3: Commit**

```bash
git add -A /Users/jlane/GitHub/Obsidian/OpenBrain/skills/meeting-agent.md /Users/jlane/GitHub/Obsidian/OpenBrain/skills/one-on-one.md
git commit -m "feat(skills): rewrite meeting and 1:1 as finishing skills with slash commands"
```

Note: These skill files are in the Obsidian vault, not the plugin repo. If git doesn't track them, skip the commit — the files are user-facing configuration.

---

## Task 6: Implement `applyFinishingSkill()` in panel.tsx

**Files:**
- Modify: `src/panel.tsx`

This is the core task — wiring everything together.

- [ ] **Step 1: Add `applyFinishingSkill` function**

Add a new function in `panel.tsx` (near `runPostActions` around line 517):

```typescript
  const applyFinishingSkill = useCallback(async (skill: Skill, personArg?: string) => {
    if (chatState.getState().isStreaming) return;

    // Resolve person if needed
    let person: PersonProfile | null = null;
    if (skill.requiresPerson) {
      if (personArg) {
        const loaded = await loadPeople(app, settings.peopleFolder);
        person = loaded.find(p =>
          p.name.toLowerCase().includes(personArg.toLowerCase())
        ) || null;
        if (!person) {
          // Show person picker if no match
          setPeople(loaded);
          setShowPersonPicker(true);
          // Store the pending finishing skill to resume after person selection
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

    // Gather full conversation history
    const allMessages = chatState.getState().messages;
    if (allMessages.length === 0) {
      new Notice("Record or type a conversation first, then use the slash command to package it.");
      return;
    }

    // Activate skill temporarily for post-actions
    chatState.setActiveSkillId(skill.id);
    chatState.setStreaming(true);
    postActionsRanRef.current = false;

    // Build the conversation context
    const conversationText = allMessages
      .map(m => `### ${m.role === "user" ? "User" : "Assistant"}\n${m.content}`)
      .join("\n\n");

    const systemPrompt = skill.systemPrompt + (person
      ? `\n\nThis is a 1:1 with {{person}}. Person context:\n${person.context || person.name}`
      : "");

    // Include chat file path so the LLM can add it to the meeting note's frontmatter
    const chatFilePath = chatState.getState().chatFilePath || "";
    const chatLink = chatFilePath ? `\n\nInclude this in the note's YAML frontmatter as \`chat: "[[${chatFilePath.replace(/\.md$/, "")}]]"\`` : "";

    const userPrompt = `Here is the full conversation to package:\n\n${conversationText}${chatLink}`;

    // Create assistant message for streaming response
    const assistantId = generateId();
    const assistantMsg: Message = {
      id: assistantId,
      role: "assistant",
      content: "",
      timestamp: new Date(),
    };
    chatState.addMessage(assistantMsg);
    responseRef.current = "";

    // Build vars for person substitution in prompts
    const personName = person?.name || "";
    const finalSystemPrompt = systemPrompt.replace(/\{\{person\}\}/g, personName);

    const apiMessages: ChatMessage[] = [
      { role: "user", content: userPrompt },
    ];

    await runChat(app, settings, {
      messages: apiMessages,
      systemPrompt: finalSystemPrompt,
      allowWrite: skill.tools?.write || false,
      attachmentManager,
      useTools: false,
      onText: (text) => {
        if (!abortRef.current) appendAssistantChunk(assistantId, text);
      },
      onToolStart: () => {},
      onToolEnd: () => {},
      onDone: () => { void (async () => {
        chatState.setStreaming(false);

        // Execute post-actions (create note, open, daily link)
        const response = responseRef.current;
        if (skill.postActions.length > 0 && response.trim()) {
          // Add person to vars for template substitution
          const extraVars: Record<string, string> = {};
          if (personName) extraVars.person = personName;

          const results = await executePostActions(app, skill.postActions, response, settings, extraVars);

          // Handle backlink_chat result
          const backlinkResult = results.find(r => r.message.startsWith("backlink:"));
          if (backlinkResult) {
            const notePath = backlinkResult.message.replace("backlink:", "");
            // Update chat file's meetingNote field
            const chatMeta = chatState.getState().meta;
            if (chatMeta) {
              chatMeta.meetingNote = notePath;
              // Force save with updated meta
              const chatPath = chatState.getState().chatFilePath;
              if (chatPath) {
                const msgs = chatState.getState().messages;
                await saveChat(app, chatPath, msgs, chatMeta);
              }
            }
          }

          // Show feedback
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
      })(); },
      onError: (err) => {
        chatState.setStreaming(false);
        chatState.updateMessages(prev =>
          prev.map(m => m.id === assistantId ? { ...m, content: `Error: ${err}` } : m)
        );
      },
    });
  }, [app, settings, chatState, attachmentManager]);
```

- [ ] **Step 2: Add ref for pending finishing skill**

Near the top of the component (with other refs):

```typescript
  const pendingFinishingSkillRef = useRef<Skill | null>(null);
```

- [ ] **Step 3: Handle person selection completing a pending finishing skill**

Find the `selectPerson()` function (around line 817 in panel.tsx). At the top of this function, before any existing logic, add a check for pending finishing skills:

```typescript
  // In selectPerson() — at the top, before existing logic:
  if (pendingFinishingSkillRef.current) {
    const skill = pendingFinishingSkillRef.current;
    pendingFinishingSkillRef.current = null;
    setShowPersonPicker(false);
    void applyFinishingSkill(skill, selectedPerson.name);
    return;
  }
```

- [ ] **Step 4: Add slash command interception in sendMessage()**

At the very top of `sendMessage()` (line 521, before the streaming guard), add:

```typescript
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
```

- [ ] **Step 5: Hide finishing skills from the header skill dropdown**

Find where `availableSkills` is passed to `ChatHeader` (search for `<ChatHeader`). The header's skill menu should only show standalone skills. Create a filtered list:

```typescript
  const headerSkills = availableSkills.filter(s => !s.finishing);
```

Pass `headerSkills` to `ChatHeader`'s `skills` prop instead of `availableSkills`. The `InputArea` slash dropdown continues to receive all `availableSkills` (including finishing skills).

- [ ] **Step 6: Pass `onFinishingSkill` to InputArea**

Find where `<InputArea` is rendered (search for `<InputArea`). Add the prop:

```tsx
  onFinishingSkill={(skill, args) => void applyFinishingSkill(skill, args)}
```

- [ ] **Step 7: Update executePostActions signature for extra vars**

In `src/skills.ts`, update `executePostActions` to accept optional extra vars:

```typescript
export async function executePostActions(
  app: App,
  actions: PostAction[],
  response: string,
  settings?: OpenBrainSettings,
  extraVars?: Record<string, string>
): Promise<PostActionResult[]> {
```

And merge them into the vars dict:

```typescript
  const vars: Record<string, string> = {
    date,
    title,
    response,
    note_path: "",
    meetings_folder: settings?.meetingsFolder || "OpenBrain/meetings",
    reviews_folder: settings?.reviewsFolder || "OpenBrain/reviews",
    projects_folder: settings?.projectsFolder || "OpenBrain/projects",
    people_folder: settings?.peopleFolder || "OpenBrain/people",
    one_on_one_folder: settings?.oneOnOneFolder || "OpenBrain/meetings/1-on-1",
    ...extraVars,
  };
```

- [ ] **Step 8: Build to verify**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 9: Run full test suite**

Run: `npm run test`
Expected: All tests pass

- [ ] **Step 10: Commit**

```bash
git add src/panel.tsx src/skills.ts
git commit -m "feat(skills): implement applyFinishingSkill with slash command routing"
```

---

## Task 7: Build and Smoke Test

**Files:** None (verification only)

- [ ] **Step 1: Production build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 2: Run full test suite**

Run: `npm run test`
Expected: All tests pass

- [ ] **Step 3: Manual smoke test**

1. Reload Obsidian (Cmd+R)
2. Open OpenBrain panel
3. Record a short audio clip, let it transcribe
4. Type some follow-up messages
5. Type `/meeting` in the input
6. Verify: slash dropdown shows "Meeting Notes" with "finish" badge
7. Select it (or press Enter)
8. Verify: LLM processes the conversation, produces structured note
9. Verify: meeting note opens in a new tab
10. Verify: daily note has link under ## Meetings
11. Verify: chat file frontmatter has `meeting_note:` field

- [ ] **Step 4: Test edge cases**

1. Type `/meeting` with no prior messages → expect notice
2. Type `/1on1` with no name → expect person picker
3. Type `/1on1 Amy` → expect fuzzy match or person picker
4. Type `/nonexistent` → expect normal message sent (not intercepted)
