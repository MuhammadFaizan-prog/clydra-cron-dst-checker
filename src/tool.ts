import "./styles/base.css";
import "./styles/tool.css";
import { audit, MODELS, type AuditResult, type JobReport, type ModelId } from "./lib/audit";
import { parseCrontab, type CrontabIssue } from "./lib/cron";
import { toCsv, toMarkdown } from "./lib/export";
import { EFFECT_ORDER, effectCounts, explainSuggestion, jobEffects, representativeTime, utcPeriods } from "./lib/effects";
import { fmtDate, fmtDelta, fmtOffset, fmtTime, isValidZone, offsetMinutes, supportedZones, wallClock } from "./lib/tz";
import {
  EFFECT_META,
  EXAMPLE,
  OUTCOME_EFFECT,
  SAMPLE_ZONE,
  browserZone,
  effectTag,
  applyPositions,
  escapeHtml,
  nightOf,
  renderNight,
  shortDate,
  transitionHeadline,
} from "./ui/shared";

const MAX_CHARS = 200_000;
const MAX_JOBS = 500;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("form");
const crontab = $<HTMLTextAreaElement>("crontab");
const zoneInput = $<HTMLInputElement>("zone");
const yearsSel = $<HTMLSelectElement>("years");
const statusEl = $<HTMLSpanElement>("status");
const errorEl = $<HTMLDivElement>("error");
const crontabErr = $<HTMLParagraphElement>("crontab-error");
const zoneErr = $<HTMLParagraphElement>("zone-error");
const results = $<HTMLDivElement>("results");
const empty = $<HTMLDivElement>("empty");
const exportBar = $<HTMLDivElement>("export");
const copyStatus = $<HTMLSpanElement>("copy-status");
const outSub = $<HTMLSpanElement>("out-sub");
const parseLine = $<HTMLParagraphElement>("parse-line");
const jobsEl = $<HTMLUListElement>("jobs");
const inspector = $<HTMLDivElement>("inspector");
const findingsSec = $<HTMLElement>("findings");

interface State {
  result: AuditResult | null;
  issues: CrontabIssue[];
  zone: string;
  selected: { type: "job"; idx: number } | { type: "issue"; idx: number } | null;
  filter: { zone: string; at: number } | null;
}
const state: State = { result: null, issues: [], zone: "", selected: null, filter: null };

const model = (): ModelId => (document.querySelector<HTMLInputElement>("input[name=model]:checked")?.value ?? "vixie") as ModelId;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function setFieldError(el: HTMLParagraphElement, input: HTMLElement, msg: string | null) {
  el.hidden = !msg;
  el.textContent = msg ?? "";
  if (msg) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}
function showError(msg: string | null) {
  errorEl.hidden = !msg;
  errorEl.textContent = msg ?? "";
}

function fillZones() {
  const frag = document.createDocumentFragment();
  for (const z of supportedZones()) {
    const o = document.createElement("option");
    o.value = z;
    frag.appendChild(o);
  }
  $<HTMLDataListElement>("zones").appendChild(frag);
}

function updateModelHelp() {
  const m = MODELS[model()];
  $<HTMLElement>("model-help").innerHTML = `<b>${escapeHtml(m.label)}:</b> ${escapeHtml(m.rule)} <a href="${m.sourceUrl}" target="_blank" rel="noopener">Source</a>`;
}

function cmdName(cmd: string): string {
  const base = cmd.split(/\s+/)[0] ?? "";
  return base.split("/").pop() ?? base;
}

function resetOutput() {
  state.result = null;
  state.selected = null;
  state.filter = null;
  results.hidden = true;
  exportBar.hidden = true;
  empty.hidden = false;
  outSub.textContent = "Nothing checked yet";
  parseLine.textContent = "";
  statusEl.textContent = "";
}

// ---------- rendering ----------

function renderSummary(r: AuditResult) {
  const c = effectCounts(r.jobs, r.zones);
  const items = EFFECT_ORDER.map((e) => {
    const n = c[e];
    return `<div class="sum-item sum-${e}${n ? "" : " is-zero"}"><span class="sum-n">${n}</span>${effectTag(e)}</div>`;
  });
  if (state.issues.length) items.push(`<div class="sum-item sum-unsupported"><span class="sum-n">${state.issues.length}</span>${effectTag("unsupported")}</div>`);
  const gloss = [...EFFECT_ORDER, "unsupported" as const]
    .map((e) => `<div><dt>${effectTag(e, EFFECT_META[e].label)}</dt><dd>${escapeHtml(EFFECT_META[e].desc)}</dd></div>`)
    .join("");
  $<HTMLDivElement>("summary").innerHTML = `<p class="sum-cap">Jobs per effect. A job can appear under more than one.</p>
    <div class="sum-row">${items.join("")}</div>
    <details class="gloss"><summary>What each effect means</summary><dl>${gloss}</dl></details>`;
}

function renderIssues() {
  const el = $<HTMLDivElement>("issues");
  if (!state.issues.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `<div class="issues" role="note"><b>${plural(state.issues.length, "line")} not checked.</b> The rest of the crontab was audited. Select a line in the job list for the reason.</div>`;
}

function renderTimeline(r: AuditResult) {
  const span = r.endMs - r.startMs;
  const pct = (ms: number) => (((ms - r.startMs) / span) * 100).toFixed(3);
  const startW = wallClock(r.startMs, state.zone);
  const endW = wallClock(r.endMs, state.zone);
  const years: string[] = [];
  for (let y = startW.y + 1; y <= endW.y; y++) {
    const ms = Date.UTC(y, 0, 1);
    if (ms > r.startMs && ms < r.endMs) years.push(`<span class="yr" data-l="${pct(ms)}">${y}</span>`);
  }
  const zones = Object.keys(r.zones).sort((a, b) => (a === state.zone ? -1 : b === state.zone ? 1 : a.localeCompare(b)));
  const lanes = zones.map((z) => {
    const ts = r.zones[z] ?? [];
    const reps = r.jobs.filter((j) => j.zone === z);
    const src = z === state.zone ? "scheduler zone" : "CRON_TZ";
    if (!ts.length) {
      return `<div class="lane"><div class="lane-l"><span class="mono">${escapeHtml(z)}</span><span>${src} · ${plural(reps.length, "job")}</span></div>
        <div class="lane-empty">No clock changes between ${fmtDate(startW)} and ${fmtDate(endW)} under current rules, so daylight saving can't move these jobs.</div></div>`;
    }
    const marks = ts
      .map((t) => {
        const affected = reps.filter((j) => j.findings.some((f) => f.transition.at === t.at && f.outcome !== "once"));
        const checked = reps.filter((j) => j.findings.some((f) => f.transition.at === t.at));
        let worst: string = "none";
        for (const e of EFFECT_ORDER) {
          if (reps.some((j) => j.findings.some((f) => f.transition.at === t.at && OUTCOME_EFFECT[f.outcome] === e))) {
            worst = e;
            break;
          }
        }
        const sel = state.filter && state.filter.zone === z && state.filter.at === t.at;
        const n = nightOf(t);
        const label = `${shortDate(n)}, ${transitionHeadline(t)}. ${affected.length ? plural(affected.length, "job") + " affected" : checked.length ? "runs once, no change in run count" : "no job in the changed hour"}`;
        return `<button type="button" class="tm tm-${worst}${t.delta > 0 ? " tm-fwd" : " tm-back"}" data-l="${pct(t.at)}" data-zone="${escapeHtml(z)}" data-at="${t.at}" aria-pressed="${sel ? "true" : "false"}" aria-label="${escapeHtml(label)}">
          <span class="tm-dir" aria-hidden="true">${t.delta > 0 ? "▲" : "▼"}</span>
          <span class="tm-date">${shortDate(n, false)}<span class="tm-yr"> ${n.y}</span></span>
          <span class="tm-n">${affected.length ? plural(affected.length, "job") : "—"}</span>
        </button>`;
      })
      .join("");
    return `<div class="lane"><div class="lane-l"><span class="mono">${escapeHtml(z)}</span><span>${src} · ${plural(reps.length, "job")}</span></div>
      <div class="lane-t"><span class="axis" aria-hidden="true"></span>${years.join("")}${marks}</div></div>`;
  });
  $<HTMLDivElement>("timeline").innerHTML = `<div class="tl-range"><span>${fmtDate(startW)}</span><span>${fmtDate(endW)}</span></div>${lanes.join("")}
    <p class="tl-key"><span><span aria-hidden="true">▲</span> clocks forward (a gap)</span><span><span aria-hidden="true">▼</span> clocks back (an overlap)</span></p>`;
}

function visibleJobs(r: AuditResult): number[] {
  const idx = r.jobs.map((_, i) => i);
  const f = state.filter;
  if (!f) return idx;
  return idx.filter((i) => {
    const j = r.jobs[i]!;
    return j.zone === f.zone && j.findings.some((x) => x.transition.at === f.at);
  });
}

function renderJobs(r: AuditResult) {
  const vis = visibleJobs(r);
  const f = state.filter;
  const t = f ? r.zones[f.zone]?.find((x) => x.at === f.at) : undefined;
  $<HTMLElement>("jobs-title").textContent = t ? `Jobs in the changed hour on ${shortDate(nightOf(t))} (${f!.zone})` : `Jobs (${r.jobs.length})`;
  $<HTMLButtonElement>("show-all").hidden = !f;
  const rows = vis.map((i) => {
    const rep = r.jobs[i]!;
    const effects = jobEffects(rep, r.zones[rep.zone] ?? []);
    const sel = state.selected?.type === "job" && state.selected.idx === i;
    const tags = effects.map((e, k) => (k === 0 ? effectTag(e) : `<span class="tag-mini tag-${e}">${escapeHtml(EFFECT_META[e].short)}</span>`)).join("");
    return `<li><button type="button" class="job-row eff-${effects[0]}" data-job="${i}" aria-current="${sel ? "true" : "false"}">
      <span class="jr-line">L${rep.job.line}</span>
      <span class="jr-main"><code>${escapeHtml(rep.job.schedule.source)}</code><span class="jr-cmd">${escapeHtml(cmdName(rep.job.command) || "(no command)")}${rep.job.timeZone ? ` · ${escapeHtml(rep.job.timeZone)}` : ""}</span></span>
      <span class="jr-tags">${tags}</span>
    </button></li>`;
  });
  if (!f) {
    state.issues.forEach((iss, k) => {
      const sel = state.selected?.type === "issue" && state.selected.idx === k;
      rows.push(`<li><button type="button" class="job-row eff-unsupported" data-issue="${k}" aria-current="${sel ? "true" : "false"}">
        <span class="jr-line">L${iss.line}</span>
        <span class="jr-main"><code>${escapeHtml(iss.text.slice(0, 60))}</code><span class="jr-cmd">${escapeHtml(iss.message)}</span></span>
        <span class="jr-tags">${effectTag("unsupported")}</span></button></li>`);
    });
  }
  jobsEl.innerHTML = rows.join("") || `<li class="jr-none">No job lands in the changed hour that night.</li>`;
}

const FIELD_NAMES = ["minute", "hour", "day", "month", "weekday"];
function fieldChips(src: string): string {
  const parts = src.trim().split(/\s+/);
  if (parts.length !== 5) return "";
  return `<ol class="fields" aria-label="Expression fields">${parts
    .map((p, i) => `<li${i < 2 ? ' class="f-time"' : ""}><code>${escapeHtml(p)}</code><span>${FIELD_NAMES[i]}</span></li>`)
    .join("")}</ol>`;
}

function inspectJob(r: AuditResult, i: number) {
  const rep: JobReport = r.jobs[i]!;
  const ts = r.zones[rep.zone] ?? [];
  const effects = jobEffects(rep, ts);
  const s = rep.job.schedule;
  const f = state.filter;
  const findings = f && f.zone === rep.zone ? rep.findings.filter((x) => x.transition.at === f.at) : rep.findings;
  const parts: string[] = [];
  parts.push(`<div class="in-head">
    <p class="in-k">Line ${rep.job.line}</p>
    <h3><code>${escapeHtml(s.source)}</code></h3>
    ${rep.job.command ? `<p class="in-cmd">${escapeHtml(rep.job.command)}</p>` : ""}
    ${fieldChips(s.source)}
    <div class="in-tags">${effects.map((e) => effectTag(e)).join("")}</div>
  </div>
  <dl class="in-meta">
    <div><dt>Zone</dt><dd><span class="mono">${escapeHtml(rep.zone)}</span> ${rep.job.timeZone ? "from CRON_TZ" : "scheduler zone"}</dd></div>
    <div><dt>Scheduler</dt><dd>${escapeHtml(r.model.label)}</dd></div>
    <div><dt>Schedule type</dt><dd>${s.fixedTime ? "Fixed time (no * in minute or hour)" : "Frequent (* in minute or hour, or @hourly)"}</dd></div>
    <div><dt>Clock changes checked</dt><dd>${ts.length}</dd></div>
  </dl>`);

  if (findings.length) {
    parts.push(`<h4 class="in-sec">Evidence${f ? ` for ${shortDate(nightOf(r.zones[f.zone]!.find((x) => x.at === f.at)!))}` : ` · ${plural(findings.length, "night")}`}</h4>`);
    for (const fd of findings.slice(0, 12)) {
      const e = OUTCOME_EFFECT[fd.outcome];
      parts.push(`<article class="ev ev-${e}">
        <div class="ev-head"><span class="ev-date mono">${fmtDate(nightOf(fd.transition))}</span>${effectTag(e)}</div>
        <p class="ev-text">${escapeHtml(fd.summary)}</p>
        ${renderNight(fd.transition, [{ label: s.source, times: fd.times, outcome: fd.outcome, fixed: s.fixedTime }], { heading: false })}
      </article>`);
    }
    if (findings.length > 12) parts.push(`<p class="help">${findings.length - 12} more nights are in the CSV export.</p>`);
  } else if (!ts.length) {
    parts.push(`<p class="in-none">${effectTag("none")} ${escapeHtml(rep.zone)} has no clock changes in the checked period under current rules, so this job runs at the same local and UTC time throughout.</p>`);
  } else {
    parts.push(`<p class="in-none">${effectTag(s.fixedTime ? "utc" : "none")} This schedule never lands in a missing or repeated hour in the checked period.</p>`);
  }

  if (!s.fixedTime && rep.findings.some((x) => x.outcome !== "once")) {
    parts.push(`<p class="help">This job runs every hour or more often, so a missing or repeated hour only removes or adds a few runs that night.</p>`);
  }

  const rt = representativeTime(rep);
  if (rt && ts.length) {
    const startOff = ts[0]!.offsetBefore ?? offsetMinutes(r.startMs, rep.zone);
    const periods = utcPeriods(rt.h, rt.mi, startOff, ts);
    const rows = periods.slice(0, 6).map((p, k) => {
      const when = p.fromMs === null ? `Until ${fmtDate(nightOf(ts[0]!))}` : `From ${fmtDate(nightOf(ts[k - 1]!))}`;
      const day = p.dayShift === 1 ? " (next day)" : p.dayShift === -1 ? " (previous day)" : "";
      return `<tr><th scope="row">${when}</th><td class="mono">${fmtTime(rt)} local</td><td class="mono">${p.utc} UTC${day}</td><td class="mono">${fmtOffset(p.offset)}</td></tr>`;
    });
    parts.push(`<h4 class="in-sec">UTC timing of the ${fmtTime(rt)} run</h4>
      <div class="tbl-scroll"><table class="utc"><thead><tr><th scope="col">Period</th><th scope="col">Local</th><th scope="col">UTC</th><th scope="col">Offset</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
      ${periods.length > 6 ? `<p class="help">${periods.length - 6} more periods follow the same pattern.</p>` : ""}`);
  }

  if (rep.suggestion) {
    parts.push(`<div class="fix">
      <h4 class="in-sec">A schedule that avoids these nights</h4>
      <div class="fix-row"><code class="fix-code">${escapeHtml(rep.suggestion)}</code>
      <button type="button" class="btn btn-small btn-line" data-copy="${escapeHtml(rep.suggestion)}" aria-label="Copy suggested schedule ${escapeHtml(rep.suggestion)}">Copy</button></div>
      <p>${escapeHtml(explainSuggestion(rep) ?? "")}</p>
      <p class="help">Other options: make the job safe to run twice or late, or run the scheduler on UTC (then its local time moves by ${ts[0] ? fmtDelta(ts[0].delta) : "the offset change"} twice a year).</p>
    </div>`);
  } else if (rep.findings.some((x) => x.severity !== "ok") && s.fixedTime) {
    parts.push(`<p class="help">No single hour avoids every change in this zone for this schedule. Consider running it on UTC or making it safe to repeat.</p>`);
  }
  inspector.innerHTML = parts.join("");
}

function inspectIssue(k: number) {
  const iss = state.issues[k]!;
  inspector.innerHTML = `<div class="in-head"><p class="in-k">Line ${iss.line}</p><h3><code>${escapeHtml(iss.text.slice(0, 120))}</code></h3>
    <div class="in-tags">${effectTag("unsupported")}</div></div>
    <p class="ev-text">${escapeHtml(iss.message)}</p>
    <p class="help">This line was left out of every finding and export. The other lines were still checked.</p>
    <button type="button" class="btn btn-small btn-line" data-goto="${iss.line}">Select line ${iss.line} in the editor</button>`;
}

function renderInspector() {
  const r = state.result;
  if (!r) return;
  const sel = state.selected;
  if (sel?.type === "job" && r.jobs[sel.idx]) inspectJob(r, sel.idx);
  else if (sel?.type === "issue" && state.issues[sel.idx]) inspectIssue(sel.idx);
  else inspector.innerHTML = `<p class="help">Select a job to see its evidence.</p>`;
}

function defaultSelection(r: AuditResult): State["selected"] {
  // Most useful first view: a fixed-time job with a missed/duplicate run, then a late one, then anything affected.
  const tests: ((j: JobReport) => boolean)[] = [
    (j) => j.worst === "high" && j.job.schedule.fixedTime,
    (j) => j.worst === "medium",
    (j) => j.worst === "high",
    (j) => j.worst === "low",
  ];
  for (const t of tests) {
    const i = r.jobs.findIndex(t);
    if (i >= 0) return { type: "job", idx: i };
  }
  return r.jobs.length ? { type: "job", idx: 0 } : state.issues.length ? { type: "issue", idx: 0 } : null;
}

function renderAll() {
  const r = state.result;
  if (!r) return;
  renderSummary(r);
  renderIssues();
  renderTimeline(r);
  renderJobs(r);
  renderInspector();
  applyPositions(findingsSec);
}

// ---------- run ----------

function run(fromUser: boolean) {
  showError(null);
  copyStatus.textContent = "";
  const text = crontab.value;
  const zone = zoneInput.value.trim();
  if (!isValidZone(zone)) {
    setFieldError(zoneErr, zoneInput, `"${zone || "(empty)"}" isn't a time zone this browser recognises. Pick one from the list, e.g. America/New_York.`);
    if (fromUser) zoneInput.focus();
    return;
  }
  setFieldError(zoneErr, zoneInput, null);
  if (text.trim() === "") {
    resetOutput();
    state.issues = [];
    setFieldError(crontabErr, crontab, fromUser ? "Paste at least one cron line, or load the sample." : null);
    if (fromUser) crontab.focus();
    return;
  }
  if (text.length > MAX_CHARS) {
    setFieldError(crontabErr, crontab, `That's ${text.length.toLocaleString()} characters; the limit is ${MAX_CHARS.toLocaleString()}. Check one crontab at a time.`);
    return;
  }
  const parsed = parseCrontab(text, isValidZone);
  if (parsed.jobs.length > MAX_JOBS) {
    setFieldError(crontabErr, crontab, `Found ${parsed.jobs.length} jobs; the limit is ${MAX_JOBS} per check.`);
    return;
  }
  state.issues = parsed.issues;
  parseLine.textContent = `${plural(parsed.jobs.length, "job")} · ${plural(parsed.skipped, "comment or setting line")}${parsed.issues.length ? ` · ${plural(parsed.issues.length, "line")} not readable` : ""}`;
  if (parsed.jobs.length === 0) {
    state.result = null;
    results.hidden = true;
    exportBar.hidden = true;
    empty.hidden = false;
    outSub.textContent = "No jobs to check";
    setFieldError(
      crontabErr,
      crontab,
      parsed.issues.length
        ? `No valid cron lines found. Line ${parsed.issues[0]!.line}: ${parsed.issues[0]!.message}${parsed.issues.length > 1 ? ` (and ${parsed.issues.length - 1} more)` : ""}`
        : "No cron lines found; only comments or settings.",
    );
    return;
  }
  setFieldError(crontabErr, crontab, null);
  findingsSec.setAttribute("aria-busy", "true");
  statusEl.textContent = "Checking…";
  const t0 = performance.now();
  try {
    const start = Math.floor(Date.now() / 60_000) * 60_000;
    const end = start + Number(yearsSel.value) * 365.25 * 86_400_000;
    const prevSel = state.selected;
    state.result = audit(parsed.jobs, zone, model(), start, end);
    state.zone = zone;
    if (state.filter && !state.result.zones[state.filter.zone]?.some((t) => t.at === state.filter!.at)) state.filter = null;
    const keep = prevSel && ((prevSel.type === "job" && state.result.jobs[prevSel.idx]) || (prevSel.type === "issue" && state.issues[prevSel.idx]));
    state.selected = keep ? prevSel : defaultSelection(state.result);
    empty.hidden = true;
    results.hidden = false;
    exportBar.hidden = false;
    renderAll();
    const ms = Math.round(performance.now() - t0);
    const here = browserZone();
    outSub.textContent = `${plural(parsed.jobs.length, "job")} · ${MODELS[model()].label} · ${fmtDate(wallClock(start, here))} to ${fmtDate(wallClock(end, here))}`;
    statusEl.textContent = `Checked in ${ms} ms.`;
  } catch (e) {
    console.error(e);
    showError("Something went wrong while checking these schedules. Try a simpler crontab, or report the line that caused it.");
  } finally {
    findingsSec.removeAttribute("aria-busy");
  }
}

let timer: number | undefined;
function scheduleRun() {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => run(false), 300);
}

const narrow = () => window.matchMedia("(max-width: 959px)").matches;
function revealFindings() {
  if (narrow() && state.result) findingsSec.scrollIntoView({ block: "start" });
}

function loadExample() {
  crontab.value = EXAMPLE;
  zoneInput.value = SAMPLE_ZONE;
  (document.querySelector<HTMLInputElement>("input[name=model][value=vixie]")!).checked = true;
  state.selected = null;
  state.filter = null;
  updateModelHelp();
  run(true);
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  run(true);
  revealFindings();
});
crontab.addEventListener("input", () => {
  state.selected = null;
  scheduleRun();
});
zoneInput.addEventListener("change", () => {
  state.filter = null;
  run(true);
});
document.querySelectorAll<HTMLInputElement>("input[name=model]").forEach((el) =>
  el.addEventListener("change", () => {
    updateModelHelp();
    run(false);
  }),
);
yearsSel.addEventListener("change", () => run(false));

$<HTMLButtonElement>("example").addEventListener("click", () => {
  loadExample();
  revealFindings();
});
$<HTMLButtonElement>("example-empty").addEventListener("click", () => {
  loadExample();
});
$<HTMLButtonElement>("clear").addEventListener("click", () => {
  crontab.value = "";
  state.issues = [];
  resetOutput();
  setFieldError(crontabErr, crontab, null);
  showError(null);
  crontab.focus();
});
$<HTMLButtonElement>("show-all").addEventListener("click", () => {
  state.filter = null;
  renderAll();
  jobsEl.querySelector<HTMLButtonElement>("button[aria-current=true]")?.focus();
});

$<HTMLDivElement>("timeline").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-at]");
  if (!b || !state.result) return;
  const zone = b.dataset.zone!;
  const at = Number(b.dataset.at);
  const same = state.filter && state.filter.zone === zone && state.filter.at === at;
  state.filter = same ? null : { zone, at };
  if (state.filter) {
    const vis = visibleJobs(state.result);
    if (vis.length && !(state.selected?.type === "job" && vis.includes(state.selected.idx))) state.selected = { type: "job", idx: vis[0]! };
  }
  renderAll();
  $<HTMLDivElement>("timeline").querySelector<HTMLButtonElement>(`button[data-at="${at}"][data-zone="${CSS.escape(zone)}"]`)?.focus();
});

jobsEl.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button.job-row");
  if (!b) return;
  state.selected = b.dataset.job !== undefined ? { type: "job", idx: Number(b.dataset.job) } : { type: "issue", idx: Number(b.dataset.issue) };
  jobsEl.querySelectorAll("button.job-row").forEach((x) => x.setAttribute("aria-current", String(x === b)));
  renderInspector();
  applyPositions(inspector);
  if (narrow()) inspector.scrollIntoView({ block: "start" });
});

inspector.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const copyBtn = t.closest<HTMLButtonElement>("button[data-copy]");
  if (copyBtn) {
    navigator.clipboard.writeText(copyBtn.dataset.copy ?? "").then(
      () => {
        copyBtn.textContent = "Copied";
        window.setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
      },
      () => (copyBtn.textContent = "Copy blocked"),
    );
    return;
  }
  const go = t.closest<HTMLButtonElement>("button[data-goto]");
  if (go) {
    const n = Number(go.dataset.goto);
    const lines = crontab.value.split("\n");
    const startPos = lines.slice(0, n - 1).reduce((a, l) => a + l.length + 1, 0);
    crontab.focus();
    crontab.setSelectionRange(startPos, startPos + (lines[n - 1]?.length ?? 0));
  }
});

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    copyStatus.textContent = `${label} copied.`;
  } catch {
    copyStatus.textContent = "Copy was blocked by the browser; use Download CSV instead.";
  }
}
$<HTMLButtonElement>("copy-md").addEventListener("click", () => {
  if (state.result) void copyText(toMarkdown(state.result), `Markdown table (${plural(state.result.findings.length, "row")})`);
});
$<HTMLButtonElement>("download-csv").addEventListener("click", () => {
  if (!state.result) return;
  const blob = new Blob([toCsv(state.result)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "cron-dst-audit.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  copyStatus.textContent = `CSV downloaded (${plural(state.result.findings.length, "row")}).`;
});

fillZones();
zoneInput.value = browserZone();
updateModelHelp();
if (location.hash === "#example") loadExample();
window.addEventListener("hashchange", () => {
  if (location.hash === "#example") loadExample();
});
