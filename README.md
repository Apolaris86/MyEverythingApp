# MyEverythingApp

One personal hub with three sections:

- **Training**: the 26-week Ironman 70.3 plan (2 Nov 2026 to race day 2 May 2027, goal 5:29:30), colour-coded by sport like the printed plan. Week, Full plan and Guide views; tests, strength, fuelling, pacing and a gear checklist.
- **Today**: today's session, calendar, to-dos, portfolio 1D/YTD change with top movers, and news headlines.
- **To Do**: separate Personal and Work lists with due dates.
- **PekFinance**: investment portfolio tracker styled after ThePekFinance (one investment portfolio, 37 holdings, USD/AUD, period gains, value-over-time chart, sortable holdings, allocation). Prices come from MyEverythingApp's own price relay in `worker/` (a Cloudflare Worker over Yahoo Finance: quotes, histories, FX), set as the price source address in Settings, plus an optional Finnhub key for real-time US trades. Without a source it shows the prices from the 18 Nov screenshot.

## Run locally

```bash
python3 -m http.server 8000
```

Open http://localhost:8000.

## Hosting (stage 1)

Static files only (`index.html`, `manifest.json`, `sw.js`, `icon.svg`). Works on GitHub Pages, Netlify or Cloudflare Pages. It installs as a PWA ("Add to Home Screen") when served over HTTPS.

## Mobile app (stage 2)

Wrap with Capacitor (`npx cap add ios` / `npx cap add android`) to ship to the App Store and Play Store.

## Data and sync

Every change is saved in the browser first, so the app works offline. Signed in (Settings → Account & sync), to-dos, training ticks, gear, the portfolio and settings sync to Supabase (`app_docs` table, one row per document, Row Level Security so each user sees only their own rows). A device signing in for the first time takes the cloud copy; after that the newest change wins. The Finnhub key never leaves the device.

Set up once: run `supabase/schema.sql` in the Supabase SQL editor, set Auth → URL Configuration → Site URL to `https://apolaris86.github.io/MyEverythingApp/`, create your account in the app, then turn off new sign-ups.

`scripts/build-artifact.sh` builds a body-only copy in `dist/` for previewing as a Claude artifact.

## Relay (`worker/`)

Cloudflare Worker that returns data with CORS for `https://apolaris86.github.io`:

- `/api/quotes`, `/api/histories`, `/api/fx`: Yahoo Finance prices, history and FX
- `/api/news`: top Google News headlines for World, Australia, Hungary, Finance and Technology
- `/api/calendar`: today's events from a Google Calendar secret iCal address (only `calendar.google.com` addresses; never cached)

```bash
cd worker
npm install
npx wrangler login
npx wrangler deploy
```

Deployed at `https://myeverythingapp-prices.peknorbert.workers.dev`, which the app uses by default (Settings → Price source address).
