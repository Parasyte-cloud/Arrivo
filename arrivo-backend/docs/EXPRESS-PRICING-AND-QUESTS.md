# ArrivoExpress pricing and driver quests: operator guide

Two problems this solves, both from the launch brief:

1. **Price has to work for riders and drivers, and be checked against the
   market every day.** Fares used to be constants in code, so a change meant a
   deploy. They are now a price book you change from the API, with history.
2. **Incentives from day one, without the Uber trap.** Blanket boosts train
   drivers to wait for the next boost and cost whatever volume turns out to be.
   Quests pay for a specific, reliable behaviour (finish N real trips) and have
   a hard cost ceiling.

Everything here is admin only. The `operations` role cannot see or change it.

## The daily routine (about 10 minutes)

1. **Log what the same trip costs elsewhere.** Open Bolt, Uber and inDrive,
   price a few real Lagos routes, and log each one:

   ```
   POST /api/admin/express/samples
   { "tier": "economy", "source": "bolt", "distanceKm": 10, "durationMin": 25,
     "observedFareNaira": 5200, "period": "day", "routeLabel": "Lekki to Ikeja" }
   ```

   `source` is `bolt`, `uber`, `indrive` or `other`. `period` is `day` or
   `night`. The system records what we would have charged for the same distance
   and time, so the comparison stays valid after prices change.

2. **Read the comparison.**

   ```
   GET /api/admin/express/comparison?days=7
   ```

   Per tier you get `above_market`, `in_line`, `below_market` or
   `not_enough_data` (it needs 5 samples), the median ratio of our fare to
   theirs, and a suggested change capped at 20%. It uses the median, so one odd
   screenshot (a surge, a promo code) does not swing it.

3. **Decide, then publish.** The comparison only suggests. A person decides,
   and should also check the driver side: does the new price still leave a
   driver a margin after fuel and maintenance? Then:

   ```
   POST /api/admin/express/prices
   { "tiers": { "economy": { "baseFareNaira": 600, "perKmNaira": 190,
                              "perMinNaira": 25, "minimumFareNaira": 1200 } },
     "effectiveFrom": "2026-10-10T05:00:00Z",
     "note": "Bolt moved up about 5 percent" }
   ```

   Leave out `effectiveFrom` to apply it immediately. A future time (up to 14
   days ahead) lets you set tomorrow's prices tonight. Nothing is overwritten,
   so every fare ever charged traces to the price in force then.

   `GET /api/admin/express/prices` shows what is in force now and
   `GET /api/admin/express/prices/history` shows every change and who made it.

### What stops a typo

- Every number must be a whole amount above zero, and the minimum fare cannot be
  below the base fare.
- A change of more than 25% on any number (setting `INSTANT_PRICE_MAX_CHANGE_PCT`)
  is refused with `PRICE_CHANGE_TOO_LARGE`. If it is genuinely intended, resend
  with `"confirmLargeChange": true` and a note of at least 10 characters.
- Some numbers are too large to ever be right (for example a per-km price above
  NGN 5,000). Those are refused even when confirmed.
- You cannot backdate a price. History is added to, never rewritten.
- A publish covering several tiers is all or nothing.
- If the price book cannot be read, quotes fall back to the defaults in
  `services/instantTiers.js`, so a pricing problem never stops a rider getting a
  fare.

## Driver quests

A quest says: **complete `targetTrips` qualifying trips between `startsAt` and
`endsAt` and earn `rewardNaira`**, for at most `maxWinners` drivers.

```
POST /api/admin/express/quests
{ "title": "Weekend 15", "targetTrips": 15, "rewardNaira": 6000,
  "maxWinners": 100, "startsAt": "2026-10-10T00:00:00Z",
  "endsAt": "2026-10-12T21:00:00Z", "tier": "economy",
  "minDriverRating": 4.5 }
```

The response includes `maxLiabilityNaira`: the most this quest can ever cost
(reward times winners). Creating one above `QUEST_MAX_BUDGET_NAIRA` (default
NGN 2,000,000) is refused, so no single quest can run away.

### What counts as a qualifying trip

- A completed ArrivoExpress ride (not a scheduled booking), inside the window,
  of the quest's tier if it names one.
- The driver actually started the trip.
- At least `minTripKm` (default 1) and `minTripMinutes` (default 3). A tap-in,
  tap-out "trip" does not count.
- At most `maxTripsPerRider` (default 2) trips with the same rider count toward
  one driver's quest, so a driver and a friend cannot ping-pong.
- If the quest sets `minDriverRating`, the driver's rating must meet it when the
  trip completes.

A trip is counted once even if completion is retried. A driver earns a given
quest once. When `maxWinners` is reached, later finishers are not paid and the
quest shows as full to drivers.

### Paying drivers

Nothing here moves money. Completing a quest creates an `owed` record.

```
GET  /api/admin/express/payouts?status=owed
POST /api/admin/express/payouts/:id/paid      after you have paid the driver
GET  /api/admin/express/quests                winners, money owed and paid, per quest
POST /api/admin/express/quests/:id/end        stop counting new trips
```

Ending a quest early keeps everything already earned. Marking a payout paid
twice is harmless.

Drivers read their own progress at `GET /api/instant-rides/driver/quests`.

### Designing quests that work

- Tie the reward to **volume and reliability**, not to a flat per-trip boost.
- Keep them **short** (a day, a weekend) so they feel reachable. Long windows
  are forgotten.
- **Cap the winners.** The cap is how the cost stays known in advance.
- Aim the reward at the hours and tiers you actually need filled, not everywhere
  at once.
- Do not make a quest a permanent part of the pay. If drivers come to expect it,
  it has become a price, and should be handled in the price book instead.
- Check payouts against `driversParticipating` before the next one, to see
  whether a quest changed behaviour or only paid for what would have happened.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `INSTANT_PRICE_MAX_CHANGE_PCT` | 25 | Largest price change allowed without explicit confirmation |
| `QUEST_MAX_BUDGET_NAIRA` | 2000000 | Largest worst-case cost of one quest |

## Automation (both switches are OFF by default)

Turn each on or off in Admin > ArrivoExpress Pricing > Automation. Every
switch change and every automatic action is written to `express_automation_log`
and shown on that screen.

### Automatic payout to the driver wallet

When on, a quest reward is credited to the driver's RideArrivo wallet the
moment it is earned, and a 5 minute sweep retries anything still owed.

- Credited at most once. The payout row is locked while it is paid, so ten
  simultaneous attempts credit exactly one time. Each credit writes a
  `wallet_transactions` row, and the payout stores that row's id.
- Daily ceiling: `QUEST_AUTO_PAYOUT_DAILY_CAP_NAIRA` (default 500,000 per Lagos
  day). Past it, rewards stay "owed" for a person to review; the first time the
  cap is hit each day is logged.
- Admins can credit one reward ("Pay to wallet") or every owed reward ("Pay all
  owed", asks for confirmation) at any time. Manual payments are not counted
  against the cap. "Mark paid" still exists for money sent outside the app.
- Drivers turn the wallet into cash with Cash-out (below).

### Driver cash-out (wallet to bank)

Drivers add one bank account, then withdraw their earnings through Paystack
transfers. Off until `driver_cashout_enabled` is switched on.

- **Account name check.** Paystack looks up the name on the account and it must
  share a name with the driver's profile, so money cannot be sent to a stranger.
- **Cooling-off.** After adding or changing the account, cash-out is blocked for
  24 hours (`CASHOUT_BANK_COOLING_HOURS`), the standard defence against someone
  who has taken over an account and redirects the money.
- **Earnings only.** A driver can withdraw what they were credited (quest
  rewards, admin credits) minus what they already withdrew. Money added by card
  top-up cannot be withdrawn.
- **Limits.** Minimum 1,000, maximum 200,000 per request, 300,000 per day.
  Requests above 100,000 wait for an admin to approve or decline.
- **Debit first.** The wallet is debited in the same database transaction that
  creates the request, under a lock, so racing requests cannot double spend.
- **Never pays twice.** Our reference goes to Paystack, which refuses it a second
  time. A retry or a lost reply is settled by asking Paystack, not by sending again.
- **Money back when it fails.** A failed, declined or reversed transfer credits
  the wallet again, exactly once. A timeout is NOT refunded on a guess: it stays
  queued and a 5 minute sweep retries or verifies.
- **Paystack setup.** Enable Transfers, turn OFF "confirm transfers before
  sending" (otherwise every transfer waits for an OTP), keep the Paystack balance
  funded (a short balance leaves requests queued and visible in admin), and
  point the webhook at `/api/payments/webhook` (it now also handles
  `transfer.success`, `transfer.failed`, `transfer.reversed`).
- Admin: Express Pricing, Cash-outs tab.

### Automatic repricing

When on, once a day after 05:00 Lagos time, each tier is compared with the
competitor samples logged since that tier's last price change. A tier moves
only when every rule holds:

| Rule | Default |
|---|---|
| Enough samples | at least 8 (`AUTO_REPRICE_MIN_SAMPLES`) |
| Independent agreement | at least 2 competitors, each with 2+ samples, all on the same side (`AUTO_REPRICE_MIN_SOURCES`) |
| Cooldown | no automatic change to that tier in the last 24h (`AUTO_REPRICE_COOLDOWN_HOURS`) |
| Small steps | at most 5% per day (`AUTO_REPRICE_MAX_STEP_PCT`) |
| Band | result stays within 70% to 150% of the code default (`AUTO_REPRICE_BAND_MIN_PCT`, `AUTO_REPRICE_BAND_MAX_PCT`) |

Changes are ordinary price book rows whose note starts with `AUTO:`, so they
appear in price history and are reverted by publishing a price by hand. The
admin screen has a "what would it do now" preview and an "apply now" button
that follow the same rules. Several servers running at once cannot double
apply (a daily claim row plus a database lock).

It needs real data: until competitor prices have been logged for the same trips
(see "Logging competitor prices"), every tier simply holds.

## Getting the competitor data (the 10 minute daily check)

There is no legitimate automatic feed of Bolt, Uber or inDrive prices (they have
no public price API, and scraping their apps breaks their terms), so the data is
logged by a person. The Market tab makes that quick:

1. **Today's check** lists 12 standard Lagos trips. Click one, open the other
   app, type the same two places, note the price per tier. Using the same trips
   daily keeps days comparable. Replace the typical distance and time with what
   the other app shows.
2. **Paste many** takes up to 100 lines (`economy, bolt, 12, 30, 5200, day`),
   straight from a spreadsheet. If one line is wrong nothing is saved.
3. **The data panel** says exactly what each tier is still missing (for example
   "5 more samples and 1 more competitor"), so you know when repricing can act.

A realistic routine: 4 trips x 2 apps x 2 tiers is 16 prices, about 10 minutes.
Do it at the same time of day, and once a week at night (log those as `night`).

## Going live checklist

1. Merge the PRs (#63, #65, then the cash-out PR).
2. Paystack dashboard: enable Transfers, turn OFF "confirm transfers before
   sending", add the webhook `https://api.ridearrivo.com/api/payments/webhook`
   (events: charge.success and transfer.success, transfer.failed,
   transfer.reversed), and fund the Paystack balance.
3. Admin > Express Pricing > Automation. Switches are independent and all start
   off. Suggested order: Cash-out first with a small test (a driver cashes out
   the minimum to their own account), then Automatic payout, then Automatic
   repricing only after the Market tab shows every tier as Ready.

## Not built yet

- Translations of the admin app (staff tool, English). The driver app has the
  tabs, Quests, Cash-out and the language picker in 7 languages; the other
  driver screens are still English. Nigerian drivers may be better served by
  Pidgin, Yoruba, Hausa and Igbo than by Hindi or Chinese; those need a native
  speaker, not a machine translation, for the money wording.
- Pickup PIN, selfie check, expiring trip share links and two-way complaints
  (see the safety plan).
