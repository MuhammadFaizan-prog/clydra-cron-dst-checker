// Time-zone math on top of the browser's own IANA database (Intl).
// No library: offsets are read with Intl.DateTimeFormat and transitions are
// located by sampling + binary search to the minute.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    fmtCache.set(zone, f);
  }
  return f;
}

export function isValidZone(zone: string): boolean {
  if (!zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export interface WallClock {
  y: number;
  mon: number;
  d: number;
  h: number;
  mi: number;
}

export function wallClock(ms: number, zone: string): WallClock {
  const parts = formatter(zone).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), mon: get("month"), d: get("day"), h: get("hour") % 24, mi: get("minute") };
}

/** UTC offset in minutes at an instant (east positive), e.g. New York in winter = -300. */
export function offsetMinutes(ms: number, zone: string): number {
  const parts = formatter(zone).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  const floored = Math.floor(ms / 1000) * 1000;
  return Math.round((asUtc - floored) / MINUTE);
}

export function shortZoneName(ms: number, zone: string): string {
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" }).formatToParts(new Date(ms));
    return p.find((x) => x.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

export interface Transition {
  /** First instant (ms) at which the new offset applies. */
  at: number;
  offsetBefore: number;
  offsetAfter: number;
  /** offsetAfter - offsetBefore in minutes; >0 = clocks forward (gap), <0 = back (overlap). */
  delta: number;
  /** Local wall-clock time just before the change (in the old offset), e.g. 02:00. */
  localBefore: WallClock;
  /** Local wall-clock time right after the change (in the new offset), e.g. 03:00. */
  localAfter: WallClock;
  nameBefore: string;
  nameAfter: string;
}

/**
 * All offset changes in [startMs, endMs). Samples every 6 hours (every real-world
 * DST rule keeps offsets for months, so no change can hide between samples) and
 * binary-searches each change to the exact minute.
 */
export function findTransitions(zone: string, startMs: number, endMs: number): Transition[] {
  const out: Transition[] = [];
  const stepMs = 6 * HOUR;
  let prevT = startMs;
  let prevOff = offsetMinutes(prevT, zone);
  for (let t = startMs + stepMs; t <= endMs + stepMs; t += stepMs) {
    const off = offsetMinutes(t, zone);
    if (off !== prevOff) {
      let lo = prevT; // offset == prevOff
      let hi = t; // offset == off (or something else)
      while (hi - lo > MINUTE) {
        const mid = Math.floor((lo + hi) / 2 / MINUTE) * MINUTE;
        if (mid <= lo || mid >= hi) break;
        if (offsetMinutes(mid, zone) === prevOff) lo = mid;
        else hi = mid;
      }
      const at = hi;
      if (at >= startMs && at < endMs) {
        const offAfter = offsetMinutes(at, zone);
        out.push({
          at,
          offsetBefore: prevOff,
          offsetAfter: offAfter,
          delta: offAfter - prevOff,
          localBefore: shiftWall(at, prevOff),
          localAfter: shiftWall(at, offAfter),
          nameBefore: shortZoneName(at - MINUTE, zone),
          nameAfter: shortZoneName(at, zone),
        });
      }
      prevOff = offsetMinutes(t, zone);
    }
    prevT = t;
  }
  return out;
}

/** Wall clock of instant ms under a fixed offset (minutes). */
export function shiftWall(ms: number, offset: number): WallClock {
  const d = new Date(ms + offset * MINUTE);
  return { y: d.getUTCFullYear(), mon: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function fmtTime(w: Pick<WallClock, "h" | "mi">): string {
  return `${pad2(w.h)}:${pad2(w.mi)}`;
}

export function fmtDate(w: Pick<WallClock, "y" | "mon" | "d">): string {
  return `${w.y}-${pad2(w.mon)}-${pad2(w.d)}`;
}

export function fmtOffset(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return `UTC${sign}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}

export function fmtDelta(min: number): string {
  const a = Math.abs(min);
  const h = Math.floor(a / 60);
  const m = a % 60;
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} hour${h > 1 ? "s" : ""}`;
  return `${m} minutes`;
}

/** Every IANA zone the browser knows, with a fallback list for older engines. */
export function supportedZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  try {
    const list = intl.supportedValuesOf?.("timeZone");
    if (list && list.length) return list.includes("UTC") ? list : [...list, "UTC"];
  } catch {
    /* fall through */
  }
  return ["UTC", "Europe/London", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Los_Angeles", "America/Santiago", "Australia/Sydney", "Australia/Lord_Howe", "Asia/Karachi"];
}
