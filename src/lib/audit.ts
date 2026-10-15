// Combine parsed jobs with a zone's real transitions and a scheduler model.
import { matches, type CronSchedule, type CrontabJob } from "./cron";
import { findTransitions, fmtDate, fmtDelta, fmtTime, type Transition, type WallClock } from "./tz";

export type ModelId = "vixie" | "literal" | "quartz";

export interface SchedulerModel {
  id: ModelId;
  label: string;
  examples: string;
  rule: string;
  sourceUrl: string;
}

export const MODELS: Record<ModelId, SchedulerModel> = {
  vixie: {
    id: "vixie",
    label: "Vixie / ISC cron, cronie",
    examples: "Debian & Ubuntu cron, RHEL/Fedora cronie",
    rule:
      "Fixed-time jobs (no * in the minute or hour field) skipped by a forward change run soon after it; in a repeated hour they don't run again. Jobs with * in minute or hour simply follow the new clock.",
    sourceUrl: "https://manpages.debian.org/bookworm/cron/cron.8.en.html",
  },
  literal: {
    id: "literal",
    label: "Literal wall clock",
    examples: "e.g. Kubernetes CronJob with timeZone (kubernetes#121594), Forgejo Actions, many app libraries",
    rule: "A time that doesn't exist is skipped; a time that happens twice fires twice.",
    sourceUrl: "https://github.com/kubernetes/kubernetes/issues/121594",
  },
  quartz: {
    id: "quartz",
    label: "Skip missing, fire once",
    examples: "e.g. Quartz CronTrigger (Java, Quartz.NET, Rundeck)",
    rule: "A time that doesn't exist is skipped for that day; a repeated time fires only on its first occurrence.",
    sourceUrl: "https://github.com/rundeck/rundeck/issues/6879",
  },
};

export type Outcome = "skipped" | "late" | "twice" | "once";
export type Severity = "high" | "medium" | "low" | "ok";

export interface Finding {
  job: CrontabJob;
  zone: string;
  transition: Transition;
  kind: "gap" | "overlap";
  /** Local wall-clock times (HH:MM on `date`) the schedule names inside the affected window. */
  times: WallClock[];
  outcome: Outcome;
  severity: Severity;
  summary: string;
}

export interface JobReport {
  job: CrontabJob;
  zone: string;
  findings: Finding[];
  worst: Severity;
  suggestion: string | null;
}

export interface AuditResult {
  model: SchedulerModel;
  startMs: number;
  endMs: number;
  zones: Record<string, Transition[]>;
  jobs: JobReport[];
  findings: Finding[];
  counts: Record<Severity, number>;
}

const MINUTE = 60_000;
const SEV_ORDER: Severity[] = ["ok", "low", "medium", "high"];

function naiveMs(w: WallClock): number {
  return Date.UTC(w.y, w.mon - 1, w.d, w.h, w.mi);
}
function fromNaive(ms: number): WallClock {
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), mon: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}

/** Local wall-clock minutes that are missing (gap) or repeated (overlap) around a transition. */
export function affectedWindow(t: Transition): { kind: "gap" | "overlap"; minutes: WallClock[] } {
  const kind = t.delta > 0 ? "gap" : "overlap";
  const start = kind === "gap" ? naiveMs(t.localBefore) : naiveMs(t.localAfter);
  const minutes: WallClock[] = [];
  for (let i = 0; i < Math.abs(t.delta); i++) minutes.push(fromNaive(start + i * MINUTE));
  return { kind, minutes };
}

export function scheduledIn(s: CronSchedule, minutes: WallClock[]): WallClock[] {
  return minutes.filter((w) => matches(s, w.y, w.mon, w.d, w.h, w.mi));
}

export function outcomeFor(model: ModelId, kind: "gap" | "overlap", fixedTime: boolean): Outcome {
  if (kind === "gap") {
    if (model === "vixie" && fixedTime) return "late";
    return "skipped";
  }
  if (model === "literal") return "twice";
  if (model === "vixie" && !fixedTime) return "twice";
  return "once";
}

export function severityFor(outcome: Outcome, fixedTime: boolean): Severity {
  if (outcome === "once") return "ok";
  if (outcome === "late") return "medium";
  return fixedTime ? "high" : "low";
}

function listTimes(times: WallClock[], max = 4): string {
  const s = times.slice(0, max).map(fmtTime).join(", ");
  return times.length > max ? `${s} and ${times.length - max} more` : s;
}

function describe(f: Omit<Finding, "summary">): string {
  const t = f.transition;
  const date = affectedDate(t);
  const sameDay = fmtDate(t.localBefore) === fmtDate(t.localAfter);
  const n = f.times.length;
  const one = n === 1;
  const runs = one ? `its ${listTimes(f.times)} run` : `${n} scheduled runs (${listTimes(f.times)})`;
  if (f.kind === "gap") {
    const change = sameDay ? `Clocks jump ${changeText(t)} on ${date}` : `Clocks jump ${changeText(t)}`;
    const missing = one ? "doesn't exist" : "don't exist";
    if (f.outcome === "late") return `${change}: ${runs} ${missing}, so cron runs it right after the jump, at about ${fmtTime(t.localAfter)}.`;
    return `${change}: ${runs} ${missing}, so ${one ? "it is" : "they are"} skipped that day.`;
  }
  const back = sameDay ? `Clocks go back ${changeText(t)} on ${date}` : `Clocks go back ${changeText(t)}`;
  const twice = one ? "happens twice" : "happen twice";
  if (f.outcome === "twice") return `${back}: ${runs} ${twice}, and the job runs both times.`;
  return `${back}: ${runs} ${twice}, but the job runs only once.`;
}

/**
 * Suggest an hour field that avoids every affected window for this zone, for
 * fixed-time jobs only. Returns null when nothing needs changing or no clean hour exists.
 */
export function suggestHours(s: CronSchedule, transitions: Transition[]): string | null {
  if (!s.fixedTime) return null;
  const bad = new Set<number>(); // minute-of-day values that are ever missing/repeated
  for (const t of transitions) for (const w of affectedWindow(t).minutes) bad.add(w.h * 60 + w.mi);
  const mins = [...s.minute.values];
  const hourOk = (h: number) => mins.every((m) => !bad.has(h * 60 + m));
  const hours = [...s.hour.values].sort((a, b) => a - b);
  if (hours.every(hourOk)) return null;
  const out = new Set<number>();
  for (const h of hours) {
    if (hourOk(h)) {
      out.add(h);
      continue;
    }
    let found: number | null = null;
    for (let k = 1; k <= 12 && found === null; k++) {
      for (const cand of [h + k, h - k]) {
        const c = (cand + 24) % 24;
        if (hourOk(c) && !hours.includes(c)) {
          found = c;
          break;
        }
      }
    }
    if (found === null) return null;
    out.add(found);
  }
  return [...out].sort((a, b) => a - b).join(",");
}

export function rewriteWithHours(expr: CronSchedule, hourField: string): string {
  const parts = expr.source.startsWith("@") ? null : expr.source.split(/\s+/);
  if (parts && parts.length === 5) {
    parts[1] = hourField;
    return parts.join(" ");
  }
  // macro like @daily ("0 0 * * *"): expand and replace hour
  const m = [...expr.minute.values][0] ?? 0;
  const dom = expr.dom.star ? "*" : [...expr.dom.values].join(",");
  const mon = expr.month.star ? "*" : [...expr.month.values].join(",");
  const dow = expr.dow.star ? "*" : [...expr.dow.values].join(",");
  return `${m} ${hourField} ${dom} ${mon} ${dow}`;
}

export function audit(jobs: CrontabJob[], defaultZone: string, model: ModelId, startMs: number, endMs: number): AuditResult {
  const zones: Record<string, Transition[]> = {};
  const transitionsFor = (z: string) => (zones[z] ??= findTransitions(z, startMs, endMs));
  const reports: JobReport[] = [];
  const all: Finding[] = [];
  for (const job of jobs) {
    const zone = job.timeZone ?? defaultZone;
    const trans = transitionsFor(zone);
    const findings: Finding[] = [];
    for (const t of trans) {
      const { kind, minutes } = affectedWindow(t);
      const times = scheduledIn(job.schedule, minutes);
      if (times.length === 0) continue;
      const outcome = outcomeFor(model, kind, job.schedule.fixedTime);
      const base = { job, zone, transition: t, kind, times, outcome, severity: severityFor(outcome, job.schedule.fixedTime) };
      findings.push({ ...base, summary: describe(base) });
    }
    let worst: Severity = "ok";
    for (const f of findings) if (SEV_ORDER.indexOf(f.severity) > SEV_ORDER.indexOf(worst)) worst = f.severity;
    let suggestion: string | null = null;
    if (findings.some((f) => f.severity !== "ok")) {
      const hours = suggestHours(job.schedule, trans);
      if (hours !== null) suggestion = rewriteWithHours(job.schedule, hours);
    }
    reports.push({ job, zone, findings, worst, suggestion });
    all.push(...findings);
  }
  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0, ok: 0 };
  for (const r of reports) counts[r.worst]++;
  all.sort((a, b) => a.transition.at - b.transition.at || a.job.line - b.job.line);
  return { model: MODELS[model], startMs, endMs, zones, jobs: reports, findings: all, counts };
}

/** "02:00 → 03:00", or with dates when the change crosses midnight. */
export function changeText(t: Transition): string {
  const db = fmtDate(t.localBefore);
  const da = fmtDate(t.localAfter);
  if (db === da) return `${fmtTime(t.localBefore)} → ${fmtTime(t.localAfter)}`;
  return `${db} ${fmtTime(t.localBefore)} → ${da} ${fmtTime(t.localAfter)}`;
}

/** Calendar date the affected local hour falls on. */
export function affectedDate(t: Transition): string {
  return fmtDate(t.delta > 0 ? t.localBefore : t.localAfter);
}

export function describeTransition(t: Transition): string {
  const dir = t.delta > 0 ? "forward" : "back";
  const names = t.nameBefore && t.nameAfter && t.nameBefore !== t.nameAfter ? ` (${t.nameBefore} → ${t.nameAfter})` : "";
  const sameDay = fmtDate(t.localBefore) === fmtDate(t.localAfter);
  return `${sameDay ? `${affectedDate(t)}: ` : ""}${changeText(t)}, clocks ${dir} ${fmtDelta(t.delta)}${names}`;
}
