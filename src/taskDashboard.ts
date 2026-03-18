import { ItemView, WorkspaceLeaf, TFile } from "obsidian";

export const TASK_DASHBOARD_VIEW = "open-brain-tasks";

export class TaskDashboardView extends ItemView {
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType() { return TASK_DASHBOARD_VIEW; }
  getDisplayText() { return "Tasks"; }
  getIcon() { return "check-square"; }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("ca-task-dashboard");
    await this.renderDashboard(container as HTMLElement);
  }

  async renderDashboard(el: HTMLElement) {
    // Scan all markdown files for tasks
    const tasks: { text: string; file: string; line: number; done: boolean }[] = [];
    const files = this.app.vault.getMarkdownFiles();

    for (const file of files) {
      const content = await this.app.vault.cachedRead(file);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const todoMatch = line.match(/^[\s]*- \[ \] (.+)/);
        const doneMatch = line.match(/^[\s]*- \[x\] (.+)/);
        if (todoMatch) {
          tasks.push({ text: todoMatch[1], file: file.path, line: i + 1, done: false });
        } else if (doneMatch) {
          tasks.push({ text: doneMatch[1], file: file.path, line: i + 1, done: true });
        }
      }
    }

    // Group by source folder
    const openTasks = tasks.filter(t => !t.done);
    const groups = new Map<string, typeof tasks>();
    for (const task of openTasks) {
      const folder = task.file.includes("/")
        ? task.file.split("/").slice(0, -1).join("/")
        : "Root";
      const group = groups.get(folder) || [];
      group.push(task);
      groups.set(folder, group);
    }

    // Render header
    const header = el.createDiv({ cls: "ca-task-header" });
    header.createEl("h2", { text: "Open tasks" });
    header.createEl("span", { text: `${openTasks.length} tasks`, cls: "ca-task-count" });

    // Render a refresh button
    const refreshBtn = header.createEl("button", { text: "Refresh", cls: "ca-task-refresh" });
    refreshBtn.addEventListener("click", () => {
      el.empty();
      void this.renderDashboard(el);
    });

    if (openTasks.length === 0) {
      el.createDiv({ text: "No open tasks found.", cls: "ca-task-empty" });
      return;
    }

    // Render groups
    const sorted = Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length);
    for (const [folder, folderTasks] of sorted) {
      const section = el.createDiv({ cls: "ca-task-section" });
      const sectionHeader = section.createDiv({ cls: "ca-task-section-header" });
      sectionHeader.createEl("span", { text: folder, cls: "ca-task-folder" });
      sectionHeader.createEl("span", { text: `${folderTasks.length}`, cls: "ca-task-section-count" });

      for (const task of folderTasks) {
        const row = section.createDiv({ cls: "ca-task-row" });
        const checkbox = row.createEl("input", { type: "checkbox" });
        checkbox.checked = task.done;
        checkbox.addEventListener("change", () => {
          // Toggle task in the file
          void this.toggleTask(task.file, task.line, checkbox.checked);
        });
        row.createEl("span", { text: task.text, cls: "ca-task-text" });
        const sourceEl = row.createEl("span", {
          text: task.file.split("/").pop()?.replace(".md", "") || task.file,
          cls: "ca-task-source"
        });
        sourceEl.addEventListener("click", () => {
          void this.app.workspace.openLinkText(task.file, "");
        });
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
      lines[idx] = lines[idx].replace("- [x]", "- [ ]");
    }
    await this.app.vault.modify(file, lines.join("\n"));
  }

  async onClose() {}
}
