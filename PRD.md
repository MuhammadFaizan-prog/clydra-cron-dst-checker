# PRD: Clydara Cron DST Auditor

## 1. Research record (prompt section 4, 2026-10-15)

**User and job.** A developer, sysadmin or SRE who owns a crontab (or Kubernetes CronJobs) running on local time. Job: "before the next clock change, tell me which of my jobs will be skipped, run late or run twice, and how to fix them."

**Evidence the problem occurs.**
- Server Fault: a 01:12 backup ran twice when UK clocks went back on Debian (https://serverfault.com/questions/196622).
- Red Hat solution 477963 exists because admins need to verify cron behaviour across DST (https://access.redhat.com/solutions/477963).
- Kubernetes CronJob with timeZone runs literal wall-clock times, so gap times skip and overlap times repeat (https://github.com/kubernetes/kubernetes/issues/121594).
- Library bugs: node-cron #509 (2026-03-08, jobs stopped after DST; fixed 2026-06), netresearch/go-cron #349 (2026-04-01, duplicate run on fall back), Rundeck/Quartz #6879 (skip on spring forward).
- Healthchecks.io blog explains how Debian cron treats fixed-time vs wildcard jobs differently (https://blog.healthchecks.io/2021/10/how-debian-cron-handles-dst-transitions/).

**Alternatives (public pages, 2026-10-15).**
| Alternative | Does well | Where users still struggle |
|---|---|---|
| crontab.guru | Instant plain-English reading of one expression | No time zone, no DST, one line at a time |
| RunWisp cron checker (https://runwisp.com/cron/) | Explains how different schedulers treat 02:30 on change nights | Its DST guidance (as seen in its public page text) is a general explanation per scheduler, not a per-job audit of a whole crontab over the real future transition dates in a chosen zone |
| Cronitor / Healthchecks monitoring | Alerts after a run is missed or late | Tells you after the fact; needs an account and agent |
| Manual reading of man 8 cron | Authoritative | Needs date maths per zone and per job; easy to get wrong |

**Original value.** Paste a whole crontab (comments, VAR= lines, CRON_TZ=), pick a zone and a scheduler model (Vixie/cronie, literal wall clock e.g. Kubernetes, Quartz-style), and get every real clock change in the next 1 to 3 years from the browser's own tz database, with each job's outcome (skipped, late, twice, once), severity, a suggested rewrite to safe hours, and CSV/Markdown export. Runs fully in the tab.

**Inputs/outputs, edge cases, privacy, cost.** Input: crontab text, zone, model, years. Output: per-job findings, transitions list, export. Edge: invalid lines (listed with line numbers and reason), unknown zones, zones without DST, @macros, day-of-month/day-of-week OR rule, step and range fields, 30-minute shifts (e.g. Lord Howe). Privacy: nothing leaves the browser; command text is never sent anywhere. Cost: static hosting only.

**Buildable today?** Yes, built and verified in this run.

**REA usage (honest record).** REA (rea-agents, MIT) was used in this run only for the HAR tool's capture inspection. It was not used for this tool: the relevant alternatives are public static pages and man pages, so their behaviour was read directly. No competitor code or assets were copied.

## 2. Goal and scope
Goal: a correct, explainable DST audit of a crontab in under a minute.
In scope: crontab parsing, transition finding, three scheduler models, findings, fixes, export.
Non-goals: running jobs, monitoring, systemd timer syntax, Quartz 6/7-field syntax, accounts, storage.

## 3. Acceptance criteria (verified, see Tracker.md)
1. Example crontab produces findings with severity and suggested fixes.
2. Empty input and invalid zone show specific messages; results stay hidden.
3. Invalid cron lines are listed with line numbers and reasons; valid lines still audited.
4. A no-DST zone reports no clock changes and all jobs safe.
5. Changing the scheduler model changes the outcomes as documented.
6. CRON_TZ lines override the zone for following jobs.
7. Copy Markdown and Download CSV produce the displayed results.
8. Keyboard operable, mobile without horizontal overflow, no console errors, no off-origin requests.
9. "Built by Clydara" links to https://www.clydralab.com/ in a new tab; tool name returns to tool home.

## 4. Success measures (post-release, not measured yet)
Audits run per visit, exports, repeat visits, error-message rate, clicks to clydralab.com. Not deployed.
