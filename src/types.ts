/**
 * MorScan Types
 */

// Workers rate-limiting binding (wrangler [[ratelimits]]); local shape to stay
// compatible with older @cloudflare/workers-types.
export interface RateLimitBinding {
	limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
	RL_STANDARD?: RateLimitBinding; // 100/min pool: per-IP + default keys
	RL_STRICT?: RateLimitBinding; // 30/min pool: low-limit keys
	RL_LOW?: RateLimitBinding; // 10/min pool: legacy throttled keys
	RL_MED?: RateLimitBinding; // 60/min pool: connected-wallet bottom tier (unstaked)
	DB: D1Database;
	DIAMOND_ADDRESS: string;
	RPC_URL: string;
	// Deployment-neutral config (see src/config.ts). All optional with safe
	// defaults so the explorer boots without operator-specific hostnames.
	PUBLIC_BASE_URL?: string; // Explorer origin, e.g. https://morscan.example.com
	LOCK_WORKERS_DEV?: string; // "true" = admin-key-only API on *.workers.dev (no UI). Default: open.
	COMING_SOON_HOSTS?: string; // Comma-separated hostnames that serve the coming-soon page instead of the UI
	// Optional forwarding endpoint for /notify captures. With URL + KEY set, every
	// launch-list email is ALSO forwarded there server-side so an operator
	// CRM/admin surface can show all forms in one place. The local notify_list
	// capture always lands first and stays the source of record; a failed forward never
	// fails the signup.
	INTEREST_FORWARD_URL?: string; // Sink origin, e.g. https://interest.example.com; unset = no forwarding
	INTEREST_FORWARD_KEY?: string; // Submit key sent as X-Interest-Key (wrangler secret)
	INTEREST_FORWARD_PRODUCT?: string; // Product tag on forwarded captures (default "morscan")
	REGISTER_URL?: string; // Signup/upgrade link on the access tier cards (default: /about)
	SSO_APP_KEY?: string; // This app's derived IdP launch key (wrangler secret); unset = IdP sign-in disabled
	SSO_APP_ID?: string; // Audience id for launch tokens (default: morscan)
	SSO_HUB_URL?: string; // IdP hub origin for sign-in bounce; unset = local console fallback
	SSO_LAUNCH_URL?: string; // Full launch URL for the "Sign in with <IdP>" button; unset hides it
	IDP_NAME?: string; // Display name of the IdP on the sign-in button
	MORSCAN_WALLETCONNECT_PROJECT_ID?: string; // WalletConnect Cloud project id for mobile deep-link connect. A REAL 32-char id from cloud.reown.com is needed for the relay to accept pairings.
	SNAPSHOT_PUBLIC_HOST?: string; // Public host fronting the R2 snapshot bucket
	SNAPSHOT_SIGNER_KEY_ID?: string; // Key id advertised in the signed CDN snapshot envelope
	SYNC_COORDINATOR: DurableObjectNamespace;
	MORSCAN_DEMO_KEY: string; // UI serving key, embedded in explorer pages so page scripts can fetch /mor/v1 data (wrangler SECRET; per-IP limits still apply)
	MORSCAN_JWT_SECRET?: string; // UI session HMAC secret (random; wrangler secret). Independent of the mnemonic.
	MORSCAN_MNEMONIC?: string; // BIP39 mnemonic - provenance signing ONLY (morscan/cache, morscan/signer). NOT used for JWT.
	PROVENANCE_ENABLED?: string; // "false" = run unsigned: no receipt fields, /version reports provenance "disabled", the provenance WASM is never initialized. Default (unset/"true") = sign when MORSCAN_MNEMONIC is set.
	RPC_POOL_ENABLED?: string; // "false" = replace the @drm3labs-oss/rpc-pool WASM with a plain-fetch single transport (POST to RPC_URL, simple retry); the pool WASM is never initialized. Default (unset/"true") = use the pool.
	NONCE_CACHE?: KVNamespace; // Workers KV for best-effort nonce dedup (wallet-sig replay defense)
	MORSCAN_CACHE?: KVNamespace; // Workers KV for API response caching (D1 read reduction)
	BUILDER_CONTRACT?: string; // BuildersV4 proxy on Base (builder subnet staking)
	// Optional BigQuery dual-write (off by default)
	BIGQUERY_ENABLED?: string; // "true" to enable; unset = dual-write disabled
	BIGQUERY_PROJECT_ID?: string; // GCP project, e.g. your-gcp-project
	BIGQUERY_DATASET_ID?: string; // e.g. morscan
	BIGQUERY_SERVICE_ACCOUNT_KEY?: string; // base64-encoded JSON key (wrangler secret)
	// R2 bucket for the marketplace CDN snapshot (slim, signed, ~3-min cadence).
	// Optionally fronted by SNAPSHOT_PUBLIC_HOST. Optional so the writer degrades
	// gracefully when the binding is absent.
	SNAPSHOT_BUCKET?: R2Bucket;
	ALCHEMY_FALLBACK_URL?: string; // Alchemy RPC as last-resort fallback (pay-per-CU), used by LIVE sync
	BACKFILL_ALCHEMY_URL?: string; // DEDICATED Alchemy key for historical backfill ONLY, so heavy getLogs never starve the live sync's ALCHEMY_FALLBACK_URL. Preferred by backfill; falls back to ALCHEMY_FALLBACK_URL then public peers.
	// Historical backfill throttle (src/sync/backfill.ts). All optional; the code
	// ships sane defaults tuned for a FREE Alchemy account. Set as wrangler [vars].
	BACKFILL_CHUNK_BLOCKS?: string; // blocks per getLogs chunk (default 2000)
	BACKFILL_DELAY_MS?: string; // delay between chunks in ms (default 250)
	BACKFILL_MAX_CHUNKS_PER_RUN?: string; // hard cap on chunks per HTTP call (default 30)
	// Durable self-driving cron grind (src/index.ts scheduled minute tick). The
	// minute cron pulls MANY backfill windows per tick until one of these budgets
	// is hit, then resumes next tick from the persisted frontier - no external runner.
	BACKFILL_TICK_BUDGET_MS?: string; // wall-clock ms the minute cron grinds windows per tick (default 25000)
	BACKFILL_MAX_BLOCKS_PER_TICK?: string; // safety ceiling on blocks scanned per cron tick (default 50000)
	// Local-only dev escape hatch for exercising wallet-signed requests on
	// localhost without a production signer-attestation row in D1.
	LOCAL_DEV_AUTH_BYPASS?: string | boolean;
	// x402 agent micropayments (src/utils/x402.ts). Keyless calls to metered
	// /mor/v1 endpoints return HTTP 402 with an x402 envelope and accept a signed
	// EIP-3009 USDC (Base) authorization via the X-PAYMENT header. The feature is
	// OFF unless X402_PAY_TO is a valid address.
	X402_PAY_TO?: string; // Owner's self-custodied pay-to address on Base; unset = x402 disabled (keyless stays 401)
	X402_PRICE_USDC?: string; // Price per call in USDC, e.g. "0.01" (default 0.01 = 10000 atomic units)
	X402_FACILITATOR_URL?: string; // Optional x402 facilitator base URL for live verify+settle. Unset/empty (default) = verify-only mode: payments are cryptographically verified and queued in D1 (x402_payments) for later batch settlement.
	// Alerting (all optional; see src/alerts + docs/GETTING_STARTED "Alerting").
	// MorScan records every alert to the D1 `alerts` table / /admin/alerts area
	// regardless of these. Set any subset to also fan out to that channel. Values
	// are secrets - set via `wrangler secret put`, never committed to a toml.
	MORSCAN_ADMIN_KEY_IDS?: string; // Comma-separated api_key ids granted admin (beyond the `admin` row)
	D1_DAILY_READ_BUDGET?: string; // Approx D1 rows-read/day before heavy uncached endpoints shed to 503 (Free-plan backstop; default 4_000_000, under the 5M free limit). See src/utils/d1-budget.ts
	ALERT_SYNC_STALL_SECONDS?: string; // Stall threshold in seconds (default 120)
	ALERT_TELEGRAM_BOT_TOKEN?: string; // @BotFather bot token; needs ALERT_TELEGRAM_CHAT_ID too
	ALERT_TELEGRAM_CHAT_ID?: string; // Target chat/channel id for Telegram alerts
	ALERT_SLACK_WEBHOOK_URL?: string; // Slack Incoming Webhook URL ({ text })
	ALERT_DISCORD_WEBHOOK_URL?: string; // Discord webhook URL ({ content })
	ALERT_WEBHOOK_URL?: string; // Generic webhook; receives full JSON { level, kind, message, ts, host }
}

export interface ApiKey {
	id: string;
	key: string;
	name: string;
	rate_limit: number; // requests per minute
	created_at: number;
	last_used_at: number | null;
}

export interface SyncState {
	lastBlock: number;
	currentBlock: number;
}

export interface ResponseMeta {
	currentBlock: number;
	syncedBlock: number;
	blocksBehind: number;
	timestamp: string;
}

export interface Provider {
	address: string;
	endpoint: string;
	stake: string;
	updated_block: number;
}

export interface Bid {
	bid_id: string;
	provider: string;
	model_id: string;
	model_name: string;
	price_per_second: string;
	updated_block: number;
}

export interface Session {
	id: string;
	wallet: string;
	provider: string;
	model_id: string;
	bid_id: string;
	stake: string;
	opened_at: number;
	ends_at: number;
	closed_at: number;
	closeout_type: number; // 0 = normal, 1 = dispute
	provider_withdrawn: string;
	is_early_termination: boolean; // closedAt < endsAt
	updated_block: number;
}

// Raw provider reputation data - no computed scores, users discern
export interface ProviderReputation {
	provider: string;
	successCount: number;
	disputeCount: number;
	earlyTerminationCount: number;
	totalSessions: number;
	avgTps: number; // Tokens per second
	avgTtftMs: number; // Time to first token
	activeBids: number;
	retractedBids: number;
}

// Event signatures - keccak256 of canonical event signatures
// SessionOpened(address indexed user, bytes32 indexed sessionId, address indexed provider)
// SessionClosed(address indexed user, bytes32 indexed sessionId, address indexed provider)
export const EVENTS = {
	SESSION_OPENED: "0x2bd7c890baf595977d256a6e784512c873ac58ba612b4895dbb7f784bfbf4839",
	SESSION_CLOSED: "0x337fbb0a41a596db800dc836595a57815f967185e3596615c646f2455ac3914a",
	// Bid events - track ALL bids ever created, including deleted ones.
	// MarketplaceBidPosted(address indexed provider, bytes32 indexed modelId, uint256 nonce)
	BID_POSTED: "0xfc422bb61cd73bc76f27eecf69cce3db0b05d39769ca3ed0fb314a3d04bff6f6",
	// MarketplaceBidDeleted(address indexed provider, bytes32 indexed modelId, uint256 nonce)
	BID_RETRACTED: "0x409dfc0f98bf6e062e576fbdc63c9f82392d44deff61e3412f8bd256d2814883",
	// Transfer(address indexed from, address indexed to, uint256 indexed value)
	// Standard ERC-20/ERC-721 Transfer topic - used for MOR token holder tracking.
	ERC721_TRANSFER: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
	// Builder staking events (BuildersV4 contract)
	BUILDER_USER_DEPOSITED:
		"0x6c7131e79092f16af04daf787c07a4dc80e7ae1a95dbe1cc1a310cfe1619d2db",
	BUILDER_USER_WITHDRAWN:
		"0x91ce5144c91c77840ff78678c0787f033a9f2209ab6a26552adb61a542da4a0d",
	BUILDER_ADMIN_CLAIMED:
		"0x58d15e553aa98ead90f5b344d27c2f59995b8447dadb1662db257cd54c803f00",
	BUILDER_SUBNET_CREATED:
		"0xfc07de8ee911254a9185d74d8ab20269af3f3b3fe9743d1c225ee77570076742",
	BUILDER_SUBNET_EDITED:
		"0xb402427f9b01bc42bf0a4aea082dc07170860b80964a12318abf7e480a0a4ee0",
	BUILDER_FEE_PAID: "0x2b8c2cd90c9e1dd66b27c2ad1828da3954f9f616cb655dc4b214671e1acb9ac5",
	// EIP-2535 Diamond upgrade - emitted on every facetCut (add/replace/remove selectors)
	// DiamondCut((address,uint8,bytes4[])[],address,bytes)
	DIAMOND_CUT: "0x8faa70878671ccd212d20771b795c50af8fd3ff6cf27f4bde57e5d4de0aeb673",
};
