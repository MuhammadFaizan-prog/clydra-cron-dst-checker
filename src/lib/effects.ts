// Presentation model on top of audit(): classifies each job's effects for the
// redesigned UI (skipped / repeated / delayed / handled / UTC shift / none) and
// works out how a fixed local time maps to UTC across each clock change.
// Pure functions; audit.ts is unchanged.
import type { Finding, JobReport, Outcome } from "./audit";
import { fmtTime, type Transition } from "./tz";

export type Effect = "skipped" | "repeated" | "delayed" | "handled" | "utc" | "none";

/** Display order, most disruptive first. */
export const EFFECT_ORDER: Effect[] = ["skipped", "repeated", "delayed", "handled", "utc", "none"];

export function effectOfOutcome(o: Outcome): Effect {
  switch (o) {
    case "skipped":
      return "skipped";
    case "twice":
      return "repeated";
    case "late":
      return "delayed";
    default:
      return "handled";
  }
}

/**
 * Every effect a job has in the period, most disruptive first.
 * - Findings map to skipped / repeated / delayed / handled.
 * - A fixed-time job in a zone that changes its offset also runs at a different
 *   UTC instant after each change ("utc"), whether or not it hits a gap/overlap.
 * - Nothing at all: "none".
 */
export function jobEffects(rep: JobReport, transitions: Transition[]): Effect[] {
  const set = new Set<Effect>();
  for (const f of rep.findings) set.add(effectOfOutcome(f.outcome));
  if (rep.job.schedule.fixedTime && transitions.length > 0) set.add("utc");
  if (set.size === 0) set.add("none");
  return EFFECT_ORDER.filter((e) => set.has(e));
}

export function primaryEffect(effects: Effect[]): Effect {
  return effects[0] ?? "none";
}

/** Count of jobs per effect (a job can count under several effects). */
export function effectCounts(reps: JobReport[], zones: Record<string, Transition[]>): Record<Effect, number> {
  const c: Record<Effect, number> = { skipped: 0, repeated: 0, delayed: 0, handled: 0, utc: 0, none: 0 };
  for (const r of reps) for (const e of jobEffects(r, zones[r.zone] ?? [])) c[e]++;
  return c;
}

export interface UtcPeriod {
  /** Instant the period starts (null = start of the checked window). */
  fromMs: number | null;
  /** UTC offset of the zone in this period, minutes east. */
  offset: number;
  /** UTC wall time of the local run, HH:MM. */
  utc: string;
  /** -1 when the UTC time falls on the previous day, +1 on the next day. */
  dayShift: -1 | 0 | 1;
}

/**
 * How a fixed local run time (h:mi) maps to UTC in each offset period.
 * `startOffset` is the zone's offset at the start of the window.
 */
export function utcPeriods(h: number, mi: number, startOffset: number, transitions: Transition[]): UtcPeriod[] {
  const mk = (fromMs: number | null, offset: number): UtcPeriod => {
    let m = h * 60 + mi - offset;
    let dayShift: -1 | 0 | 1 = 0;
    if (m < 0) {
      m += 1440;
      dayShift = -1;
    } else if (m >= 1440) {
      m -= 1440;
      dayShift = 1;
    }
    return { fromMs, offset, utc: fmtTime({ h: Math.floor(m / 60), mi: m % 60 }), dayShift };
  };
  const out = [mk(null, startOffset)];
  for (const t of transitions) out.push(mk(t.at, t.offsetAfter));
  return out;
}

/** The first local run time of a fixed-time schedule (lowest hour, lowest minute). */
export function representativeTime(rep: JobReport): { h: number; mi: number } | null {
  const s = rep.job.schedule;
  if (!s.fixedTime) return null;
  const h = Math.min(...s.hour.values);
  const mi = Math.min(...s.minute.values);
  return { h, mi };
}

/**
 * Plain explanation of what a suggested hour change does to the original timing.
 * Never claims the change is automatically safe for the business schedule.
 */
export function explainSuggestion(rep: JobReport): string | null {
  if (!rep.suggestion) return null;
  const s = rep.job.schedule;
  const oldHours = [...s.hour.values].sort((a, b) => a - b);
  const minutes = [...s.minute.values].sort((a, b) => a - b);
  const parts = rep.suggestion.split(/\s+/);
  const newHours = (parts[1] ?? "").split(",").map(Number);
  const fmtList = (hs: number[]) =>
    hs
      .slice(0, 3)
      .map((hh) => fmtTime({ h: hh, mi: minutes[0] ?? 0 }))
      .join(", ") + (hs.length > 3 ? " …" : "");
  const moved = oldHours.filter((hh) => !newHours.includes(hh));
  const added = newHours.filter((hh) => !oldHours.includes(hh));
  return (
    `Changes the run from ${fmtList(moved)} to ${fmtList(added)} local time on every day it runs, not only on clock-change nights. ` +
    `It avoids every missing or repeated hour in this zone for the checked period. Confirm the new time still suits anything that depends on this job before adopting it.`
  );
}

/** Findings of a job for one transition instant. */
export function findingsAt(rep: JobReport, at: number): Finding[] {
  return rep.findings.filter((f) => f.transition.at === at);
}
