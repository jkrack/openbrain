import { ItemView, WorkspaceLeaf, TFile } from "obsidian";

export const TASK_DASHBOARD_VIEW = "open-brain-tasks";

interface DashboardTask {
  text: string;
  file: string;
  line: number;
  done: boolean;
}

export class TaskDashboardView extends ItemView {
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType() { return TASK_DASHBOARD_VIEW; }
  getDisplayText() { return "Tasks"; }
  getIcon() { return "openbrain-tasks"; }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("ca-task-dashboard");
    await this.renderDashboard(container as HTMLElement);
  }

  /** Render inline markdown — handles **bold** via DOM nodes (safe, no innerHTML) */
  private renderTaskText(text: string, el: HTMLElement) {
    const parts = text.split(/(\*\*.*?\*\*)/g);
    for (const part of parts) {
      if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
        el.createEl("strong", { text: part.slice(2, -2) });
      } else if (part) {
        el.appendText(part);
      }
    }
  }

  async renderDashboard(el: HTMLElement) {
    // Scan all markdown files for tasks
    const tasks: DashboardTask[] = [];
    const files = this.app.vault.getMarkdownFiles();

    for (const file of files) {
      const content = await this.app.vault.cachedRead(file);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const todoMatch = line.match(/^[\s]*- \[ \] (.+)/);
        const doneMatch = line.match(/^[\s]*- \[x\] (.+)/i);
        if (todoMatch) {
          tasks.push({ text: todoMatch[1], file: file.path, line: i + 1, done: false });
        } else if (doneMatch) {
          tasks.push({ text: doneMatch[1], file: file.path, line: i + 1, done: true });
        }
      }
    }

    // Group by folder → source file
    const openTasks = tasks.filter(t => !t.done);
    const folderGroups = new Map<string, Map<string, DashboardTask[]>>();

    for (const task of openTasks) {
      const folder = task.file.includes("/")
        ? task.file.split("/").slice(0, -1).join("/")
        : "Root";

      if (!folderGroups.has(folder)) folderGroups.set(folder, new Map());
      const sourceMap = folderGroups.get(folder)!;
      if (!sourceMap.has(task.file)) sourceMap.set(task.file, []);
      sourceMap.get(task.file)!.push(task);
    }

    // Render header
    const header = el.createDiv({ cls: "ca-task-header" });
    header.createEl("h2", { text: "Open tasks" });
    header.createEl("span", { text: `${openTasks.length} tasks`, cls: "ca-task-count" });

    const refreshBtn = header.createEl("button", { text: "Refresh", cls: "ca-task-refresh" });
    refreshBtn.addEventListener("click", () => {
      el.empty();
      void this.renderDashboard(el);
    });

    if (openTasks.length === 0) {
      el.createDiv({ text: "No open tasks found.", cls: "ca-task-empty" });
      return;
    }

    // Render folder groups (sorted by task count, largest first)
    const sorted = Array.from(folderGroups.entries()).sort((a, b) => {
      const countA = Array.from(a[1].values()).reduce((sum, arr) => sum + arr.length, 0);
      const countB = Array.from(b[1].values()).reduce((sum, arr) => sum + arr.length, 0);
      return countB - countA;
    });

    for (const [folder, sourceMap] of sorted) {
      const folderTaskCount = Array.from(sourceMap.values())
        .reduce((sum, arr) => sum + arr.length, 0);
      const section = el.createDiv({ cls: "ca-task-section" });

      // Folder header
      const sectionHeader = section.createDiv({ cls: "ca-task-section-header" });
      sectionHeader.createEl("span", { text: folder, cls: "ca-task-folder" });
      sectionHeader.createEl("span", {
        text: `${folderTaskCount}`,
        cls: "ca-task-section-count",
      });

      // Source file sub-groups
      const sortedSources = Array.from(sourceMap.entries())
        .sort((a, b) => b[1].length - a[1].length);

      for (const [filePath, fileTasks] of sortedSources) {
        const fileName =
          filePath.split("/").pop()?.replace(".md", "") || filePath;
        const sourceGroup = section.createDiv({ cls: "ca-task-source-group" });

        // Source file sub-header (clickable)
        const sourceHeader = sourceGroup.createDiv({ cls: "ca-task-source-header" });
        const sourceLink = sourceHeader.createEl("span", {
          text: fileName,
          cls: "ca-task-source-link",
        });
        sourceLink.addEventListener("click", () => {
          void this.app.workspace.openLinkText(filePath, "");
        });
        sourceHeader.createEl("span", {
          text: `${fileTasks.length}`,
          cls: "ca-task-source-count",
        });

        // Tasks
        for (const task of fileTasks) {
          const row = sourceGroup.createDiv({ cls: "ca-task-row" });

          const checkbox = row.createEl("input", { type: "checkbox" });
          checkbox.checked = task.done;
          checkbox.addEventListener("change", () => {
            void this.toggleTask(task.file, task.line, checkbox.checked);
          });

          const textEl = row.createDiv({ cls: "ca-task-text" });
          this.renderTaskText(task.text, textEl);

          // Click row to open source file
          row.addEventListener("click", (e) => {
            if ((e.target as HTMLElement).tagName === "INPUT") return;
            void this.app.workspace.openLinkText(task.file, "");
          });
        }
      }
    }
  }

  async toggleTask(filePath: string, lineNumber: number, done: boolean) {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return;
    const content = await this.app.vault.read(file);
    const lines = content.split("\n");
    const idx = lineNumber - 1;
    if (idx < 0 || idx >= lines.length) return;

    if (done) {
      lines[idx] = lines[idx].replace("- [ ]", "- [x]");
    } else {
      lines[idx] = lines[idx].replace(/- \[x\]/i, "- [ ]");
    }
    await this.app.vault.modify(file, lines.join("\n"));
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- base class requires Promise<void> return type
  async onClose() {}
}
