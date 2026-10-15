# Schema

The tool stores no user data. No database, no localStorage, no cookies, no analytics.
In-memory types: CrontabJob (line, expression, command, timeZone), CronSchedule, Transition (zone, instant, offsets), Finding (job, transition, outcome, severity, fix).
Supabase: no dedicated project created; not needed for a browser-only tool. Retention and deletion: data disappears when the tab is closed.
