# MyEverythingApp

One personal hub with three sections:

- **Training**: 16-week Ironman 70.3 sample plan (Mon strength, Tue bike, Wed run, Thu strength, Fri swim, Sat long run, Sun brick). Plan counts back from the race date in Settings.
- **To Do**: separate Personal and Work lists with due dates.
- **PekFinance**: monthly income/expenses, categories, net and savings rate. Placeholder until the existing App_Finance project is merged in.

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
