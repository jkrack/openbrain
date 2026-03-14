---
name: Quick Thought
description: Capture raw voice transcription directly to daily note
input: audio
audio_mode: transcribe_only
tools:
  write: true
post_actions:
  - append_to_daily:
      section: "## Quick Thoughts"
      content: "- {{response}} *({{date}})*"
---

Quick voice capture — transcribes and appends directly to your daily note without AI processing.
