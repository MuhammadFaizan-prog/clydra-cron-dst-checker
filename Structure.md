# Structure

```
index.html             landing page (/)
tool.html              workspace (/tool.html)
public/                clydara-logo.png
src/landing.ts         landing: live preview, sample matrix, scheduler table, mobile menu
src/tool.ts            workspace: validation, run, summary, timeline, job list, inspector, exports
src/ui/shared.ts       sample crontab, effect labels/tags, night-strip renderer, CSP-safe positioning
src/styles/base.css    tokens (warm white / charcoal / amber), buttons, tags, night strip
src/styles/landing.css landing layout
src/styles/tool.css    workspace layout
src/lib/cron.ts        crontab + cron field parser            (unchanged)
src/lib/tz.ts          zone validation, transitions, formatting (unchanged)
src/lib/audit.ts       scheduler models, outcomes, severity, fixes (unchanged)
src/lib/export.ts      CSV and Markdown export                 (unchanged)
src/lib/effects.ts     effect classification, UTC periods, suggestion explanation (new, pure)
tests/                 Vitest suites (cron, audit, effects)
vite.config.ts         multi-page build (index + tool) + CSP meta injection
```
