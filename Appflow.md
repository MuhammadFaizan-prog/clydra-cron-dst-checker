# Appflow (redesign 2026-10-15)

Two pages, both directly reachable:

**Landing `/`** — nav (Example, How it works, Privacy & limits, FAQ, Built by Clydara, Open the auditor; collapses to a Menu button under 900px).
1. Hero: outcome headline, primary "Open the auditor" (`/tool.html`), secondary "Run the sample crontab" (`/tool.html#example`). Live preview: night strips for the sample crontab's next fall-back and spring-forward nights in America/New_York, computed in the browser with audit(); a Linux cron / Kubernetes / Quartz switch recomputes it.
2. What you get back (`#example`): jobs × clock-changes matrix per zone (real output, Linux cron) and three explained details; sample crontab in a disclosure.
3. How it works (`#how`): three steps, gap/overlap defined, scheduler table generated from outcomeFor() with source links.
4. Where it helps: three concrete cases (input, result, your call).
5. Privacy and limits (`#limits`), FAQ (`#faq`), footer CTA + Built by Clydara.

**Workspace `/tool.html`** — Input → Settings → Findings → Inspect → Export.
- Left pane: crontab editor (Load sample, Clear, parse summary), Scheduler radio group with documented rule + source, zone (defaults to browser zone), horizon, Check schedules (also re-checks live on input/setting change).
- Right pane: Findings header (period, model) with Copy Markdown / Download CSV; summary of jobs per effect (skipped, runs twice, runs late, runs once, UTC shift, no effect, not checked) + glossary; clock-change timeline per zone (markers filter the job list; Show all jobs resets); job list + inspector (field chips, zone, scheduler, evidence per night with night strip, UTC timing table, suggested schedule with explanation and copy).
- `#example` in the URL loads and checks the sample.
States: first visit/empty state, sample, valid, invalid zone (field error), empty input (field error), only invalid lines (field error with line + reason), partial (Not checked rows, select line in editor), no-DST zone, processing (status, aria-busy), copy/download feedback, clear, mobile (stacked; timeline becomes a list; selecting a job scrolls to its evidence).
Navigation: tool name → `/`; "Built by Clydara" (header + footer, both pages) → https://www.clydralab.com/ in a new tab (noopener).
