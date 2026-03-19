import React, { useState, useEffect, useCallback, useRef } from "react";
import { App, TFile, moment } from "obsidian";
import { OpenBrainSettings } from "../settings";
import { appendToDailySection } from "../chatHistory";
import { ObsidianIcon } from "./ObsidianIcon";

interface TaskItem {
  text: string;
  file: string;
  line: number;
  done: boolean;
  date?: string; // YYYY-MM-DD extracted from daily note filename
}

interface ContributionDay {
  date: string; // YYYY-MM-DD
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
}

interface TaskTrayProps {
  app: App;
  settings: OpenBrainSettings;
  isOpen: boolean;
  onClose: () => void;
  onFocusTask?: (task: { text: string; file: string }) => void;
}

// ── Helpers ──────────────────────────────────────────────────

/** Extract YYYY-MM-DD from a daily note path if it matches the settings format */
function extractDateFromPath(filePath: string, settings: OpenBrainSettings): string | undefined {
  const basename = filePath.split("/").pop()?.replace(".md", "");
  if (!basename) return undefined;

  // Try parsing as the configured daily note format
  const fmt = settings.dailyNoteFormat || "YYYY-MM-DD";
  const parsed = moment(basename, fmt, true);
  if (parsed.isValid()) return parsed.format("YYYY-MM-DD");

  // Fallback: try YYYY-MM-DD directly
  const fallback = moment(basename, "YYYY-MM-DD", true);
  if (fallback.isValid()) return fallback.format("YYYY-MM-DD");

  return undefined;
}

/** Determine the daily note folder prefix for the given settings */
function dailyNotePrefix(settings: OpenBrainSettings): string {
  const raw = settings.dailyNoteFolder || "Daily/{{YYYY}}/{{MM}}";
  // Strip date variables to get the static root
  return raw.replace(/\/?\{\{[^}]+\}\}.*/g, "").replace(/\/$/, "");
}

function isDailyNote(filePath: string, settings: OpenBrainSettings): boolean {
  const prefix = dailyNotePrefix(settings);
  return filePath.startsWith(prefix + "/");
}

function computeLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count === 0) return 0;
  if (max <= 0) return 1;
  const ratio = count / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.50) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

// ── Component ────────────────────────────────────────────────

export function TaskTray({ app, settings, isOpen, onClose, onFocusTask }: TaskTrayProps) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [contributions, setContributions] = useState<ContributionDay[]>([]);
  const [quickAddText, setQuickAddText] = useState("");
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({
    overdue: true,
    week: true,
    all: true,
  });
  const [loading, setLoading] = useState(false);
  const quickInputRef = useRef<HTMLInputElement>(null);

  const today = moment().format("YYYY-MM-DD");
  const startOfWeek = moment().startOf("isoWeek").format("YYYY-MM-DD");

  // ── Scan vault for tasks ──
  const scanTasks = useCallback(async () => {
    setLoading(true);
    const allTasks: TaskItem[] = [];
    const files = app.vault.getMarkdownFiles();

    for (const file of files) {
      const content = await app.vault.cachedRead(file);
      const lines = content.split("\n");
      const fileDate = extractDateFromPath(file.path, settings);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const todoMatch = line.match(/^[\s]*- \[ \] (.+)/);
        const doneMatch = line.match(/^[\s]*- \[x\] (.+)/i);
        if (todoMatch) {
          allTasks.push({
            text: todoMatch[1],
            file: file.path,
            line: i + 1,
            done: false,
            date: fileDate,
          });
        } else if (doneMatch) {
          allTasks.push({
            text: doneMatch[1],
            file: file.path,
            line: i + 1,
            done: true,
            date: fileDate,
          });
        }
      }
    }

    setTasks(allTasks);

    // Build contribution grid (last 84 days / 12 weeks)
    const dayMap = new Map<string, number>();
    for (let d = 0; d < 84; d++) {
      dayMap.set(moment().subtract(d, "days").format("YYYY-MM-DD"), 0);
    }
    for (const task of allTasks) {
      if (task.done && task.date && dayMap.has(task.date)) {
        dayMap.set(task.date, (dayMap.get(task.date) || 0) + 1);
      }
    }

    // Also count completed tasks from file modification dates for non-daily notes
    for (const task of allTasks) {
      if (task.done && !task.date) {
        const file = app.vault.getAbstractFileByPath(task.file);
        if (file instanceof TFile) {
          const modDate = moment(file.stat.mtime).format("YYYY-MM-DD");
          if (dayMap.has(modDate)) {
            dayMap.set(modDate, (dayMap.get(modDate) || 0) + 1);
          }
        }
      }
    }

    const maxCount = Math.max(...Array.from(dayMap.values()), 1);
    const contribs: ContributionDay[] = [];
    for (let d = 83; d >= 0; d--) {
      const date = moment().subtract(d, "days").format("YYYY-MM-DD");
      const count = dayMap.get(date) || 0;
      contribs.push({ date, count, level: computeLevel(count, maxCount) });
    }
    setContributions(contribs);
    setLoading(false);
  }, [app, settings]);

  // Scan on open
  useEffect(() => {
    if (isOpen) {
      void scanTasks();
      // Focus quick-add after animation
      setTimeout(() => quickInputRef.current?.focus(), 300);
    }
  }, [isOpen, scanTasks]);

  // ── Toggle task in file ──
  const toggleTask = useCallback(
    async (task: TaskItem) => {
      const file = app.vault.getAbstractFileByPath(task.file);
      if (!(file instanceof TFile)) return;
      const content = await app.vault.read(file);
      const lines = content.split("\n");
      const idx = task.line - 1;
      if (idx < 0 || idx >= lines.length) return;

      if (!task.done) {
        lines[idx] = lines[idx].replace("- [ ]", "- [x]");
      } else {
        lines[idx] = lines[idx].replace(/- \[x\]/i, "- [ ]");
      }
      await app.vault.modify(file, lines.join("\n"));

      // Update local state
      setTasks((prev) =>
        prev.map((t) =>
          t.file === task.file && t.line === task.line
            ? { ...t, done: !t.done }
            : t
        )
      );
    },
    [app]
  );

  // ── Quick add ──
  const handleQuickAdd = useCallback(async () => {
    const text = quickAddText.trim();
    if (!text) return;
    await appendToDailySection(app, `- [ ] ${text}`, "Focus", settings);
    setQuickAddText("");
    // Refresh after a short delay to pick up the new task
    setTimeout(() => void scanTasks(), 200);
  }, [quickAddText, app, settings, scanTasks]);

  // ── Group tasks ──
  const openTasks = tasks.filter((t) => !t.done);

  const todayTasks = openTasks.filter(
    (t) => t.date === today && isDailyNote(t.file, settings)
  );
  const overdueTasks = openTasks.filter(
    (t) => t.date && t.date < today && isDailyNote(t.file, settings)
  );
  const weekTasks = openTasks.filter(
    (t) =>
      t.date &&
      t.date >= startOfWeek &&
      t.date <= today &&
      isDailyNote(t.file, settings) &&
      t.date !== today
  );
  const todayIds = new Set(todayTasks.map((t) => `${t.file}:${t.line}`));
  const overdueIds = new Set(overdueTasks.map((t) => `${t.file}:${t.line}`));
  const weekIds = new Set(weekTasks.map((t) => `${t.file}:${t.line}`));
  const allOtherTasks = openTasks.filter(
    (t) => {
      const id = `${t.file}:${t.line}`;
      return !todayIds.has(id) && !overdueIds.has(id) && !weekIds.has(id);
    }
  );

  // Completed count for score
  const completedToday = tasks.filter((t) => t.done && t.date === today).length;
  const completedTotal = tasks.filter((t) => t.done).length;

  // ── Contribution grid layout ──
  // Grid is 12 columns (weeks) x 7 rows (Mon-Sun)
  // contributions[] is 84 days in chronological order (oldest first)
  // We need to map each day to its correct grid position
  const gridCells: (ContributionDay & { row: number; col: number })[] = [];

  if (contributions.length === 84) {
    for (let i = 0; i < 84; i++) {
      const dayOfWeek = moment(contributions[i].date).isoWeekday(); // 1=Mon, 7=Sun
      const row = dayOfWeek - 1;
      const col = Math.floor(i / 7);
      gridCells.push({ ...contributions[i], row, col });
    }
  }

  // Month labels
  const monthLabels: { label: string; col: number }[] = [];
  if (contributions.length === 84) {
    let lastMonth = -1;
    for (let i = 0; i < 84; i += 7) {
      const m = moment(contributions[i].date).month();
      if (m !== lastMonth) {
        monthLabels.push({ label: moment(contributions[i].date).format("MMM"), col: Math.floor(i / 7) });
        lastMonth = m;
      }
    }
  }

  const toggleSection = (key: string) => {
    setCollapsedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const openFile = (filePath: string) => {
    void app.workspace.openLinkText(filePath, "");
  };

  const renderTaskList = (items: TaskItem[]) => (
    <div className="ca-tray-task-list">
      {items.map((task) => (
        <div key={`${task.file}:${task.line}`} className="ca-tray-task">
          <input
            type="checkbox"
            checked={task.done}
            onChange={() => void toggleTask(task)}
            className="ca-tray-task-checkbox"
          />
          <span className={`ca-tray-task-text ${task.done ? "ca-tray-task-done" : ""}`}>
            {task.text}
          </span>
          <span
            className="ca-tray-task-source"
            onClick={() => openFile(task.file)}
          >
            {task.file.split("/").pop()?.replace(".md", "") || task.file}
          </span>
          {!task.done && onFocusTask && (
            <button
              className="ca-tray-task-focus"
              onClick={() => {
                onFocusTask({ text: task.text, file: task.file });
                onClose();
              }}
              aria-label="Work on this task in chat"
            >
              <ObsidianIcon name="arrow-right" />
            </button>
          )}
        </div>
      ))}
    </div>
  );

  const renderSection = (
    key: string,
    label: string,
    items: TaskItem[],
    defaultOpen?: boolean
  ) => {
    const isCollapsed = defaultOpen ? false : collapsedSections[key];
    return (
      <div className="ca-tray-section" key={key}>
        <div
          className="ca-tray-section-header"
          onClick={() => {
            if (!defaultOpen) toggleSection(key);
          }}
        >
          <div className="ca-tray-section-title">
            {!defaultOpen && (
              <span className={`ca-tray-chevron ${isCollapsed ? "" : "open"}`}>
                {"\u25B8"}
              </span>
            )}
            {label}
          </div>
          <span className="ca-tray-section-count">{items.length}</span>
        </div>
        {!isCollapsed && renderTaskList(items)}
      </div>
    );
  };

  return (
    <>
      {/* Overlay to close tray when clicking outside */}
      {isOpen && <div className="ca-tray-overlay" onClick={onClose} />}

      <div className={`ca-task-tray ${isOpen ? "open" : ""}`}>
        {/* Tray header with score */}
        <div className="ca-tray-header">
          <div>
            <div className="ca-tray-title">Tasks</div>
            <div className="ca-tray-score-label">{completedToday} done today</div>
          </div>
          <div className="ca-tray-score-block">
            <div className="ca-tray-score">{completedTotal}</div>
            <div className="ca-tray-score-label">completed</div>
          </div>
        </div>

        {/* Quick add */}
        <div className="ca-tray-quick-add">
          <input
            ref={quickInputRef}
            className="ca-tray-quick-input"
            placeholder="Quick add task..."
            value={quickAddText}
            onChange={(e) => setQuickAddText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleQuickAdd();
              }
            }}
          />
        </div>

        {/* Contribution grid */}
        <div className="ca-contrib-wrapper">
          {/* Month labels */}
          <div className="ca-contrib-months">
            {monthLabels.map((ml, i) => (
              <span
                key={i}
                className="ca-contrib-month-label"
                style={{ gridColumn: ml.col + 2 }}
              >
                {ml.label}
              </span>
            ))}
          </div>
          <div className="ca-contrib-grid">
            {/* Day of week labels */}
            <span className="ca-contrib-day-label" style={{ gridRow: 2 }}>M</span>
            <span className="ca-contrib-day-label" style={{ gridRow: 4 }}>W</span>
            <span className="ca-contrib-day-label" style={{ gridRow: 6 }}>F</span>

            {gridCells.map((cell) => (
              <div
                key={cell.date}
                className="ca-contrib-cell"
                data-level={cell.level}
                style={{ gridRow: cell.row + 1, gridColumn: cell.col + 2 }}
                aria-label={`${cell.date}: ${cell.count} task${cell.count !== 1 ? "s" : ""} completed`}
                title={`${cell.date}: ${cell.count} task${cell.count !== 1 ? "s" : ""} completed`}
              />
            ))}
          </div>
        </div>

        {/* Task sections */}
        <div className="ca-tray-sections">
          {loading && <div className="ca-tray-loading">Scanning vault...</div>}
          {!loading && (
            <>
              {renderSection("today", "Today", todayTasks, true)}
              {overdueTasks.length > 0 &&
                renderSection("overdue", "Overdue", overdueTasks)}
              {weekTasks.length > 0 &&
                renderSection("week", "This week", weekTasks)}
              {allOtherTasks.length > 0 &&
                renderSection("all", "All open", allOtherTasks)}
              {openTasks.length === 0 && !loading && (
                <div className="ca-tray-empty">No open tasks found.</div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
