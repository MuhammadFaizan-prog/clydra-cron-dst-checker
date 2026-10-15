// Shared UI helpers for the landing page and the workspace.
import type { Outcome } from "../lib/audit";
import type { Effect } from "../lib/effects";
import { fmtDate, fmtDelta, fmtTime, type Transition, type WallClock } from "../lib/tz";

export const SAMPLE_ZONE = "America/New_York";

export const EXAMPLE = `# Example production crontab (server clock: America/New_York)
MAILTO=ops@example.com
30 2 * * *    /usr/local/bin/db-backup.sh
30 1 * * *    /usr/local/bin/send-invoices.sh
0 9 * * 1-5   /usr/local/bin/standup-reminder.sh
*/15 * * * *  /usr/local/bin/sync-inventory.sh
CRON_TZ=America/Santiago
@daily        /opt/reports/daily-sales.sh
`;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export interface EffectMeta {
  label: string;
  short: string;
  mark: string;
  desc: string;
}

export const EFFECT_META: Record<Effect | "unsupported", EffectMeta> = {
  skipped: {
    label: "Skipped run",
    short: "Skipped",
    mark: "✕",
    desc: "The scheduled local time doesn't exist that night and the scheduler doesn't run it.",
  },
  repeated: {
    label: "Repeated run",
    short: "Runs twice",
    mark: "×2",
    desc: "The scheduled local time happens twice when clocks go back, and the scheduler runs it both times.",
  },
  delayed: {
    label: "Delayed run",
    short: "Runs late",
    mark: "→",
    desc: "The scheduled time doesn't exist; the scheduler runs the job right after the jump instead.",
  },
  handled: {
    label: "Repeated hour, runs once",
    short: "Runs once",
    mark: "1×",
    desc: "The time happens twice but this scheduler runs it only once. Shown so you know it was checked.",
  },
  utc: {
    label: "UTC time changes",
    short: "UTC shift",
    mark: "±",
    desc: "Same local time, but after each change the run happens at a different UTC time. It matters when other systems, logs or people work in UTC or another zone.",
  },
  none: {
    label: "No effect detected",
    short: "No effect",
    mark: "–",
    desc: "Never lands in a missing or repeated hour, and its UTC time doesn't move, in the checked period.",
  },
  unsupported: {
    label: "Not checked",
    short: "Not checked",
    mark: "?",
    desc: "A line the auditor couldn't read as a 5-field cron schedule. It was left out of every finding.",
  },
};

export const OUTCOME_EFFECT: Record<Outcome, Effect> = { skipped: "skipped", twice: "repeated", late: "delayed", once: "handled" };

export function effectTag(e: Effect | "unsupported", text?: string): string {
  const m = EFFECT_META[e];
  return `<span class="tag tag-${e}"><span class="tag-mark" aria-hidden="true">${m.mark}</span>${escapeHtml(text ?? m.short)}</span>`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function shortDate(w: Pick<WallClock, "y" | "mon" | "d">, withYear = true): string {
  return `${MONTHS[w.mon - 1]} ${w.d}${withYear ? ` ${w.y}` : ""}`;
}

/** Date of the night a transition affects (gap: before; overlap: after). */
export function nightOf(t: Transition): WallClock {
  return t.delta > 0 ? t.localBefore : t.localAfter;
}

export function transitionHeadline(t: Transition): string {
  const dir = t.delta > 0 ? "forward" : "back";
  const names = t.nameBefore && t.nameAfter && t.nameBefore !== t.nameAfter ? ` (${t.nameBefore} → ${t.nameAfter})` : "";
  return `Clocks ${dir} ${fmtDelta(t.delta)}: ${fmtTime(t.localBefore)} → ${fmtTime(t.localAfter)}${names}`;
}

function naive(w: WallClock): number {
  return Date.UTC(w.y, w.mon - 1, w.d, w.h, w.mi);
}

export interface NightLane {
  label: string;
  sublabel?: string;
  times: WallClock[];
  outcome: Outcome;
  fixed: boolean;
}

const OUTCOME_TEXT: Record<Outcome, (t: Transition) => string> = {
  skipped: () => "skipped",
  late: (t) => `runs ${fmtTime(t.localAfter)}`,
  twice: () => "runs twice",
  once: () => "runs once",
};

/**
 * A readable picture of one clock-change night: an hour axis, the missing or
 * repeated window shaded, and one lane per affected job with its real run times.
 */
export function renderNight(t: Transition, lanes: NightLane[], opts: { heading?: boolean } = {}): string {
  const gap = t.delta > 0;
  const affStart = gap ? naive(t.localBefore) : naive(t.localAfter);
  const len = Math.abs(t.delta) * 60_000;
  const H = 3_600_000;
  const from = Math.floor((affStart - H) / H) * H;
  const to = Math.ceil((affStart + len + H) / H) * H;
  const pct = (ms: number) => ((ms - from) / (to - from)) * 100;
  const ticks: string[] = [];
  for (let ms = from; ms <= to; ms += H) {
    const d = new Date(ms);
    const lbl = fmtTime({ h: d.getUTCHours(), mi: 0 });
    const edge = ms === from ? " tick-first" : ms + H > to ? " tick-last" : "";
    ticks.push(`<span class="tick${edge}" data-l="${pct(ms).toFixed(3)}">${lbl}</span>`);
  }
  const endLocal = new Date(affStart + len - 60_000);
  const winText = `${fmtTime(gap ? t.localBefore : t.localAfter)}–${fmtTime({ h: endLocal.getUTCHours(), mi: endLocal.getUTCMinutes() })}`;
  const band = `<span class="band ${gap ? "band-gap" : "band-overlap"}" data-l="${pct(affStart).toFixed(3)}" data-w="${(pct(affStart + len) - pct(affStart)).toFixed(3)}"></span>`;
  const rows = lanes
    .map((l) => {
      const shown = l.times.slice(0, 12);
      const marks = shown
        .map((w) => `<span class="mk mk-${l.outcome}" data-l="${pct(naive(w)).toFixed(3)}"></span>`)
        .join("");
      let extra = "";
      if (l.outcome === "late" && l.fixed && shown[0]) {
        const a = pct(naive(shown[0]));
        const b = pct(affStart + len);
        extra = `<span class="late-arrow" data-l="${a.toFixed(3)}" data-w="${(b - a).toFixed(3)}"></span><span class="mk mk-ran" data-l="${b.toFixed(3)}"></span>`;
      }
      const sr = `${l.label}: ${shown.map(fmtTime).join(", ")} ${OUTCOME_TEXT[l.outcome](t)}`;
      return `<div class="nl"><code>${escapeHtml(l.label)}</code>${l.sublabel ? `<span>${escapeHtml(l.sublabel)}</span>` : ""}</div>
        <div class="nt" role="img" aria-label="${escapeHtml(sr)}">${band}${marks}${extra}</div>
        <div class="no no-${l.outcome}">${escapeHtml(OUTCOME_TEXT[l.outcome](t))}</div>`;
    })
    .join("");
  const head = opts.heading === false ? "" : `<figcaption><b>${shortDate(nightOf(t))}</b> <span>${escapeHtml(transitionHeadline(t))}</span></figcaption>`;
  return `<figure class="night ${gap ? "is-gap" : "is-overlap"}">
    ${head}
    <div class="night-grid">
      <div class="nl nl-head">Local time</div>
      <div class="nt nt-axis" aria-hidden="true">${band}${ticks.join("")}<span class="band-label" data-l="${pct(affStart).toFixed(3)}">${gap ? `${winText} doesn't exist` : `${winText} happens twice`}</span></div>
      <div class="no"></div>
      ${rows}
    </div>
  </figure>`;
}

/**
 * The page's CSP forbids inline style attributes, so positions travel as
 * data-l / data-w (percent) and are applied through the CSSOM after rendering.
 */
export function applyPositions(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>("[data-l]").forEach((el) => {
    el.style.left = `${el.dataset.l}%`;
    if (el.dataset.w !== undefined) el.style.width = `${el.dataset.w}%`;
  });
}

export function fmtDay(w: WallClock): string {
  return fmtDate(w);
}
