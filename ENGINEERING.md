# RideArrivo — Engineering README

RideArrivo is a Lagos-based airport pickup and ride-hailing platform, operated by **RICHATHAOIR LIMITED** (CAC RC 1654710). This document exists so anyone joining the project — engineer, designer, or ops — can understand what's built, how the pieces fit together, and where to be careful.

If you're new: read this whole thing once before touching code. Several of the "gotchas" below cost real debugging time before they were understood.

---

## 1. The five repositories

| Repo | What it is | Stack | Hosted on |
|---|---|---|---|
| `ridearrivo-website` | Marketing site + web booking flow + driver/rider web portals | Plain HTML/CSS/JS, no framework or build step | Cloudflare Pages |
| `arrivo-admin` | Internal ops dashboard | React + Vite | Vercel |
| `arrivo-backend` | The API everything talks to | Node/Express + PostgreSQL (Neon) | Render |
| `arrivo-app` | Rider mobile app | Expo/React Native | App Store / Google Play (via EAS Build) |
| `arrivo-driver-app` | Driver mobile app — separate app, separate store listing | Expo/React Native | App Store / Google Play (via EAS Build) |

**Start the backend first.** Every other piece talks to it; nothing else works standalone.

**Website vs. mobile apps are two entirely different codebases with independent feature sets.** A feature built on the website (e.g. the Liquid Glass design system, the driver web-registration flow) does not exist on mobile unless someone separately builds it there. Don't assume parity between them.

---

## 2. Brand & design system

### Colors
Defined as CSS variables in `ridearrivo-website/styles.css`:

- `--ink` (`#12123B`) — main dark navy, used for body text and most UI chrome
- `--title` (`#0C0C10`) — near-black, used *specifically* for headings, kept deliberately distinct from `--ink`
- `--amber` (`#F4A300`) — the brand accent color; CTAs, hover states, highlights
- `--primary` (`#2E4C8C`) — a secondary blue used for some icons/links (mostly superseded by amber for CTAs as of this writing — check current usage before assuming which is "the" blue)
- `--cream` (`#F7F4EC`) — main background
- `--teal` — **deprecated**, fully removed from the codebase; if you see it referenced anywhere, that's stale

The logo/wordmark is always two-tone: **"Ride" in dark navy, "Arrivo" in amber.** This applies to the actual logo image *and* anywhere the brand name renders as text — see `.brand-ride` / `.brand-arrivo` classes in `styles.css`, and the `brand` key in `i18n.js`.

### Liquid Glass design language
The site uses a real implementation of Apple's Liquid Glass material, not generic CSS "frosted glass." The difference matters:

- **Real refraction**, not just blur — an SVG filter (`feTurbulence` + `feDisplacementMap`, defined inline near the top of every page's `<body>`, id `liquid-glass-refraction`) actually warps content behind glass surfaces. Applied via `backdrop-filter: url(#liquid-glass-refraction) blur(...) saturate(...)`.
- **Safari does not support `url()` filters inside `backdrop-filter`.** Every glass element has a `-webkit-backdrop-filter` fallback (blur + saturate only, no refraction) so Safari still gets a good result, just without the warp.
- **A moving specular highlight**, not a static tint — the header has an animated sheen (`glassSheen` keyframe) that drifts across it on a loop, using `background-position` on a fixed-size pseudo-element (not `transform` + `overflow: hidden`, which was tried first and broke dropdown menus that render below the header — see §5).
- **Spring physics, not linear transitions** — buttons and cards use `cubic-bezier(0.34, 1.56, 0.64, 1)` easing with a scale-down on `:active`, giving interactions a bouncy, physical feel. This is applied consistently; if you add a new interactive element, match this curve rather than a plain ease.
- **No color tint on hover.** Real glass doesn't tint when you interact with it, it just catches more light. CTA hover states thin out the fill (more transparent) and brighten the highlight edge — they do not change hue.

If you're building a new glass surface, look at `.btn-primary`, `.card`, `.site-header`, or `.fleet-caption` in `styles.css` as reference implementations before inventing a new pattern.

### Copy style
- **No em dashes (—) in any user-facing text.** This is a hard rule, checked on every change. Code comments are exempt.
- English is the only fully-maintained language. The other six (`fr`, `zh`, `de`, `hi`, `es`, `pt` in `i18n.js`) have not been touched or verified for correctness — don't assume they're accurate, and don't do blind find-and-replace across them without native review.

---

## 3. The i18n system — an important gotcha

`i18n.js` holds a dictionary per language. `script.js`'s `applyLanguage()` finds every element with a `data-i18n="key"` attribute and does `el.innerHTML = dict[key]` **on every page load**, defaulting to English.

**This means the static text sitting in the HTML is only a fallback for when JavaScript fails to load — it is not the source of truth.** If you edit the visible English text in an HTML file but forget to update the matching key in `i18n.js`'s `en` block, your change will render correctly for a split second and then get silently overwritten back to the old text the instant the page's JS runs. This has happened multiple times during this project (the header brand text, the "Five steps" heading) and cost real debugging time each time. **Always grep `i18n.js` for the key you're touching before assuming a text change is complete.**

---

## 4. Website structure (`ridearrivo-website`)

- `index.html` — marketing homepage: hero, safety section, fleet showcase, showcase strip (swipeable image gallery), steps, language/i18n callout, footer
- `book.html` — the booking flow, 5 visible steps (Contact → Flight → Luggage → Pickup → Review & Pay) plus a hidden 6th confirmation step
- `driver.html` — driver login, full multi-step signup/application wizard (Account → Vehicle & License → Photos → Safety & Consent), pending-approval screen, dashboard, earnings, and a "My Profile" page
- `account.html` — rider account: profile photo, emergency SOS panic button, trip history, support links
- Shared: `styles.css` (site-wide), `booking.css` (booking-flow-specific), `script.js`, `booking.js`, `driver.js`, `phone-input.js`, `i18n.js`

**Files referenced everywhere but not present in this repo as far as this documentation's authors have seen: `login.html`, `signup.html`.** If you're reading this and they exist elsewhere, make sure whoever maintains the design system above has a copy, since several known bugs (brand text, most likely input font-sizing) have not been verified fixed there.

### Known mobile gotcha: iOS zoom-on-focus
Any `<input>` with `font-size` under 16px triggers Safari on iOS to auto-zoom the page when the field is focused, which looks like the page "breaking" or jumping out of shape. Every form input on the site is deliberately set to `font-size: 16px` or higher for this reason. If you add a new input and set it smaller for design reasons, you will reintroduce this bug — test on an actual iOS device or simulator, not just desktop Chrome, which doesn't reproduce this behavior.

---

## 5. Backend (`arrivo-backend`)

Node/Express + PostgreSQL via `pg`, connection pooling in `db/db.js`. Schema lives in `db/schema.sql` and is designed to be **safely re-run on every deploy** — every column addition uses `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so migrations apply automatically on startup rather than needing a separate manual migration step.

### Roles
`users.role` can be `rider`, `driver`, `owner`, `admin`, or `support`. `support` is **read-only** — it can view everything in the admin dashboard (riders, drivers, rides, panics) but every mutating route (`verify driver`, `resolve panic`, `edit ride`) independently checks for `admin` specifically via `requireRole("admin")`, layered on top of the router-level `requireAnyRole(["admin", "support"])`. If you add a new admin mutation, you must add this check yourself — it is not automatic. Support accounts are created via `scripts/create-support.js`, not through any public signup endpoint (by design — this should never be reachable over the network).

### Known real gaps (confirmed by reading the actual route code, not assumed)
- **Fare is not distance-based.** `POST /api/rides` accepts `fareNaira` computed client-side as `vehicleBasePrice * multiplier` (vehicle type × booking-type multiplier). It does not use the actual pickup/drop-off route or distance at all. If "bill generated based on the route" is a real requirement, this needs actual distance-matrix integration (Google Maps Distance Matrix API or similar) — it does not currently exist anywhere in this codebase, mobile or web.
- **No wallet system exists.** No balance field on users, no top-up endpoint, no wallet-as-payment-method at checkout.
- **No membership/subscription system exists.** No recurring billing, no corporate/delegate account linking.
- **No real-time paging for panic alerts.** An alert shows up in the admin dashboard, but nothing pages a human (no SMS/push/Slack). Twilio SMS was identified as the simplest path when this was last discussed.
- **Driver location tracking exists for the mobile app** (`PATCH /api/drivers/location`, polled every ~20s) but **not for the website** — a driver using the web dashboard never reports GPS, so their live position won't show correctly to admins or riders.

---

## 6. Admin dashboard (`arrivo-admin`)

React + Vite, pages: Panic Alerts (default landing page — safety-critical, shown first on login), Riders, Drivers, Rides, Live Map, Analytics. Live Map uses Leaflet + OpenStreetMap (not Google Maps — deliberately, to avoid a second API key/billing setup after the trouble getting the website's Google Maps key working).

Click-to-call (`tel:` links) is implemented via a shared `<PhoneLink>` component — reuse it rather than hand-writing `<a href="tel:...">` elsewhere, for consistency.

---

## 7. Testing philosophy

Every change to this codebase should be verified for real before being called done, not just reviewed by eye:
- **Playwright** for browser-level testing: real page loads, real form interactions, computed-style assertions (not just "does it look right" but "does `getComputedStyle` actually report the expected value")
- **Responsive sweeps**: test the actual pixel widths that matter (320, 375, 414, 768, 1024, 1440 at minimum) and check `document.documentElement.scrollWidth` against `clientWidth` to catch horizontal overflow — visually eyeballing one viewport size misses real bugs
- **Real backend testing where possible**: a local Postgres instance + the actual Express server, not a mocked API, for anything touching the database
- **Copyright discipline**: no reproduced song lyrics, no full article text, quotes under 15 words with attribution — applies to anything sourced from the web, not just user-facing product copy

---

## 8. Deployment quick reference

| Project | Where | Why |
|---|---|---|
| `arrivo-backend` | Render | Needs a persistent server process + connection pool; not a fit for serverless/static hosts |
| `ridearrivo-website` | Cloudflare Pages | Domain's already there, DNS connects automatically |
| `arrivo-admin` | Vercel | Standard Vite/React static build |
| `arrivo-app` / `arrivo-driver-app` | EAS Build → App Store / Google Play | Go through app store review, not a web host |

Getting a fresh backend running locally:
```bash
cd arrivo-backend
npm install
cp .env.example .env
# fill in DATABASE_URL, AVIATIONSTACK_KEY, PAYSTACK_SECRET_KEY, PAYSTACK_PUBLIC_KEY, JWT_SECRET
npm start
node scripts/create-admin.js "Your Name" "you@arrivo.app" "a-strong-password"
```

---

## 9. Open items, roughly in priority order

1. **Wallet system** — balance, top-up, pay-from-wallet at checkout, transaction history. Explicitly requested to also support membership billing (see below), so build the wallet first if both are on the roadmap.
2. **Membership plans** — individual annual subscription, corporate delegate accounts (one company account, multiple linked riders). Depends on the wallet existing first.
3. **Real distance-based fare calculation** — see §5. Currently flat-rate regardless of actual route.
4. **Location & currency handling** — detect departure location to determine currency options, explicit location-permission prompt (not assumed), USD as an alternative to Naira, and a fallback for destination input when location permission is declined (destination search currently depends on it).
5. **Security escort & fleet accompaniment** — selectable add-ons at booking time: a personal security escort, and/or a specified number of accompanying vehicles that need to travel the same route in sync with the main car. Both need pricing-engine and dispatch-logic design before implementation, not just a UI checkbox.
6. **Real-time panic paging** (SMS/push/Slack) — see §5.
7. **`login.html` / `signup.html`** — need to be located/provided and checked against the rest of the site's design system and bug fixes.
8. **Mobile app parity** — the design system, safety features, and bug fixes built on the website have not been ported to `arrivo-app` / `arrivo-driver-app` at all.

---

## 10. A note on this document

This README reflects the state of the system as understood through direct collaboration with an AI assistant (Claude) that helped build significant portions of it. Where this document says something is "confirmed" or "verified," it means the actual code was read and, where possible, actually run and tested — not assumed from a spec. Where it says something is "planned" or a "gap," that reflects the current honest state, not a promise about when it'll be built. Keep this document updated as the system changes; a stale README is worse than no README.
