-- BigQuery schema for MorScan - Phase 1 of the D1→BQ tier migration.
--
-- Dataset:  morscan
-- Project:  your-gcp-project
--
-- Apply once, manually, before enabling BQ dual-write in the worker:
--
--   # 1. Create the dataset
--   bq --location=US mk --dataset your-gcp-project:morscan
--
--   # 2. Run this file against BigQuery
--   bq query --use_legacy_sql=false --project_id=your-gcp-project < seed/bq-schema.sql
--
-- Tables are partitioned on `observed_at` (the BQ-side timestamp we set
-- on every row) and clustered on the high-cardinality join columns we
-- expect to filter by. Append-only: no UPDATE, no DELETE. Every sync
-- write is a new row; duplicates are deduped on insertId within the BQ
-- streaming buffer, so repeated writes of the same (id, updated_block)
-- collapse naturally.

CREATE TABLE IF NOT EXISTS `your-gcp-project.morscan.sessions` (
  id               STRING   NOT NULL,
  user_address     STRING   NOT NULL,
  bid_id           STRING,
  provider         STRING,
  model_id         STRING,
  stake            STRING,                -- wei, kept as STRING for precision
  opened_at        TIMESTAMP,
  ends_at          TIMESTAMP,
  closed_at        TIMESTAMP,
  is_active        BOOL,
  updated_block    INT64,
  open_tx_hash     STRING,
  close_tx_hash    STRING,
  observed_at      TIMESTAMP NOT NULL     -- when MorScan wrote this row
)
PARTITION BY DATE(observed_at)
CLUSTER BY user_address, provider, model_id;

CREATE TABLE IF NOT EXISTS `your-gcp-project.morscan.bids` (
  bid_id            STRING   NOT NULL,
  provider          STRING,
  model_id          STRING,
  price_per_second  STRING,               -- wei, STRING for precision
  nonce             INT64,
  created_at        TIMESTAMP,
  deleted_at        TIMESTAMP,
  updated_block     INT64,
  observed_at       TIMESTAMP NOT NULL
)
PARTITION BY DATE(observed_at)
CLUSTER BY provider, model_id;

CREATE TABLE IF NOT EXISTS `your-gcp-project.morscan.economics_history` (
  date                  STRING   NOT NULL,    -- YYYY-MM-DD string from D1
  staking_factor        FLOAT64,
  compute_balance       STRING,
  mor_distributed       STRING,
  total_mor_supply      STRING,               -- v1.31.0: match D1 actual shape
  providers_claimed     STRING,               -- v1.31.0: match D1 actual shape
  observed_at           TIMESTAMP NOT NULL
)
PARTITION BY DATE(observed_at);

-- v1.31.0 additions. Unlocks model-name resolution in the top-models
-- breakdown and "builders added this week" rollups. See the Morpheus
-- Network Pulse analytics rollup (docs/architecture/morpheus-network-pulse.md).

CREATE TABLE IF NOT EXISTS `your-gcp-project.morscan.models` (
  model_id          STRING   NOT NULL,
  name              STRING,
  tags              STRING,
  description       STRING,
  created_at        TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL,
  observed_at       TIMESTAMP NOT NULL
)
PARTITION BY DATE(observed_at)
CLUSTER BY model_id;

CREATE TABLE IF NOT EXISTS `your-gcp-project.morscan.providers` (
  address           STRING   NOT NULL,
  endpoint          STRING,
  stake             STRING,
  created_at        TIMESTAMP,
  updated_block     INT64,
  observed_at       TIMESTAMP NOT NULL
)
PARTITION BY DATE(observed_at)
CLUSTER BY address;

CREATE TABLE IF NOT EXISTS `your-gcp-project.morscan.builder_subnets` (
  subnet_id             STRING   NOT NULL,
  name                  STRING,
  admin                 STRING,
  claim_admin           STRING,
  minimal_deposit       STRING,
  withdraw_lock_period  INT64,
  total_deposited       STRING,
  pending_rewards       STRING,
  staker_count          STRING,
  metadata_name         STRING,
  metadata_description  STRING,
  metadata_url          STRING,
  metadata_logo         STRING,
  chain                 STRING,
  created_at            TIMESTAMP,
  updated_at            TIMESTAMP,
  observed_at           TIMESTAMP NOT NULL
)
PARTITION BY DATE(observed_at)
CLUSTER BY subnet_id;

CREATE TABLE IF NOT EXISTS `your-gcp-project.morscan.builder_stakes` (
  subnet_id         STRING   NOT NULL,
  wallet            STRING   NOT NULL,
  deposited         STRING,
  last_deposit_at   TIMESTAMP,
  unlock_at         TIMESTAMP,
  created_at        TIMESTAMP,
  updated_at        TIMESTAMP,
  observed_at       TIMESTAMP NOT NULL
)
PARTITION BY DATE(observed_at)
CLUSTER BY subnet_id, wallet;

CREATE TABLE IF NOT EXISTS `your-gcp-project.morscan.builder_events` (
  event_type        STRING   NOT NULL,
  subnet_id         STRING   NOT NULL,
  wallet            STRING,
  amount            STRING,
  tx_hash           STRING,
  block_number      INT64,
  block_timestamp   TIMESTAMP,
  log_index         INT64,
  observed_at       TIMESTAMP NOT NULL
)
PARTITION BY DATE(observed_at)
CLUSTER BY subnet_id, event_type;

-- v1.33.0 addition. Per-provider per-model reputation snapshot. D1 side
-- rewrites this table each sync tick via DELETE+INSERT; BQ keeps every
-- observation so Signals can chart "reputation trend over time" without
-- extra bookkeeping. `updated_at` is the D1 computation stamp,
-- `observed_at` is the BQ write stamp.
CREATE TABLE IF NOT EXISTS `your-gcp-project.morscan.provider_stats` (
  provider                  STRING   NOT NULL,
  model_id                  STRING   NOT NULL,
  success_count             INT64,
  dispute_count             INT64,
  early_termination_count   INT64,
  total_sessions            INT64,
  avg_duration_secs         FLOAT64,
  updated_at                TIMESTAMP,
  observed_at               TIMESTAMP NOT NULL
)
PARTITION BY DATE(observed_at)
CLUSTER BY provider, model_id;
