# Arrivo Backend

Node/Express API for the Arrivo rider app, driver app, admin dashboard, and website. PostgreSQL (Neon in production) via `pg`.

## Run it

```bash
npm install
cp backend-env.example.txt .env   # fill in DATABASE_URL at minimum
npm run dev                        # node --watch server.js
```

`npm start` runs it without watch mode (what production uses).

The schema (`db/schema.sql`) runs automatically on every boot — every statement is `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so it's safe to re-run and there's no separate manual migration step for anything in that file. The three `migration_*.sql` files in the repo root are older, already-applied one-offs — not part of the boot path.

## Structure

- `routes/` — one file per resource (`auth`, `rides`, `drivers`, `admin`, `payments`, `flights`, ...), mounted in `server.js`
- `services/` — business logic shared across routes (fare calculation, wallet, system config)
- `middleware/` — `requireAuth`, `requireRole`, `requireAnyRole`
- `db/` — connection pool + `schema.sql`
- `scripts/` — one-off admin tools, run directly with `node` (see below)

## Key env vars

See `backend-env.example.txt` for the full list with explanations. The essentials: `DATABASE_URL` (Postgres), `JWT_SECRET`, `PAYSTACK_SECRET_KEY` / `PAYSTACK_PUBLIC_KEY`, `AVIATIONSTACK_KEY` (flight lookup).

## Creating an admin account

Public signup only allows `rider` / `driver` / `owner`. Admins are created directly against the database:

```bash
node scripts/create-admin.js "Name" "email@example.com" "password"
```

`scripts/reset-password.js "email" "new-password"` rotates any account's password the same way.

## Deploy

Render, deploying from `main`. Push to `main` (via PR — direct pushes are blocked by branch protection) to ship.
