# Techspec

- Stack: Vite 8 + TypeScript 6, no framework, no runtime dependencies. Tests: Vitest. Lint: ESLint + typescript-eslint.
- Architecture: `src/lib/cron.ts` (crontab and field parser), `src/lib/tz.ts` (zone validation and transition search using `Intl.DateTimeFormat`, binary search to the minute), `src/lib/audit.ts` (scheduler models, outcomes, severity, fix suggestions), `src/lib/export.ts` (CSV, Markdown), `src/lib/effects.ts` (effect classification for the UI), `src/ui/shared.ts` (night strips, tags), `src/landing.ts` and `src/tool.ts` (two pages, multi-page Vite build).
- Data flow: textarea → parseCrontab → findTransitions(zone, now, now+years) → audit → render + export. Everything in memory in the tab.
- Integrations: none. No network calls after page load. Supabase: dedicated project NOT created and not used (browser-only, stores no data).
- Production build injects a strict CSP meta tag (vite.config.ts) into both pages. Inline style attributes are blocked by it, so chart positions are set through the CSSOM.
- Deployment (only after owner approval): static hosting, e.g. a separate Vercel project. Not connected to Vercel.
- Tradeoffs: relies on the browser's tz database (current in evergreen browsers); scheduler behaviour is modelled from documented rules, not by running each scheduler.
