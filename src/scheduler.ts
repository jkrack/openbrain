import { App, Notice, moment } from "obsidian";
import { OpenBrainSettings } from "./settings";
import { Skill, loadSkills } from "./skills";

interface ScheduleConfig {
  skillName: string;
  // "daily" = run once per day, "weekly:5" = run on Friday (day 5)
  schedule: string;
  lastRun?: string; // ISO date string
}

const DEFAULT_SCHEDULES: ScheduleConfig[] = [
  { skillName: "Weekly Review", schedule: "weekly:5" }, // Friday
  { skillName: "End of Day", schedule: "daily:17" },    // 5pm reminder
];

export class SkillScheduler {
  private app: App;
  private settings: OpenBrainSettings;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastChecked: Record<string, string> = {};

  constructor(app: App, settings: OpenBrainSettings) {
    this.app = app;
    this.settings = settings;
  }

  start(): void {
    // Check every 30 minutes
    this.intervalId = setInterval(() => {
      void this.checkSchedules();
    }, 30 * 60 * 1000);

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

      const lastRun = this.lastChecked[config.skillName];
      if (lastRun === today) continue; // Already ran today

      const [type, param] = config.schedule.split(":");

      if (type === "weekly" && dayOfWeek === parseInt(param) && hour >= 14) {
        // Weekly skill — run on the specified day after 2pm
        new Notice(`OpenBrain: Time for your ${skill.name}`);
        this.lastChecked[config.skillName] = today;
      } else if (type === "daily" && hour >= parseInt(param)) {
        // Daily reminder at specified hour
        new Notice(`OpenBrain: ${skill.name} reminder — wrap up your day`);
        this.lastChecked[config.skillName] = today;
      }
    }
  }
}
