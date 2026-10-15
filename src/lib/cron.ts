// Cron expression + crontab parsing (Vixie/cronie 5-field dialect).
// Pure functions, no dependencies, no I/O.

export interface CronField {
  values: Set<number>;
  /** true when the field text starts with "*" (matters for DOM/DOW OR rule). */
  star: boolean;
  /** true when the raw field contains "*" anywhere (e.g. "*" or "* /15"). */
  hasStar: boolean;
}

export interface CronSchedule {
  source: string; // expression as written (after macro expansion note)
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
  /**
   * "Fixed-time" in the sense of Vixie/ISC cron's DST rule: neither the
   * minute nor the hour field contains "*" and the job isn't @hourly.
   */
  fixedTime: boolean;
}

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
  namesBase?: number;
}

const SPECS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, namesBase: 1 },
  { name: "day of week", min: 0, max: 7, names: DAYS, namesBase: 0 },
];

function parseNumber(token: string, spec: FieldSpec): number {
  const upper = token.toUpperCase();
  if (spec.names) {
    const idx = spec.names.indexOf(upper);
    if (idx >= 0) return idx + (spec.namesBase ?? 0);
  }
  if (!/^\d+$/.test(token)) {
    throw new CronError(`"${token}" isn't a valid ${spec.name} value.`);
  }
  const n = Number(token);
  if (n < spec.min || n > spec.max) {
    throw new CronError(`${spec.name} value ${n} is outside ${spec.min}-${spec.max}.`);
  }
  return n;
}

export function parseField(text: string, spec: FieldSpec): CronField {
  if (text === "") throw new CronError(`The ${spec.name} field is empty.`);
  const values = new Set<number>();
  for (const part of text.split(",")) {
    if (part === "") throw new CronError(`The ${spec.name} field has an empty list item.`);
    const [rangePart, stepPart, extra] = part.split("/");
    if (extra !== undefined) throw new CronError(`"${part}" has more than one "/".`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) === 0) {
        throw new CronError(`Step "/${stepPart}" in the ${spec.name} field must be a positive number.`);
      }
      step = Number(stepPart);
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = spec.min;
      hi = spec.name === "day of week" ? 6 : spec.max;
    } else if (rangePart !== undefined && rangePart.includes("-")) {
      const [a, b, more] = rangePart.split("-");
      if (more !== undefined || a === undefined || b === undefined || a === "" || b === "") {
        throw new CronError(`"${rangePart}" isn't a valid range.`);
      }
      lo = parseNumber(a, spec);
      hi = parseNumber(b, spec);
      if (hi < lo) throw new CronError(`Range "${rangePart}" runs backwards; write the smaller value first.`);
    } else {
      lo = parseNumber(rangePart ?? "", spec);
      hi = stepPart !== undefined ? (spec.name === "day of week" ? 6 : spec.max) : lo;
    }
    for (let v = lo; v <= hi; v += step) values.add(spec.name === "day of week" && v === 7 ? 0 : v);
  }
  return { values, star: text.startsWith("*"), hasStar: text.includes("*") };
}

/** Parse a 5-field expression or a macro such as @daily. */
export function parseCron(expr: string): CronSchedule {
  const trimmed = expr.trim();
  if (trimmed === "") throw new CronError("Enter a cron expression.");
  const lower = trimmed.toLowerCase();
  if (lower === "@reboot") throw new CronError("@reboot runs at startup and has no clock schedule, so DST can't affect it.");
  let body = trimmed;
  let hourlyMacro = false;
  if (lower.startsWith("@")) {
    const m = MACROS[lower];
    if (!m) throw new CronError(`Unknown macro "${trimmed}". Supported: ${Object.keys(MACROS).join(", ")}, @reboot.`);
    body = m;
    hourlyMacro = lower === "@hourly";
  }
  const fields = body.split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError(
      fields.length === 6
        ? "That has 6 fields. This tool reads standard 5-field cron (minute hour day month weekday); Quartz-style seconds fields aren't supported."
        : `A cron expression needs 5 fields (minute hour day month weekday); this has ${fields.length}.`,
    );
  }
  const [mi, ho, dm, mo, dw] = fields.map((f, i) => parseField(f, SPECS[i]!)) as [CronField, CronField, CronField, CronField, CronField];
  return {
    source: trimmed,
    minute: mi,
    hour: ho,
    dom: dm,
    month: mo,
    dow: dw,
    fixedTime: !hourlyMacro && !mi.hasStar && !ho.hasStar,
  };
}

/** Does the schedule fire at this local wall-clock minute? */
export function matches(s: CronSchedule, y: number, mon: number, d: number, h: number, mi: number): boolean {
  if (!s.minute.values.has(mi) || !s.hour.values.has(h) || !s.month.values.has(mon)) return false;
  const dow = new Date(Date.UTC(y, mon - 1, d)).getUTCDay();
  const domOk = s.dom.values.has(d);
  const dowOk = s.dow.values.has(dow);
  // Vixie rule: if either day field is unrestricted ("*..."), both must match (AND);
  // if both are restricted, either may match (OR).
  if (s.dom.star || s.dow.star) return domOk && dowOk;
  return domOk || dowOk;
}

export interface CrontabJob {
  line: number; // 1-based line number in the pasted text
  schedule: CronSchedule;
  command: string;
  timeZone: string | null; // from a preceding CRON_TZ= line, if any
}

export interface CrontabIssue {
  line: number;
  text: string;
  message: string;
}

export interface CrontabParse {
  jobs: CrontabJob[];
  issues: CrontabIssue[];
  skipped: number; // comments, blanks, env assignments
}

const ENV_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/**
 * Parse a pasted crontab (user or system format) or a list of bare expressions.
 * Supports comments, blank lines, VAR=value lines and CRON_TZ=Zone (cronie).
 */
export function parseCrontab(text: string, isValidZone: (z: string) => boolean): CrontabParse {
  const jobs: CrontabJob[] = [];
  const issues: CrontabIssue[] = [];
  let skipped = 0;
  let cronTz: string | null = null;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      skipped++;
      return;
    }
    const env = ENV_RE.exec(line);
    if (env && !line.startsWith("@")) {
      const name = env[1]!;
      const value = env[2]!.replace(/^["']|["']$/g, "").trim();
      if (name === "CRON_TZ") {
        if (value === "") cronTz = null;
        else if (isValidZone(value)) cronTz = value;
        else issues.push({ line: lineNo, text: line, message: `CRON_TZ "${value}" isn't a time zone this browser knows. Use an IANA name like Europe/London.` });
      }
      skipped++;
      return;
    }
    const parts = line.split(/\s+/);
    const isMacro = parts[0]!.startsWith("@");
    const exprParts = isMacro ? parts.slice(0, 1) : parts.slice(0, 5);
    const command = (isMacro ? parts.slice(1) : parts.slice(5)).join(" ");
    try {
      if (!isMacro && parts.length < 5) {
        throw new CronError(`Only ${parts.length} field${parts.length === 1 ? "" : "s"} found; a schedule needs 5.`);
      }
      const schedule = parseCron(exprParts.join(" "));
      jobs.push({ line: lineNo, schedule, command, timeZone: cronTz });
    } catch (e) {
      issues.push({ line: lineNo, text: line, message: e instanceof Error ? e.message : String(e) });
    }
  });
  return { jobs, issues, skipped };
}
