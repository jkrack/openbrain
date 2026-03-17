/**
 * Local-only performance tracker for OpenBrain.
 * Measures timing of key operations to identify bottlenecks.
 * Data stays on-device — logged to console.debug only.
 */

interface PerfEntry {
  operation: string;
  startMs: number;
  endMs?: number;
  durationMs?: number;
  metadata?: Record<string, string | number>;
}

const entries: PerfEntry[] = [];
const MAX_ENTRIES = 200;

/**
 * Start timing an operation. Returns a function to call when done.
 */
export function startTimer(operation: string, metadata?: Record<string, string | number>): () => void {
  const entry: PerfEntry = {
    operation,
    startMs: performance.now(),
    metadata,
  };

  return () => {
    entry.endMs = performance.now();
    entry.durationMs = Math.round(entry.endMs - entry.startMs);
    entries.push(entry);

    // Keep bounded
    if (entries.length > MAX_ENTRIES) entries.shift();

    // Log slow operations (>500ms)
    if (entry.durationMs > 500) {
      console.debug(
        `[OpenBrain perf] ${operation}: ${entry.durationMs}ms`,
        metadata || ""
      );
    }
  };
}

/**
 * Measure an async function's execution time.
 */
export async function measure<T>(
  operation: string,
  fn: () => Promise<T>,
  metadata?: Record<string, string | number>
): Promise<T> {
  const done = startTimer(operation, metadata);
  try {
    return await fn();
  } finally {
    done();
  }
}

/**
 * Get a summary of recent performance data.
 */
export function getSummary(): Record<string, { count: number; avgMs: number; maxMs: number; p95Ms: number }> {
  const grouped = new Map<string, number[]>();

  for (const entry of entries) {
    if (!entry.durationMs) continue;
    const durations = grouped.get(entry.operation) || [];
    durations.push(entry.durationMs);
    grouped.set(entry.operation, durations);
  }

  const summary: Record<string, { count: number; avgMs: number; maxMs: number; p95Ms: number }> = {};

  for (const [op, durations] of grouped) {
    durations.sort((a, b) => a - b);
    summary[op] = {
      count: durations.length,
      avgMs: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
      maxMs: durations[durations.length - 1],
      p95Ms: durations[Math.floor(durations.length * 0.95)] || durations[durations.length - 1],
    };
  }

  return summary;
}

/**
 * Get all raw entries (for debugging).
 */
export function getEntries(): readonly PerfEntry[] {
  return entries;
}

/**
 * Get the last response timing (for showing inline after each message).
 */
export function getLastResponseTiming(): { totalMs: number; breakdown: Record<string, number> } | null {
  const recent = entries.filter((e) => e.durationMs !== undefined).slice(-10);
  if (recent.length === 0) return null;

  const breakdown: Record<string, number> = {};
  let totalMs = 0;

  for (const entry of recent) {
    if (!entry.durationMs) continue;
    breakdown[entry.operation] = entry.durationMs;
    if (entry.operation === "cli-total-response") totalMs = entry.durationMs;
  }

  if (totalMs === 0) {
    // No CLI response — use the largest timing
    totalMs = Math.max(...Object.values(breakdown));
  }

  return { totalMs, breakdown };
}

/**
 * Print a formatted summary to console.
 */
export function logSummary(): void {
  const summary = getSummary();
  const rows = Object.entries(summary)
    .sort((a, b) => b[1].avgMs - a[1].avgMs)
    .map(([op, stats]) => ({
      Operation: op,
      Count: stats.count,
      "Avg (ms)": stats.avgMs,
      "P95 (ms)": stats.p95Ms,
      "Max (ms)": stats.maxMs,
    }));

  if (rows.length === 0) {
    console.debug("[OpenBrain perf] No data yet");
    return;
  }

  console.debug("[OpenBrain perf] Summary:");
  console.table(rows);
}
