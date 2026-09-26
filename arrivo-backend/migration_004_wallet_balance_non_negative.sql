-- Prevents users.wallet_balance_naira and family_plans.wallet_balance_naira
-- from ever going negative at the database level -- a last-line-of-defense
-- guard, not a replacement for the application-level balance checks that
-- already run before every debit (see routes/wallet.js, routes/rides.js,
-- routes/family.js). Run manually, same as migration_001/002/003 -- there is
-- no migration runner in this repo.
ALTER TABLE users ADD CONSTRAINT wallet_balance_non_negative CHECK (wallet_balance_naira >= 0);
ALTER TABLE family_plans ADD CONSTRAINT family_wallet_balance_non_negative CHECK (wallet_balance_naira >= 0);
