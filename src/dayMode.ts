/**
 * Determine if today is a work day or weekend based on user's configured work days.
 * @param workDays Array of day numbers (0=Sun, 1=Mon, ..., 6=Sat)
 */
export function getDayMode(workDays: number[]): "work" | "weekend" {
  const today = new Date().getDay();
  return workDays.includes(today) ? "work" : "weekend";
}
