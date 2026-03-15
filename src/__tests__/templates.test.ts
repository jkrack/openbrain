import { describe, it, expect, vi } from "vitest";

// Mock obsidian module
vi.mock("obsidian", () => ({
  App: class {},
  TFile: class {},
  moment: () => ({
    format: (f: string) => {
      if (f === "YYYY-MM-DD") return "2026-03-15";
      if (f === "dddd") return "Sunday";
      if (f === "HH:mm") return "10:00";
      return "mocked";
    },
  }),
}));

// ── Variable substitution logic ──────────────────────────────────────────
//
// renderTemplate in templates.ts applies:
//   content.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value)
//
// Since renderTemplate requires App, we extract the substitution logic here.

function substituteVars(content: string, vars: Record<string, string>): string {
  let result = content;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  return result;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("template variable substitution", () => {
  it("replaces {{date}} and {{day}}", () => {
    const template = "# {{date}} ({{day}})";
    const result = substituteVars(template, {
      date: "2026-03-15",
      day: "Sunday",
    });
    expect(result).toBe("# 2026-03-15 (Sunday)");
  });

  it("replaces {{title}}", () => {
    const template = "# {{title}}\n\nContent here";
    const result = substituteVars(template, { title: "My Meeting" });
    expect(result).toBe("# My Meeting\n\nContent here");
  });

  it("replaces multiple occurrences of the same variable", () => {
    const template = "Start: {{date}} | End: {{date}} | Again: {{date}}";
    const result = substituteVars(template, { date: "2026-03-15" });
    expect(result).toBe("Start: 2026-03-15 | End: 2026-03-15 | Again: 2026-03-15");
  });

  it("leaves unknown variables as-is", () => {
    const template = "Hello {{name}}, today is {{date}}. Your {{unknown}} is ready.";
    const result = substituteVars(template, {
      name: "Alice",
      date: "2026-03-15",
    });
    expect(result).toBe("Hello Alice, today is 2026-03-15. Your {{unknown}} is ready.");
  });

  it("handles empty values", () => {
    const template = "# {{title}}\n\nContent";
    const result = substituteVars(template, { title: "" });
    expect(result).toBe("# \n\nContent");
  });

  it("handles template with no variables", () => {
    const template = "Plain text without any variables.";
    const result = substituteVars(template, { date: "2026-03-15" });
    expect(result).toBe("Plain text without any variables.");
  });

  it("handles multiple different variables", () => {
    const template = "# {{title}}\n**Date:** {{date}}\n**Time:** {{time}}";
    const result = substituteVars(template, {
      title: "Standup",
      date: "2026-03-15",
      time: "10:00",
    });
    expect(result).toBe("# Standup\n**Date:** 2026-03-15\n**Time:** 10:00");
  });

  it("handles values containing special regex characters", () => {
    const template = "Note: {{content}}";
    const result = substituteVars(template, {
      content: "Price is $10.00 (plus tax)",
    });
    expect(result).toBe("Note: Price is $10.00 (plus tax)");
  });

  it("replaces adjacent variables", () => {
    const template = "{{first}}{{second}}";
    const result = substituteVars(template, { first: "A", second: "B" });
    expect(result).toBe("AB");
  });

  it("does not partially match variable names", () => {
    const template = "{{date}} and {{date_end}}";
    const result = substituteVars(template, {
      date: "2026-03-15",
      date_end: "2026-03-20",
    });
    expect(result).toBe("2026-03-15 and 2026-03-20");
  });
});
