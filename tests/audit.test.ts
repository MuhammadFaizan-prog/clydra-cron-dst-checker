import { describe, expect, it } from "vitest";
import { audit, describeTransition, outcomeFor, suggestHours } from "../src/lib/audit";
import { parseCrontab } from "../src/lib/cron";
import { toCsv, toMarkdown } from "../src/lib/export";
import { findTransitions, isValidZone, offsetMinutes } from "../src/lib/tz";

// Fixed window so results don't depend on the day the tests run.
const START = Date.UTC(2026, 9, 15); // 2026-10-15
const END = Date.UTC(2028, 0, 1);

const jobs = (t: string) => parseCrontab(t, isValidZone).jobs;

describe("time-zone transitions come from the real tz database", () => {
  it("New York: US rules, 02:00 local", () => {
    const t = findTransitions("America/New_York", START, END).map(describeTransition);
    expect(t).toEqual([
      "2026-11-01: 02:00 → 01:00, clocks back 1 hour (EDT → EST)",
      "2027-03-14: 02:00 → 03:00, clocks forward 1 hour (EST → EDT)",
      "2027-11-07: 02:00 → 01:00, clocks back 1 hour (EDT → EST)",
    ]);
  });

  it("London changes at 01:00 GMT, not 02:00 everywhere", () => {
    const spring = findTransitions("Europe/London", START, END)[1]!;
    expect(describeTransition(spring)).toMatch(/^2027-03-28: 01:00 → 02:00/);
  });

  it("Santiago changes at midnight", () => {
    const t = findTransitions("America/Santiago", START, END);
    expect(t.map(describeTransition)).toContain("2027-09-05: 00:00 → 01:00, clocks forward 1 hour (GMT-4 → GMT-3)");
    expect(t.map(describeTransition)).toContain("2027-04-04 00:00 → 2027-04-03 23:00, clocks back 1 hour (GMT-3 → GMT-4)");
  });

  it("Lord Howe shifts by 30 minutes", () => {
    const t = findTransitions("Australia/Lord_Howe", START, END);
    expect(t.every((x) => Math.abs(x.delta) === 30)).toBe(true);
  });

  it("zones without DST have no transitions", () => {
    expect(findTransitions("Asia/Karachi", START, END)).toEqual([]);
    expect(findTransitions("UTC", START, END)).toEqual([]);
  });

  it("offsets are read correctly", () => {
    expect(offsetMinutes(Date.UTC(2027, 0, 15), "America/New_York")).toBe(-300);
    expect(offsetMinutes(Date.UTC(2027, 6, 15), "America/New_York")).toBe(-240);
    expect(offsetMinutes(Date.UTC(2027, 0, 15), "Asia/Kolkata")).toBe(330);
  });
});

describe("scheduler models", () => {
  it("maps gap/overlap to outcomes per documented behaviour", () => {
    expect(outcomeFor("vixie", "gap", true)).toBe("late");
    expect(outcomeFor("vixie", "gap", false)).toBe("skipped");
    expect(outcomeFor("vixie", "overlap", true)).toBe("once");
    expect(outcomeFor("vixie", "overlap", false)).toBe("twice");
    expect(outcomeFor("literal", "gap", true)).toBe("skipped");
    expect(outcomeFor("literal", "overlap", true)).toBe("twice");
    expect(outcomeFor("quartz", "gap", true)).toBe("skipped");
    expect(outcomeFor("quartz", "overlap", true)).toBe("once");
  });
});

describe("audit", () => {
  it("a 02:30 backup in New York is skipped in March but untouched in November", () => {
    const r = audit(jobs("30 2 * * * backup"), "America/New_York", "literal", START, END);
    const f = r.findings;
    // Spring: 02:30 doesn't exist on 2027-03-14. Fall: the repeated hour is 01:00-01:59, so 02:30 is untouched.
    expect(f).toHaveLength(1);
    expect(f[0]!.kind).toBe("gap");
    expect(f[0]!.outcome).toBe("skipped");
    expect(f[0]!.severity).toBe("high");
    expect(f[0]!.summary).toMatch(/2027-03-14/);
    expect(r.jobs[0]!.suggestion).toBe("30 3 * * *");
  });

  it("a 01:30 job in New York runs twice under literal schedulers, once under Vixie cron", () => {
    const lit = audit(jobs("30 1 * * * report"), "America/New_York", "literal", START, END);
    expect(lit.findings.map((f) => f.outcome)).toEqual(["twice", "twice"]);
    const vix = audit(jobs("30 1 * * * report"), "America/New_York", "vixie", START, END);
    expect(vix.findings.map((f) => f.outcome)).toEqual(["once", "once"]);
    expect(vix.jobs[0]!.worst).toBe("ok");
    expect(vix.jobs[0]!.suggestion).toBeNull();
  });

  it("@daily in Santiago is hit by the midnight spring-forward", () => {
    const r = audit(jobs("@daily /opt/report.sh"), "America/Santiago", "literal", START, END);
    const gap = r.findings.find((f) => f.kind === "gap");
    expect(gap?.summary).toMatch(/00:00 → 01:00 on 2027-09-05: its 00:00 run doesn.t exist/);
    expect(gap?.outcome).toBe("skipped");
    expect(r.jobs[0]!.suggestion).toBe("0 1 * * *"); // 00:00 and 23:00 are both affected in Santiago
  });

  it("frequent jobs lose runs but are flagged low, not high", () => {
    const r = audit(jobs("*/10 * * * * poll"), "Europe/London", "vixie", START, END);
    const gap = r.findings.find((f) => f.kind === "gap")!;
    expect(gap.times).toHaveLength(6);
    expect(gap.severity).toBe("low");
    expect(r.jobs[0]!.suggestion).toBeNull();
  });

  it("CRON_TZ overrides the default zone per job", () => {
    const r = audit(jobs("CRON_TZ=Asia/Karachi\n30 2 * * * x"), "America/New_York", "literal", START, END);
    expect(r.jobs[0]!.zone).toBe("Asia/Karachi");
    expect(r.findings).toHaveLength(0);
  });

  it("weekday filters are respected (Sunday-only transitions vs a Mon-Fri job)", () => {
    const r = audit(jobs("30 2 * * 1-5 weekday"), "America/New_York", "literal", START, END);
    expect(r.findings).toHaveLength(0); // US changes happen on Sundays
  });

  it("suggestHours keeps unaffected hours and moves affected ones", () => {
    const [j] = jobs("0 2,14 * * * x");
    const t = findTransitions("America/New_York", START, END);
    expect(suggestHours(j!.schedule, t)).toBe("3,14");
  });

  it("exports CSV (formula-safe) and Markdown", () => {
    const r = audit(jobs("30 2 * * * =cmd,with,commas"), "America/New_York", "literal", START, END);
    const csv = toCsv(r);
    expect(csv.split("\n")[0]).toMatch(/^line,schedule,command/);
    expect(csv).toContain(`"'=cmd,with,commas"`);
    const md = toMarkdown(r);
    expect(md).toContain("| 1 | `30 2 * * *`");
    expect(md).toContain("`30 3 * * *`");
  });
});
