# Ops: who owns what, and what to do when something is down

## Why not two full copies
Two consoles that each do everything means two sets of wallets, drivers and
safety records that drift apart. During an outage the copy that "picks up" is
already out of date, and a wallet balance that is wrong is worse than a page
that is down. So each kind of data has ONE owner. Resilience comes from
backups, a second instance and a paper fallback, not from a second brain.

## One owner per domain
| Domain | System of record | Console |
|---|---|---|
| Trips (every tier), dispatch, driver tiers | Native backend (`rides`, `driver_tier_access`) | ArrivoOps |
| Riders, drivers, vehicles | Native backend (`users`, `drivers`, `vehicles`) | ArrivoOps |
| Wallet, memberships, payments | Native backend (`wallet_transactions`, `memberships`) | ArrivoOps |
| Trip safety, panic alerts, support | Native backend (`safety_events`, rides, tickets) | ArrivoOps |
| Web journeys, KYC documents, inspections | Engine (Supabase) | Engine Ops |
| WhatsApp contacts and chat booking | Engine (Supabase) | Engine Ops |
| Campus wallets and student verification | Engine (Supabase) | Engine Ops |

The engine tables `arrivo_wallets`, `arrivo_drivers`, `arrivo_safety_events`
and `arrivo_promos` overlap the native ones. Do not add features to the
overlapping engine tables. Move each over (or have the engine call the native
API) one domain at a time, wallet first.

## The front door
ArrivoOps is the one place staff start. The menu is grouped by job (Live,
People & fleet, Money, Safety, Platform) and an owner or admin sees an
"Engine Ops" link for the web side. Set `VITE_ENGINE_OPS_URL` in Vercel if the
engine console lives somewhere other than `https://www.ridearrivo.com/ops`.

## If the console or live map is down
1. Ops, while things still work: open Trip Tracker, press "Offline dispatch
   sheet". It saves one HTML page with every live ride, the rider and driver
   names and full phone numbers. Keep it on a phone or print it. Each ride is
   logged as a number view for the audit trail.
2. Dispatch by phone from the sheet. Write changes on paper with the ride
   number and time.
3. Delete the sheet when the outage is over. It holds customer numbers.
4. After recovery, enter the paper changes in the console.

## Health checks and alerts
The backend already answers `/healthz` (is the process up) and `/readyz`
(can it reach the database). Point an external uptime monitor at both, from
outside Render, and send alerts to the Telegram ops channel.

## Backups (owner actions, not code)
- Turn on point-in-time recovery for the database. Test one restore.
- Keep a nightly dump in a different provider's storage.
- Run at least two backend instances so a deploy or a crash does not take
  dispatch offline.
