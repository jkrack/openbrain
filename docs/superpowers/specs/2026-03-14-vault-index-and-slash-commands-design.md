# Vault Metadata Index & Slash Commands — Design Spec

## Problem

1. **@ mentions are slow** — currently reads full file content into the system prompt. Large files cause token overhead and latency.
2. **No quick way to switch skills** — users must click the skill selector in the header. A `/` shortcut in the input would be faster.

## Solution

### 1. Vault Metadata Index

A lightweight in-memory index built from Obsidian's `metadataCache`. Powers fast `@` file search without reading file contents.

#### `src/vaultIndex.ts`

```typescript
interface IndexEntry {
  path: string;       // Full vault path: "Daily/2026-03-10.md"
  basename: string;   // Filename without extension: "2026-03-10"
  aliases: string[];  // From frontmatter aliases field
}

class VaultIndex {
  private entries: Map<string, IndexEntry>;

  constructor(app: App) // Build index from metadataCache
  update(path: string)  // Re-index a single file
  remove(path: string)  // Remove from index
  rename(oldPath: string, newPath: string) // Handle renames
  search(query: string, limit?: number): IndexEntry[] // Fuzzy search
}
```

**Index building:** On construction, iterate `app.vault.getMarkdownFiles()` and read aliases from `app.metadataCache.getFileCache(file)?.frontmatter?.aliases`.

**Reactive updates:** Plugin registers vault events (`create`, `modify`, `delete`, `rename`) that call `update()`, `remove()`, `rename()` on the index.

**Search scoring** (descending priority):
1. Basename starts with query
2. Basename contains query
3. Alias matches query
4. Path contains query

Returns top 8 results. Case-insensitive matching.

#### Panel changes for @ mentions

- `@` dropdown shows **basename only** (not full path)
- On select, stores just the file path (string) — no content reading
- `attachedFiles` type changes from `{ path: string; content: string }[]` to `string[]` (just paths)
- On send, appends to the **prompt** (not system prompt): `\n\nReferenced files (read these before responding):\n- path1.md\n- path2.md`
- Claude Code reads the files itself since `cwd` is the vault

### 2. Slash Commands for Skills

Type `/` in the input to trigger a skill picker dropdown, similar to `@` for files.

#### Behavior

- Typing `/` at the start of input or after a space shows the skill picker
- Continue typing to filter skills by name
- Arrow keys to navigate, Enter/Tab to select, Escape to dismiss
- Selecting a skill activates it (same as clicking in the header selector)
- The `/skillname` text is removed from input after selection
- If no skills are loaded, `/` does nothing

#### UI

- Same dropdown style as `@` mention menu (`.ca-mention-menu`)
- Shows skill name only
- Active/selected skill highlighted

## Files Changed

| File | Action | Purpose |
|------|--------|---------|
| `src/vaultIndex.ts` | **Create** | `VaultIndex` class with search |
| `src/main.ts` | **Modify** | Create index, register vault events, pass to view |
| `src/view.ts` | **Modify** | Accept and pass `vaultIndex` prop to panel |
| `src/panel.tsx` | **Modify** | Use index for `@` search, pass paths not content, add `/` skill picker |
| `styles.css` | **Modify** | Reuse `.ca-mention-menu` styles (no new CSS needed) |

## Edge Cases

- **File renamed while attached:** The path in `attachedFiles` may be stale. Claude Code will report "file not found" — acceptable, user can re-attach.
- **Empty vault:** Index is empty, `@` shows no results. Fine.
- **No skills loaded:** `/` does nothing. Fine.
- **`/` mid-sentence:** Only trigger if `/` is at position 0 or preceded by a space/newline.
- **Skill already active:** Selecting the same skill is a no-op (already handled by `selectSkill`).
