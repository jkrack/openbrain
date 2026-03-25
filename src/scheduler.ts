import { App, Notice, moment } from "obsidian";
import { OpenBrainSettings } from "./settings";
import { Skill, loadSkills, runSkillInBackground } from "./skills";
import { getDayMode } from "./dayMode";

interface ScheduleConfig {
  skillName: string;
  // "daily" = run once per day, "weekly:5" = run on Friday (day 5), "hourly" = run every hour
  schedule: string;
  // "notify" = show notice only, "run" = execute the skill in background
  action: "notify" | "run";
  // Optional: only run when this settings flag is true
  requiresSetting?: keyof OpenBrainSettings;
  // Optional: only run on work days or weekends
  dayMode?: "work" | "weekend";
}

const DEFAULT_SCHEDULES: ScheduleConfig[] = [
  { skillName: "Weekly Review", schedule: "weekly:5", action: "notify" },
  { skillName: "End of Day", schedule: "daily:17", action: "notify", dayMode: "work" },
  { skillName: "Graph Enrichment", schedule: "hourly", action: "run", requiresSetting: "knowledgeGraphEnabled" },
  { skillName: "Graph Health", schedule: "weekly:0", action: "run", requiresSetting: "knowledgeGraphEnabled" },
];

export class SkillScheduler {
  private app: App;
  private settings: OpenBrainSettings;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastChecked: Record<string, string> = {};
  private running = new Set<string>();

  constructor(app: App, settings: OpenBrainSettings) {
    this.app = app;
    this.settings = settings;
  }

  start(): void {
    // Check every 15 minutes (so hourly skills fire within ~15 min of the hour)
    this.intervalId = setInterval(() => {
      void this.checkSchedules();
    }, 15 * 60 * 1000);

    // Also check on start (after a delay to let vault load)
    setTimeout(() => void this.checkSchedules(), 10000);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async checkSchedules(): Promise<void> {
    const skills = await loadSkills(this.app, this.settings.skillsFolder);
    const now = moment();
    const today = now.format("YYYY-MM-DD");
    const dayOfWeek = now.day(); // 0=Sun, 5=Fri
    const hour = now.hour();

    for (const config of DEFAULT_SCHEDULES) {
      const skill: Skill | undefined = skills.find(s => s.name === config.skillName);
      if (!skill) continue;

      // Check required setting gate
      if (config.requiresSetting && !this.settings[config.requiresSetting]) continue;

      // Check day mode gate
      const currentMode = getDayMode(this.settings.workDays);
      if (config.dayMode && config.dayMode !== currentMode) continue;
      if (skill.dayMode && skill.dayMode !== currentMode) continue;

      // Don't re-trigger if already running
      if (this.running.has(config.skillName)) continue;

      const [type, param] = config.schedule.split(":");
      const lastRun = this.lastChecked[config.skillName];
      let shouldFire = false;

      if (type === "hourly") {
        const currentHourKey = now.format("YYYY-MM-DD-HH");
        if (lastRun === currentHourKey) continue;
        this.lastChecked[config.skillName] = currentHourKey;
        shouldFire = true;
      } else if (type === "weekly" && dayOfWeek === parseInt(param) && hour >= 14) {
        if (lastRun === today) continue;
        this.lastChecked[config.skillName] = today;
        shouldFire = true;
      } else if (type === "daily" && hour >= parseInt(param)) {
        if (lastRun === today) continue;
        this.lastChecked[config.skillName] = today;
        shouldFire = true;
      }

      if (!shouldFire) continue;

      if (config.action === "run") {
        this.running.add(config.skillName);
        void runSkillInBackground(this.app, this.settings, skill)
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[OpenBrain] Scheduled skill "${config.skillName}" failed: ${msg}`);
          })
          .finally(() => {
            this.running.delete(config.skillName);
          });
      } else {
        new Notice(`OpenBrain: ${skill.name} — open the panel to run it`);
      }
    }
  }
}
