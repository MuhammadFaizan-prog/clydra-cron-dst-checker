# Security

- Trust boundary: the user's browser only. Crontab text can contain paths and secrets in commands; it never leaves the tab.
- No secrets, no env vars, no server. Strict CSP in production (default-src 'self').
- Input is escaped before rendering (escapeHtml). Large input is processed synchronously; parsing is linear.
- Dependencies are dev-only. Verified: no secrets in source, bundle or history.
- Incidents: none.
