-- D1 indexes for MorScan
-- Run: npx wrangler d1 execute morscan --remote --file=./seed/indexes.sql

-- Sessions: the 4 COUNT/SUM queries in handleAll() scan 97k+ rows without this
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(is_active, ends_at);

-- Sessions: wallet lookups (/mor/v1/sessions/:wallet, /mor/v1/wallet/:wallet)
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_address, opened_at DESC);

-- Sessions: pagination ORDER BY opened_at DESC
CREATE INDEX IF NOT EXISTS idx_sessions_opened ON sessions(opened_at DESC);

-- Sessions: refreshProviderStats() runs `WHERE provider=? AND model_id=?` per
-- active pair every sync tick; without this it full-scans the sessions table.
CREATE INDEX IF NOT EXISTS idx_sessions_provider_model ON sessions(provider, model_id);

-- Bids: active/retracted split in handleAll(). ONE index on deleted_at only -
-- this file used to create idx_bids_deleted next to schema.sql's
-- idx_bids_active on the same column, and the duplicate doubled every bid
-- write. On an existing database, drop the duplicate:
--   DROP INDEX IF EXISTS idx_bids_deleted;
CREATE INDEX IF NOT EXISTS idx_bids_active ON bids(deleted_at);

-- Receipt chaining: the per-minute job reads `WHERE chain_root IS NULL ORDER BY
-- timestamp ASC LIMIT 500`; without this partial index that scans every receipt
-- ever written to find the few unchained ones.
CREATE INDEX IF NOT EXISTS idx_provrec_unchained ON provenance_receipts(timestamp) WHERE chain_root IS NULL;
