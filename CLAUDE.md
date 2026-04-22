# AgriEID Weighapp — Project Brief

Last refreshed: 2026-04-22 (v21 work-in-progress).

## What this is

Progressive Web App (PWA) for cattle weighing with Bluetooth scales + EID tag reader. Live in production. Web Bluetooth + Supabase (offline/fallback) + LivestockPro API (primary sync).

## Live + deployment

- **Live URL**: https://ae-weighapp.vercel.app/
- **Hosting**: Vercel (auto-deploys on every push to `main` on GitHub)
- **Vercel Project ID**: `prj_wlgUlSaDnrK4lWdXybagCEG66ByV` (`.vercel/project.json`)
- **Code location**: `/Users/timdickinson/Dropbox/Ai/AgriEID/agrieid-weighapp/`

## Repos

- **GitHub (source of truth for Vercel)**: `byronbeef-hash/ae-weighapp`
- **GitLab (mirror)**: `byronbeef/ae-weighapp`
- **Push setup**: `origin` has BOTH push URLs. One `git push` hits GitHub AND GitLab. Fetch from GitHub only.

```
origin	https://github.com/byronbeef-hash/ae-weighapp.git (fetch)
origin	https://github.com/byronbeef-hash/ae-weighapp.git (push)
origin	git@gitlab.com:byronbeef/ae-weighapp.git (push)
```

## Repo state

- **Branch**: `main`
- **Latest deployed commit**: `ba5bd46` — "Fix LP login: send user_name instead of email field"
- **Local working tree is ~2000 net lines AHEAD of origin** — see "Current local state" below. GitHub/Vercel still serve `ba5bd46`.

## Current local state (uncommitted)

- `APP_VERSION` = **v21** in `index.html` (was v11 at last commit)
- `sw.js` `CACHE_NAME` = `ae-weighapp-v21`
- **Architectural pivot**: LivestockPro is now the primary sync path; Supabase demoted to offline/fallback + auth layer.

### 7 modified core files

| File | Diff | Summary |
|---|---|---|
| `js/app.js` | +1380 / -401 | Switched primary sync Supabase → LivestockPro; removed SPP mode UI; rewired cloud state/UI handlers |
| `styles.css` | +1112 / -401 | Redesign: cloud UI, cloud-login, sync badge, cloud-dropdown, status bar revamp |
| `index.html` | +285 / -0 | Cloud login dropdown, historic sessions, cloud data buttons, status bar with debug toggle, iOS Bluefy hint |
| `js/supabase-sync.js` | +265 / -0 | Auth layer added (login / logout / token mgmt); offline queue refactored |
| `js/scales.js` | +71 / -0 | Decimal-point parsing — distinguishes in-string decimals vs AGU9i `dpBits` encoding |
| `js/livestockpro-sync.js` | +10 / -0 | Strips `Bearer ` prefix on token parse; medical-batch response handling fix |
| `sw.js` | +12 / -0 | Cache version v11 → v21; asset refs updated |

### 6 untracked new files

| File | Size | Purpose |
|---|---|---|
| `demo.html` | 47K | Main interactive product demo / tour |
| `scales-demo.html` | 33K | Bluetooth scales walkthrough |
| `reader-demo.html` | 28K | EID reader walkthrough |
| `scales-test.html` | 20K | Scales dev/testing scratch page |
| `DEMO-BUILD-GUIDE.md` | 17K | Methodology for the demo pages (reusable blueprint) |
| `CLAUDE.md` | — | This file |

## Integrations

### Supabase
- URL hardcoded: `https://ulysnzsvuaakntlsetxg.supabase.co`
- Publishable (anon) key hardcoded in source — no secret leakage.
- No SQL in client code; class wraps the REST API. Offline queue in `localStorage`.
- New in working tree: `AUTH_TOKEN_KEY` + login/token management methods.

### LivestockPro
- Base URL: `https://www.livestockpro.app/api/` (staging: `stage.livestockpro.app`)
- **Auth field is `user_name`** (NOT `email`). Do not regress — see commit `ba5bd46`.
- Token parsing strips `Bearer ` prefix before storage. Do not regress.
- Endpoints in use: `login`, `refresh-token`, `sync-pull`, `sync-push`, `records/check-existence`, `records/facial-recognition`, `subscription-current`, `scanner-session/*`, `medical-batch/sync-pull`.
- Same backend as the AgriEID Lite mobile app.

## Stack

- **Frontend**: Vanilla JS PWA (no framework, no build step). Entry `index.html`, main logic `js/app.js`.
- **Dev server**: `npm start` / `npm run dev` → `http-server` (see `package.json`).
- **Bluetooth**: Web Bluetooth API. Scales = AGU9i indicators (`js/scales.js`). EID reader integrated.
- **Service worker**: `sw.js` (offline + PWA install).
- **PWA manifest**: `manifest.json`, icons in `icons/`.
- **Vercel config**: `vercel.json` — no-cache headers for HTML/JS, must-revalidate for `sw.js` + `reset.html`.

## Key things to know

- Vercel deploys ONLY from GitHub. Don't break the GitHub remote.
- LivestockPro auth uses `user_name`, not `email`.
- LivestockPro token: strip `Bearer ` prefix before storing.
- Web Bluetooth requires HTTPS — Vercel handles it. Local dev: use `localhost`.
- No build step. Edit → push → live.

## Open decisions

- 5 demo files still uncommitted — commit & deploy, host separately, or keep local-only?
- 7 modified core files (the v21 rewrite) still uncommitted — commit as one big release, split, or hold?
- No live testing of the v21 working tree done yet.

## Possible test/work areas

1. LivestockPro login flow (verify `user_name` + `Bearer ` strip still work)
2. Bluetooth scale connection + weight streaming (AGU9i 3T/5T)
3. EID reader scanning + field auto-populate
4. Supabase offline queue drain on reconnect
5. LivestockPro push sync (records reach livestockpro.app)
6. PWA install on iOS / Android
7. Decision on demo files
8. Decision on v21 core-file commit

## Pushing changes

```bash
cd /Users/timdickinson/Dropbox/Ai/AgriEID/agrieid-weighapp
git add <files>
git commit -m "..."
git push    # one push hits GitHub (→ Vercel) and GitLab mirror
```
