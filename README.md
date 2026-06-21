# ZINN Shared Modules

Shared infrastructure modules for ZINN Railway services. Used by all services at build time via git clone.

## Modules

- **ai.js** — AI caller (DeepSeek/OpenAI)
- **config.js** — Board IDs, API keys, path constants
- **data.js** — Template helpers, HTML escaping
- **db.js** — Postgres connection pool
- **dropbox.js** — File operations via Dropbox API
- **email.js** — Gmail API, branded HTML drafting
- **esign.js** — E-signature UI builder
- **harvest.js** — Harvest API client
- **health-check.js** — Railway service health pings
- **notify.js** — Centralized error notification
- **pdf.js** — Puppeteer PDF generation
- **railway.js** — Railway CLI wrapper
- **team.js** — Team roster
- **trello.js** — Trello API operations

## Publishing

Run `publish.sh` to push latest changes to GitHub.
