/**
 * Auth route helpers - shared by the console, wallet, sso, and login modules.
 */

import type { Caps } from "../../utils/stake-tier";

export const JSON_NO_STORE = {
	"Content-Type": "application/json",
	"Cache-Control": "no-store",
};

export function walletChallengeMessage(nonce: string): string {
	return `MorScan wallet verification\nnonce: ${nonce}`;
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
