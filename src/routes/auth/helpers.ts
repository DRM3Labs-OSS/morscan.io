/**
 * Auth route helpers - shared by the console, wallet, sso, and login modules.
 */

import type { Caps } from "../../utils/stake-tier";
import { toChecksumAddress } from "../../utils/crypto";

export const JSON_NO_STORE = {
	"Content-Type": "application/json",
	"Cache-Control": "no-store",
};

/** The chain the sign-in message names: Base mainnet, where the MOR stakes live. */
export const WALLET_SIGNIN_CHAIN_ID = 8453;
/** A minted challenge is good for this long (KV TTL and the message's Expiration Time). */
export const WALLET_CHALLENGE_TTL_SECS = 300;

/** What a minted challenge binds: one host, one wallet, one nonce, one moment. */
export interface WalletChallenge {
	/** The host that minted it (the request's Host), e.g. "morscan.io". */
	domain: string;
	/** The sign-in URI, e.g. "https://morscan.io/console". */
	uri: string;
	/** The wallet the challenge was minted for (lowercase 0x address). */
	address: string;
	/** 32 hex chars, single use. */
	nonce: string;
	/** ISO 8601 mint time. */
	issuedAt: string;
}

/**
 * The EIP-4361 (Sign-In with Ethereum) message the wallet signs. It names the
 * host, the URI, the chain, the wallet, a single-use nonce and a 5-minute
 * window, so a wallet that parses it warns when the requesting site is not that
 * host, and a signature collected on another site cannot be relayed here: the
 * server rebuilds this exact text from the values it stored at mint time and
 * the recovered signer must be the wallet it was minted for.
 */
export function walletChallengeMessage(c: WalletChallenge): string {
	const expiresAt = new Date(
		Date.parse(c.issuedAt) + WALLET_CHALLENGE_TTL_SECS * 1000,
	).toISOString();
	return [
		`${c.domain} wants you to sign in with your Ethereum account:`,
		toChecksumAddress(c.address),
		"",
		"MorScan wallet verification. Signing proves you hold this wallet; it sends no transaction and costs nothing.",
		"",
		`URI: ${c.uri}`,
		"Version: 1",
		`Chain ID: ${WALLET_SIGNIN_CHAIN_ID}`,
		`Nonce: ${c.nonce}`,
		`Issued At: ${c.issuedAt}`,
		`Expiration Time: ${expiresAt}`,
	].join("\n");
}

export function shortAddr(addr: string): string {
	return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function fmtCap(n: number): string {
	return n.toLocaleString("en-US");
}

export function capsLine(caps: Caps): string {
	return `${fmtCap(caps.burst)}/min &middot; ${fmtCap(caps.daily)}/day &middot; ${fmtCap(caps.monthly)}/mo`;
}

/**
 * Same-origin gate for the cookie-authenticated sign-in and key POSTs
 * (/console/*, /login). The session cookie is SameSite=Lax, which stops a
 * cross-site form but not a sibling host on the same site (any *.morscan.io),
 * so a POST must also prove it came from this origin. A browser always sends
 * Sec-Fetch-Site (modern) or Origin (every browser on a POST); either one is
 * checked when present, and a request that carries a value other than this
 * origin is refused. A request with neither header is a non-browser caller
 * (curl, an agent), which never holds a victim's cookie, so it passes.
 * Returns true when the request may proceed.
 */
export function isSameOriginPost(request: Request, url: URL): boolean {
	const site = request.headers.get("Sec-Fetch-Site");
	if (site !== null) return site === "same-origin";
	const origin = request.headers.get("Origin");
	if (origin !== null) return origin === url.origin;
	return true;
}
