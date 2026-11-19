# MyEverythingApp

One personal hub with three sections:

- **Training**: the 26-week Ironman 70.3 plan (2 Nov 2026 to race day 2 May 2027, goal 5:29:30), colour-coded by sport like the printed plan. Week, Full plan and Guide views; tests, strength, fuelling, pacing and a gear checklist.
- **To Do**: separate Personal and Work lists with due dates.
- **PekFinance**: launcher for the separate ThePekFinance app (address set in Settings) plus a monthly budget tracker (income, expenses, categories, savings rate).

## Run locally

```bash
python3 -m http.server 8000
```

Open http://localhost:8000.

## Hosting (stage 1)

Static files only (`index.html`, `manifest.json`, `sw.js`, `icon.svg`). Works on GitHub Pages, Netlify or Cloudflare Pages. It installs as a PWA ("Add to Home Screen") when served over HTTPS.

## Mobile app (stage 2)

Wrap with Capacitor (`npx cap add ios` / `npx cap add android`) to ship to the App Store and Play Store.

## Data

Stored in the browser's localStorage. Use Settings → Export backup to move data between devices. Cloud sync is a later step.

`scripts/build-artifact.sh` builds a body-only copy in `dist/` for previewing as a Claude artifact.
