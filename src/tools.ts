import { ToolDefinition } from "./providers/types";

// Read-only tools — always available
export const READ_TOOLS: ToolDefinition[] = [
  {
    name: "vault_search",
    description: "Full-text search across the vault",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"]
    }
  },
  {
    name: "vault_search_context",
    description: "Search with surrounding context shown around matches",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"]
    }
  },
  {
    name: "vault_read",
    description: "Read a note's full content",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Vault-relative file path" } },
      required: ["path"]
    }
  },
  {
    name: "vault_list",
    description: "List files in a folder",
    input_schema: {
      type: "object",
      properties: { folder: { type: "string", description: "Folder path (empty for root)" } }
    }
  },
  {
    name: "vault_outline",
    description: "Get the heading structure of a note",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "File path" } },
      required: ["path"]
    }
  },
  {
    name: "vault_backlinks",
    description: "Find all notes that link TO this file",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "File path" } },
      required: ["path"]
    }
  },
  {
    name: "vault_links",
    description: "Get all outgoing links FROM this file",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "File path" } },
      required: ["path"]
    }
  },
  {
    name: "vault_properties",
    description: "Read frontmatter properties from a note",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "File path" } },
      required: ["path"]
    }
  },
  {
    name: "vault_tags",
    description: "List all tags in the vault with counts",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "vault_tasks",
    description: "Get tasks from a file or today's daily note",
    input_schema: {
      type: "object",
      properties: {
        file: { type: "string", description: "File path (omit for daily note)" },
        filter: { type: "string", enum: ["todo", "done"], description: "Task status" }
      }
    }
  },
  {
    name: "daily_read",
    description: "Read today's daily note content",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "vault_orphans",
    description: "Find notes with no incoming links",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "vault_deadends",
    description: "Find broken links pointing to nonexistent notes",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "vault_unresolved",
    description: "Find unresolved wikilinks",
    input_schema: { type: "object", properties: {} }
  }
];

// Write tools — only included when write permission is enabled
export const WRITE_TOOLS: ToolDefinition[] = [
  {
    name: "vault_create",
    description: "Create a new note",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative file path" },
        content: { type: "string", description: "Note content (markdown)" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "vault_edit",
    description: "Edit a note by replacing text",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        old_text: { type: "string", description: "Text to find" },
        new_text: { type: "string", description: "Replacement text" }
      },
      required: ["path", "old_text", "new_text"]
    }
  },
  {
    name: "vault_append",
    description: "Append content to a note",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        content: { type: "string", description: "Content to append" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "daily_append",
    description: "Append to a section of today's daily note",
    input_schema: {
      type: "object",
      properties: {
        section: { type: "string", description: "Section heading (e.g., Capture, Focus)" },
        content: { type: "string", description: "Content to append" }
      },
      required: ["section", "content"]
    }
  },
  {
    name: "vault_property_set",
    description: "Set a frontmatter property on a note",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        name: { type: "string", description: "Property name" },
        value: { type: "string", description: "Property value" },
        type: { type: "string", enum: ["text", "number", "date", "list"], description: "Property type" }
      },
      required: ["path", "name", "value"]
    }
  },
  {
    name: "vault_rename",
    description: "Rename a note (updates all links automatically)",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Current file path" },
        new_name: { type: "string", description: "New name without path" }
      },
      required: ["path", "new_name"]
    }
  },
  {
    name: "vault_move",
    description: "Move a note to a different folder",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Current file path" },
        to: { type: "string", description: "Destination folder" }
      },
      required: ["path", "to"]
    }
  },
  {
    name: "vault_delete",
    description: "Delete a note (moves to Obsidian trash)",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" }
      },
      required: ["path"]
    }
  }
];

/** Get tools for current permission state */
export function getActiveTools(allowWrite: boolean): ToolDefinition[] {
  return allowWrite ? [...READ_TOOLS, ...WRITE_TOOLS] : [...READ_TOOLS];
}
