# Finishing Skills — Conversation-First Note Packaging

## Problem

Recording a meeting in OpenBrain produces scattered artifacts:

1. **Chat file with robot name** — `2026-04-03-122255-bbb.md` titled "Voice chat — 2026-04-03 12:22"
2. **Empty recording stubs** — floating recorder creates orphan files with just frontmatter
3. **No real meeting note** — the meetings folder is empty; content lives in chat files
4. **Daily note links are useless** — `[[Voice chat — 2026-04-03 12:22]]` tells you nothing
5. **Nothing opens** — user has to search for the note they just created

The content quality is good (accurate transcription, useful summaries) but the packaging is terrible.

## Solution

Let users have natural conversations (record, transcribe, chat back and forth), then apply a **finishing skill** via slash command that packages the full conversation into a clean, properly-filed note that opens in the editor.

### What's a Finishing Skill?

A skill that runs **after** a conversation, not before. It receives the full chat history as context, produces a structured note, and files it in the right place. Triggered by a slash command typed into the chat input.

**Finishing skills** (new):
- `/meeting` — package conversation as meeting notes
- `/1on1 Amy` — package conversation as 1:1 notes with person context

**Standalone skills** (unchanged):
- Weekly Review, End of Day, Morning Briefing, Vault Health, etc.
- Activated upfront from the dropdown, work as they do today

## User Flow

```
1. Open panel, click mic, record meeting
2. Transcription appears: "🐺 Transcription (2.3s): ..."
3. Chat back and forth: "summarize the key points", "what did Amy say about RGB?"
4. When done, type: /meeting
5. Plugin packages everything:
   - LLM receives full conversation + meeting skill prompt
   - Produces: title, summary, action items
   - Creates note in meetings folder
   - Links in daily note under ## Meetings
   - Adds backlink to chat file
   - Opens the meeting note in Obsidian editor
6. User sees the clean meeting note, ready to use
```

## Architecture

### Slash Command Parsing

The chat input box already handles text input. Add a check: if the message starts with `/`, parse it as a command before sending.

**Parsing rules:**
- `/meeting` → finishing skill "meeting-agent", no args
- `/1on1 Amy Williams` → finishing skill "one-on-one", person arg = "Amy Williams"
- `/anything-else` → look up skill by slash command name
- If no matching skill found, send as normal message

**Implementation:** In `panel.tsx`, in the `sendMessage` function, before the normal message flow, check for `/` prefix. If matched, call `applyFinishingSkill(skillId, args)` instead.

### Finishing Skill Execution

`applyFinishingSkill(skillId: string, args?: string)` in `panel.tsx`:

1. **Load skill** from the skills registry
2. **Resolve person** (if `requires_person` and args provided): look up person by name
3. **Gather conversation history**: all messages in current chat (user + assistant), including transcriptions
4. **Build prompt**: skill's system prompt + full conversation as context + instruction to produce structured output
5. **Stream LLM response** into a new assistant message (user sees it generating)
6. **Execute post-actions** when done:
   - `create_note` — create the meeting note file
   - `open_note` — new action type, opens the created note in Obsidian
   - `append_to_daily` — link in today's daily note
   - `backlink_chat` — new action type, adds meeting note link to chat file's frontmatter

### Skill Frontmatter Changes

Add `finishing: true` flag and `slash_command` field to skill frontmatter:

```yaml
---
name: Meeting Notes
finishing: true
slash_command: meeting
audio_mode: transcribe_and_analyze
daily_note_section: Meetings
post_actions:
  - create_note:
      path: "{{meetings_folder}}/{{date}} {{title}}.md"
      template: meeting
  - open_note
  - append_to_daily:
      section: "## Meetings"
      content: "- [[{{note_path}}|{{title}}]]"
  - backlink_chat
---
```

Skills with `finishing: true`:
- Are hidden from the upfront skill dropdown (or shown separately)
- Are invoked only via slash command
- Receive the full conversation history as input
- Always produce a note as output

### Note Format

Every finishing skill produces a note with this structure:

```markdown
---
type: meeting
date: 2026-04-03
people:
  - "[[OpenBrain/people/Amy Williams]]"
topics:
  - gaming
  - digital-skus
  - sony
  - rgb
  - tv-reimagined
chat: "[[OpenBrain/chats/2026-04-03-122255-bbb]]"
---

# GTA / Sony Digital Strategy

## Summary
- Sony has no digital code delivery — unlike Xbox and Nintendo...
- Ashley pushing Sony for digital code sales capability...
- GTA physical box ships disc-less (code only), needs clear PDP messaging...
- RGB/TV Reimagined needs product representation — no one from product in meetings...

## Action Items
- [ ] Follow up with Amy re: Abby + RGB product representation
- [ ] Get more info on "Get It By" component (#212)
- [ ] Review TV Reimagined meeting invite from Christy the Long's team

---

## Transcript

> Everywhere on the site. Sony, we do not do, and Sony does not do digital skew. You can go to PlayStation and buy it, but they don't have, you know, like right now, you can go to Xbox...
```

**Key design decisions:**
- Summary and action items at top (the deliverable)
- Full transcript below a `---` divider (searchable, but not in the way)
- Frontmatter links back to chat file (`chat:` field) for audit trail
- Frontmatter includes extracted people and topics for Obsidian graph/search
- The LLM is instructed to produce this exact structure via the skill's system prompt

### Chat File Backlink

After the finishing skill creates the meeting note, the chat file's frontmatter is updated:

```yaml
# Before
title: "Voice chat — 2026-04-03 12:22"

# After
title: "Voice chat — 2026-04-03 12:22"
meeting_note: "[[OpenBrain/meetings/2026-04-03 GTA Sony Digital Strategy]]"
```

This creates a bidirectional link: meeting note → chat (via `chat:` frontmatter), chat → meeting note (via `meeting_note:` frontmatter).

### Opening the Note

After `create_note` post-action, the new `open_note` action calls:

```typescript
const leaf = app.workspace.getLeaf("tab");
await leaf.openFile(createdFile);
```

This opens the meeting note in a new tab, bringing it into focus immediately.

### New Post-Action Types

Two new post-action types added to `executePostActions()`:

**`open_note`** — opens the most recently created note in the Obsidian editor
- No parameters needed (uses `note_path` from prior `create_note` action)
- Opens in a new tab

**`backlink_chat`** — adds a frontmatter link from the chat file to the created note
- No parameters needed (uses `note_path` from prior `create_note` action)
- Updates the chat file's YAML frontmatter with `meeting_note:` field

## Files Changed

### New/Modified Skill Files

| File | Change |
|------|--------|
| `OpenBrain/skills/meeting-agent.md` | Rewrite as finishing skill: add `finishing: true`, `slash_command: meeting`, update system prompt to expect full conversation and produce structured note format |
| `OpenBrain/skills/one-on-one.md` | Rewrite as finishing skill: add `finishing: true`, `slash_command: 1on1`, update system prompt similarly |

### Plugin Source Changes

| File | Change |
|------|--------|
| `src/panel.tsx` | Add slash command parsing in `sendMessage()`, add `applyFinishingSkill()` function |
| `src/skills.ts` | Add `finishing` and `slash_command` fields to `SkillConfig` type, add `open_note` and `backlink_chat` post-action handlers in `executePostActions()` |
| `src/chatHistory.ts` | Add `updateChatFrontmatter()` function to modify chat file's YAML (for backlink) |

### Unchanged

- Recording flow (mic button, transcription, daemon)
- Standalone skills (weekly review, end of day, etc.)
- Chat auto-save behavior
- Floating recorder
- Daily note template/structure

## 1:1 Finishing Skill

The 1:1 skill works the same as meeting notes but with person context:

**Command:** `/1on1 Amy Williams` or `/1on1 Amy`

**Additional behavior:**
- Fuzzy-match person name against `OpenBrain/people/` folder
- Load person's profile note as additional context for the LLM
- Note saved to: `{{oneOnOneFolder}}/Amy Williams/{{date}} {{title}}.md`
- Person's profile note could be updated with "last met" date (future enhancement)

**Note format:** Same as meeting notes but with person-specific frontmatter:

```yaml
---
type: one-on-one
date: 2026-04-03
person: "[[OpenBrain/people/Amy Williams]]"
topics: [rgb, tv-reimagined, roadmap]
chat: "[[OpenBrain/chats/2026-04-03-122255-bbb]]"
---
```

## Edge Cases

**No conversation yet:** If user types `/meeting` with no prior messages, show a notice: "Record or type a conversation first, then use /meeting to package it."

**Multiple slash commands:** If user types `/meeting` twice on the same chat, the second run creates a new note (or updates the existing one if the path matches). The chat file's backlink is updated to the latest.

**Slash command with active standalone skill:** If user has a standalone skill active and types `/meeting`, the finishing skill takes over. The standalone skill is deactivated.

**Person not found for /1on1:** If the person name doesn't match any profile in `OpenBrain/people/`, show person picker UI (existing `PersonPicker` component) so user can select or create.

## What This Does NOT Include

- No changes to the floating recorder (can adopt finishing skills later)
- No automatic skill detection ("this looks like a meeting" → auto-apply)
- No slash commands for standalone skills (they keep the dropdown)
- No transcript editing before packaging
- No audio playback integration (word timestamps stored but not used)
- No cleanup of old recording stubs (separate housekeeping task)
