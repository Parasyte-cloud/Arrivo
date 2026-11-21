# Cancelled-flight credit: staging check

PArAsYtE | RideArrivo

The credit logic is proven against a real Postgres in `flightCredit.integration.test.js`
(10 tests). What no test can prove is the live chain: provider -> sweep -> wallet -> push,
WhatsApp and email -> Ops tab. Run this once on STAGING before switching it on in production.
Never run it first on production.

## Why it is off by default

`FLIGHT_CANCEL_CREDIT` is unset in production. Credit only happens when it is exactly `on`.
Without it the sweep still tracks flights and Ops can see a cancellation; nothing moves money.

## Steps (staging backend + staging database only)

1. Set on the staging service: `FLIGHT_PNR_KEY` (`openssl rand -base64 32`), `FLIGHT_CANCEL_CREDIT=on`.
   Redeploy. The boot log must NOT print the missing `FLIGHT_PNR_KEY` warning.
2. Create a test rider with a card-funded wallet-eligible ride: book an airport ride whose pinned
   flight date is today, pay by card, so `payment_status = 'paid'`.
3. Make the provider report `cancelled` for that flight. Easiest: use the provider's test flight
   number, or temporarily point the lookup at a stub that returns `cancelled`.
4. Wait for TWO sweeps at least 8 minutes apart (5 minute sweep). The first records `cancelled`; the
   second confirms and credits. One sweep alone must NOT credit. If it does, stop and report.
5. Check, in this order:
   - Rider wallet balance rose by the ride fare, once.
   - Rider got push, WhatsApp and email naming the credit. Driver got a cancellation push.
   - Ops: Flight Issues > Flight credits shows it as Held with the right name and amount.
   - Second sweep did not credit again (wallet unchanged).
6. Repeat with a MEMBERSHIP rider and a FAMILY WALLET rider: no credit, Ops is notified, ride stays `paid`.
7. In Ops, move the credit to another test account. Then spend part of a credit on a second test
   rider and try to move that one: it must be refused ("already spent").
8. Turn `FLIGHT_CANCEL_CREDIT` back off on staging if you want to keep it quiet.

## Verification SQL (staging)

```sql
select c.id, c.ride_id, c.amount_naira, c.status, c.created_at, e.action, e.created_at as event_at
from flight_credits c left join flight_credit_events e on e.credit_id = c.id
order by c.id desc, e.id;

-- exactly one credit per ride (unique ride_id) and ledger agrees
select ride_id, count(*) from flight_credits group by 1 having count(*) > 1;  -- expect 0 rows
```

## Expiry

Credits never expire automatically. That is a legal decision for counsel (consumer-protection and
unclaimed balances), so nothing is forfeited by code. Instead, `FLIGHT_CREDIT_REVIEW_DAYS`
(default 180, 0 turns it off) makes Ops show "Needs a call" on held credits older than that, so a
person contacts the rider.

## Go-live

Only after every step above passes: set `FLIGHT_CANCEL_CREDIT=on` on production.
