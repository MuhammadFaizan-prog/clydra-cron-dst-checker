import { describe, expect, it } from "vitest";
import { CronError, matches, parseCron, parseCrontab } from "../src/lib/cron";
import { isValidZone } from "../src/lib/tz";

describe("parseCron", () => {
  it("parses lists, ranges, steps and names", () => {
    const s = parseCron("*/15 9-17 * JAN,jul MON-FRI");
    expect([...s.minute.values]).toEqual([0, 15, 30, 45]);
    expect(s.hour.values.size).toBe(9);
    expect([...s.month.values]).toEqual([1, 7]);
    expect([...s.dow.values]).toEqual([1, 2, 3, 4, 5]);
    expect(s.fixedTime).toBe(false); // minute contains *
  });

  it("treats 7 as Sunday and supports n/step", () => {
    expect([...parseCron("0 0 * * 7").dow.values]).toEqual([0]);
    expect([...parseCron("5/20 * * * *").minute.values]).toEqual([5, 25, 45]);
  });

  it("marks fixed-time jobs the way Vixie cron does", () => {
    expect(parseCron("30 2 * * *").fixedTime).toBe(true);
    expect(parseCron("0,30 1-3 * * *").fixedTime).toBe(true);
    expect(parseCron("0 * * * *").fixedTime).toBe(false);
    expect(parseCron("@hourly").fixedTime).toBe(false);
    expect(parseCron("@daily").fixedTime).toBe(true);
  });

  it("rejects bad input with a helpful message", () => {
    expect(() => parseCron("")).toThrow(CronError);
    expect(() => parseCron("61 * * * *")).toThrow(/outside 0-59/);
    expect(() => parseCron("0 0 * * * *")).toThrow(/6 fields/);
    expect(() => parseCron("0 5-2 * * *")).toThrow(/backwards/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/positive/);
    expect(() => parseCron("@reboot")).toThrow(/startup/);
    expect(() => parseCron("@sometimes")).toThrow(/Unknown macro/);
    expect(() => parseCron("0 0 * FOO *")).toThrow(/month/);
  });
});

describe("matches (day-of-month / day-of-week rule)", () => {
  it("ANDs when one day field is *", () => {
    const s = parseCron("0 9 * * 1"); // Mondays
    expect(matches(s, 2027, 3, 15, 9, 0)).toBe(true); // Mon 15 Mar 2027
    expect(matches(s, 2027, 3, 16, 9, 0)).toBe(false);
  });
  it("ORs when both day fields are restricted", () => {
    const s = parseCron("0 9 1 * 1"); // 1st of month OR Monday
    expect(matches(s, 2027, 3, 1, 9, 0)).toBe(true); // Monday 1 Mar
    expect(matches(s, 2027, 4, 1, 9, 0)).toBe(true); // Thu 1 Apr
    expect(matches(s, 2027, 4, 5, 9, 0)).toBe(true); // Monday
    expect(matches(s, 2027, 4, 6, 9, 0)).toBe(false);
  });
});

describe("parseCrontab", () => {
  const text = [
    "# nightly jobs",
    "MAILTO=ops@example.com",
    "SHELL=/bin/bash",
    "30 2 * * * /usr/local/bin/backup.sh",
    "CRON_TZ=America/Santiago",
    "@daily /opt/report.sh --full",
    "CRON_TZ=Mars/Olympus",
    "0 25 * * * broken",
    "15 1",
    "",
  ].join("\n");
  const r = parseCrontab(text, isValidZone);

  it("finds jobs, keeps commands and applies CRON_TZ", () => {
    expect(r.jobs).toHaveLength(2);
    expect(r.jobs[0]!.command).toBe("/usr/local/bin/backup.sh");
    expect(r.jobs[0]!.timeZone).toBeNull();
    expect(r.jobs[1]!.timeZone).toBe("America/Santiago");
    expect(r.jobs[1]!.line).toBe(6);
  });

  it("reports bad lines with line numbers instead of failing", () => {
    expect(r.issues.map((i) => i.line)).toEqual([7, 8, 9]);
    expect(r.issues[0]!.message).toMatch(/CRON_TZ/);
    expect(r.issues[1]!.message).toMatch(/hour value 25/);
    expect(r.issues[2]!.message).toMatch(/Only 2 fields/);
  });
});
