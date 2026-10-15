import { describe, expect, it } from "vitest";
import { audit } from "../src/lib/audit";
import { parseCrontab } from "../src/lib/cron";
import { effectCounts, explainSuggestion, jobEffects, representativeTime, utcPeriods } from "../src/lib/effects";
import { findTransitions, isValidZone } from "../src/lib/tz";

const START = Date.UTC(2026, 9, 15);
const END = Date.UTC(2028, 0, 1);
const jobs = (t: string) => parseCrontab(t, isValidZone).jobs;

describe("effect classification for the workspace", () => {
  it("separates skipped, repeated, delayed, handled, UTC shift and none", () => {
    const text = "30 2 * * * a\n30 1 * * * b\n0 9 * * 1-5 c\n*/15 * * * * d";
    const vix = audit(jobs(text), "America/New_York", "vixie", START, END);
    const t = vix.zones["America/New_York"]!;
    expect(jobEffects(vix.jobs[0]!, t)).toEqual(["delayed", "utc"]);
    expect(jobEffects(vix.jobs[1]!, t)).toEqual(["handled", "utc"]);
    expect(jobEffects(vix.jobs[2]!, t)).toEqual(["utc"]);
    expect(jobEffects(vix.jobs[3]!, t)).toEqual(["skipped", "repeated"]);
    const lit = audit(jobs(text), "America/New_York", "literal", START, END);
    expect(jobEffects(lit.jobs[1]!, t)).toEqual(["repeated", "utc"]);
    expect(effectCounts(lit.jobs, lit.zones)).toMatchObject({ skipped: 2, repeated: 2, utc: 3, none: 0 });
  });

  it("a zone without DST gives no effect at all", () => {
    const r = audit(jobs("30 2 * * * a"), "Asia/Karachi", "literal", START, END);
    expect(jobEffects(r.jobs[0]!, [])).toEqual(["none"]);
  });

  it("maps a fixed local time to UTC in each offset period", () => {
    const t = findTransitions("America/New_York", START, END);
    const p = utcPeriods(9, 0, -240, t);
    expect(p.map((x) => x.utc)).toEqual(["13:00", "14:00", "13:00", "14:00"]);
    const late = utcPeriods(22, 30, -240, t);
    expect(late[0]).toMatchObject({ utc: "02:30", dayShift: 1 });
  });

  it("explains a suggested change as a change to the everyday timing", () => {
    const r = audit(jobs("30 2 * * * backup"), "America/New_York", "literal", START, END);
    const text = explainSuggestion(r.jobs[0]!)!;
    expect(text).toContain("from 02:30 to 03:30 local time on every day");
    expect(text).toContain("Confirm the new time");
    expect(representativeTime(r.jobs[0]!)).toEqual({ h: 2, mi: 30 });
  });
});
