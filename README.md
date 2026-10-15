# Clydara Cron DST Auditor

Know what your crontab does when the clocks change. Paste a crontab, pick the scheduler and its zone, and see which jobs each upcoming daylight saving change skips, delays or runs twice, plus UTC shifts, with evidence per night and a suggested hour where one exists. Runs entirely in your browser.

- `/` landing page (live sample output, how it works, limits, FAQ)
- `/tool.html` workspace (`/tool.html#example` opens the sample)

## Run
```
npm install
npm run dev        # local
npm test           # unit tests
npm run lint && npm run typecheck && npm run build
```
Browser verification: `python3 ../verify/verify_cron.py` (from the tool-studio folder).

Built by Clydara: https://www.clydralab.com/
Private review build. Not deployed.
