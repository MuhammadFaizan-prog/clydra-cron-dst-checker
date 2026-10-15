import type { AuditResult } from "./audit";
import { describeTransition } from "./audit";
import { fmtTime } from "./tz";

const OUTCOME_TEXT = { skipped: "skipped", late: "runs late", twice: "runs twice", once: "runs once" } as const;

function csvCell(v: string): string {
  // Neutralise spreadsheet formula injection and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(r: AuditResult): string {
  const head = ["line", "schedule", "command", "time_zone", "clock_change", "kind", "affected_local_times", "outcome", "severity", "scheduler_model", "suggested_schedule"];
  const rows = [head.join(",")];
  for (const f of r.findings) {
    const rep = r.jobs.find((j) => j.job === f.job);
    rows.push(
      [
        String(f.job.line),
        f.job.schedule.source,
        f.job.command,
        f.zone,
        describeTransition(f.transition),
        f.kind,
        f.times.map(fmtTime).join(" "),
        OUTCOME_TEXT[f.outcome],
        f.severity,
        r.model.label,
        rep?.suggestion ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return rows.join("\n") + "\n";
}

function mdCell(v: string): string {
  return v.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function toMarkdown(r: AuditResult): string {
  const lines = [
    `| Line | Schedule | Zone | Clock change | Times | Outcome (${mdCell(r.model.label)}) | Suggested |`,
    "|---|---|---|---|---|---|---|",
  ];
  for (const f of r.findings) {
    const rep = r.jobs.find((j) => j.job === f.job);
    lines.push(
      `| ${f.job.line} | \`${mdCell(f.job.schedule.source)}\` | ${f.zone} | ${mdCell(describeTransition(f.transition))} | ${f.times.map(fmtTime).join(", ")} | ${OUTCOME_TEXT[f.outcome]} (${f.severity}) | ${rep?.suggestion ? `\`${mdCell(rep.suggestion)}\`` : ""} |`,
    );
  }
  if (r.findings.length === 0) lines.push("| – | – | – | No schedule falls in a skipped or repeated hour in this period | – | – | – |");
  return lines.join("\n") + "\n";
}
