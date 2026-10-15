import "./styles/base.css";
import "./styles/landing.css";
import { audit, MODELS, outcomeFor, type AuditResult, type ModelId } from "./lib/audit";
import { parseCrontab } from "./lib/cron";
import { explainSuggestion } from "./lib/effects";
import { fmtDelta, isValidZone, type Transition } from "./lib/tz";
import {
  EXAMPLE,
  OUTCOME_EFFECT,
  SAMPLE_ZONE,
  effectTag,
  applyPositions,
  escapeHtml,
  nightOf,
  renderNight,
  shortDate,
  type NightLane,
} from "./ui/shared";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// Mobile navigation
const menuBtn = $<HTMLButtonElement>("menu-btn");
const nav = $<HTMLElement>("site-nav");
menuBtn.addEventListener("click", () => {
  const open = menuBtn.getAttribute("aria-expanded") !== "true";
  menuBtn.setAttribute("aria-expanded", String(open));
  nav.classList.toggle("open", open);
});
nav.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("a")) {
    menuBtn.setAttribute("aria-expanded", "false");
    nav.classList.remove("open");
  }
});

const parsed = parseCrontab(EXAMPLE, isValidZone);
const start = Math.floor(Date.now() / 60_000) * 60_000;
const end = start + 2 * 365.25 * 86_400_000;
const run = (m: ModelId) => audit(parsed.jobs, SAMPLE_ZONE, m, start, end);

function cmdName(cmd: string): string {
  const base = cmd.split(/\s+/)[0] ?? "";
  return base.split("/").pop() ?? base;
}

function lanesFor(r: AuditResult, t: Transition): NightLane[] {
  const lanes: NightLane[] = [];
  for (const rep of r.jobs) {
    for (const f of rep.findings) {
      if (f.transition.at !== t.at) continue;
      lanes.push({ label: rep.job.schedule.source, sublabel: cmdName(rep.job.command), times: f.times, outcome: f.outcome, fixed: rep.job.schedule.fixedTime });
    }
  }
  return lanes;
}

function renderPreview(model: ModelId) {
  const r = run(model);
  const ts = r.zones[SAMPLE_ZONE] ?? [];
  const back = ts.find((t) => t.delta < 0);
  const fwd = ts.find((t) => t.delta > 0);
  const nights = [back, fwd]
    .filter((t): t is Transition => !!t)
    .sort((a, b) => a.at - b.at)
    .map((t) => renderNight(t, lanesFor(r, t)));
  $<HTMLDivElement>("pv-nights").innerHTML = nights.join("") || `<p>No clock changes found for ${SAMPLE_ZONE} in your browser's data.</p>`;
  applyPositions($<HTMLDivElement>("pv-nights"));
}

document.querySelectorAll<HTMLInputElement>("input[name=pv-model]").forEach((el) =>
  el.addEventListener("change", () => renderPreview(el.value as ModelId)),
);
renderPreview("vixie");

// "What you get back": matrix of jobs x clock changes, real output.
function renderMatrix() {
  const r = run("vixie");
  const groups = new Map<string, typeof r.jobs>();
  for (const rep of r.jobs) groups.set(rep.zone, [...(groups.get(rep.zone) ?? []), rep]);
  const html: string[] = [];
  for (const [zone, reps] of groups) {
    const ts = r.zones[zone] ?? [];
    const head = ts
      .map((t) => `<th scope="col"><span class="mx-date">${shortDate(nightOf(t))}</span><span class="mx-dir">${t.delta > 0 ? "forward" : "back"} ${fmtDelta(t.delta)}</span></th>`)
      .join("");
    const rows = reps
      .map((rep) => {
        const cells = ts
          .map((t) => {
            const fs = rep.findings.filter((f) => f.transition.at === t.at);
            if (fs.length) return `<td>${fs.map((f) => effectTag(OUTCOME_EFFECT[f.outcome])).join(" ")}</td>`;
            if (rep.job.schedule.fixedTime) return `<td class="mx-quiet">on time · UTC ${t.delta > 0 ? "−" : "+"}${fmtDelta(t.delta)}</td>`;
            return `<td class="mx-quiet">no change</td>`;
          })
          .join("");
        return `<tr><th scope="row"><code>${escapeHtml(rep.job.schedule.source)}</code><span>${escapeHtml(cmdName(rep.job.command))}</span></th>${cells}</tr>`;
      })
      .join("");
    html.push(`<div class="mx-block">
      <h3 class="mx-zone"><span class="mono">${escapeHtml(zone)}</span>${zone === SAMPLE_ZONE ? " · scheduler zone" : " · from CRON_TZ"}</h3>
      <div class="mx-scroll" tabindex="0" role="region" aria-label="Clock changes in ${escapeHtml(zone)} against each job">
        <table class="mx"><thead><tr><th scope="col">Job</th>${head}</tr></thead><tbody>${rows}</tbody></table>
      </div></div>`);
  }
  $<HTMLDivElement>("ex-matrix").innerHTML = html.join("");

  // Three notes drawn from the same result.
  const notes: string[] = [];
  const backup = r.jobs.find((j) => j.job.schedule.source === "30 2 * * *");
  const bf = backup?.findings.find((f) => f.kind === "gap");
  if (backup && bf) {
    notes.push(`<li><h3>A late run, not a missed one</h3><p>${escapeHtml(bf.summary)} Kubernetes-style schedulers would skip it instead.</p>
      ${backup.suggestion ? `<p class="note-fix">Suggested: <code>${escapeHtml(backup.suggestion)}</code>. ${escapeHtml(explainSuggestion(backup) ?? "")}</p>` : ""}</li>`);
  }
  const inv = r.jobs.find((j) => j.job.schedule.source === "30 1 * * *");
  const inf = inv?.findings[0];
  if (inf) {
    notes.push(`<li><h3>The scheduler decides the outcome</h3><p>${escapeHtml(inf.summary)} Under a literal wall-clock scheduler such as a Kubernetes CronJob, the invoices would go out twice. Switch the scheduler in the preview above to see it.</p></li>`);
  }
  const sales = r.jobs.find((j) => j.job.timeZone === "America/Santiago");
  const sf = sales?.findings.find((f) => f.kind === "gap") ?? sales?.findings[0];
  if (sf) {
    notes.push(`<li><h3>Each line in its own zone</h3><p>The <span class="mono">CRON_TZ=America/Santiago</span> line gets Santiago's dates, where clocks change at midnight. ${escapeHtml(sf.summary)}</p></li>`);
  }
  $<HTMLOListElement>("ex-notes").innerHTML = notes.join("");
  $<HTMLPreElement>("ex-crontab").textContent = EXAMPLE;
}
renderMatrix();

// Scheduler behaviour table, straight from outcomeFor().
const OUT_TEXT = { skipped: "Skipped that day", late: "Runs right after the jump", twice: "Runs twice", once: "Runs once" } as const;
$<HTMLTableSectionElement>("model-table").querySelector("tbody")!.innerHTML = (Object.keys(MODELS) as ModelId[])
  .map((id) => {
    const m = MODELS[id];
    const g = outcomeFor(id, "gap", true);
    const o = outcomeFor(id, "overlap", true);
    return `<tr><th scope="row">${escapeHtml(m.label)}<span>${escapeHtml(m.examples)}</span></th>
      <td>${effectTag(OUTCOME_EFFECT[g], OUT_TEXT[g])}</td><td>${effectTag(OUTCOME_EFFECT[o], OUT_TEXT[o])}</td>
      <td><a href="${m.sourceUrl}" target="_blank" rel="noopener">${escapeHtml(new URL(m.sourceUrl).hostname)}</a></td></tr>`;
  })
  .join("");
