# RideArrivo

Lagos airport pickup and ride-hailing platform, operated by RICHATHAOIR LIMITED (RC 1654710). Built for Nigerians, Google Maps under the hood.

Full engineering details (brand system, cross-app gotchas, history): see `ENGINEERING.md`.

## The workspaces here

| Path | What it is | Stack | Hosted on |
|---|---|---|---|
| `arrivo-backend` | The API everything talks to | Node/Express + PostgreSQL (Neon) | Render |
| `arrivo-admin` | Internal ops dashboard | React + Vite | Vercel |
| `arrivo-app` | Rider mobile app | Expo / React Native | App Store / Google Play |
| `arrivo-driver-app` | Driver mobile app (separate app + listing from the rider app) | Expo / React Native | App Store / Google Play |

Two related workspaces live in separate repos, not here:

- **arrivo-website** — marketing site + web booking (`ridearrivo.com`), Cloudflare Pages.
- **RA-workspace** — internal ops tool (Support, CRM, Finance, HR, etc.), separate from this rider/driver product.

## Start here

1. `arrivo-backend` first. Nothing else works standalone.
2. Then whichever of `arrivo-admin` / `arrivo-app` / `arrivo-driver-app` you're working on. Each has its own README with setup steps.

Website and mobile apps are separate codebases with independent feature sets. Don't assume a feature on one exists on the other.
